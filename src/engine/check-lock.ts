/**
 * The checks that compare palm.yaml, the lock and the sources (DESIGN §6 "Check"):
 * `manifest-lock`, `local-sources` and `sources-declared`.
 */
import { existsSync } from 'node:fs';
import { short } from '../core/hash.js';
import type { CheckProblem, CheckRun, LockEntry, LockSource } from '../core/types.js';
import { lockId, Via } from '../domain/entity-key.js';
import { sameName } from '../domain/entity-ref.js';
import { type CheckContext, checkRun, count, entityOf, type Found, found } from './check-kit.js';
import { palmCommand } from './report.js';
import { MANIFEST_SOURCE } from './sources.js';

function install(c: CheckContext, extra?: string): string {
  return palmCommand('install', [], c.run.state.paths.scope, extra);
}

function problem(message: string, fix: string, e?: LockEntry): CheckProblem {
  return e ? { entity: entityOf(e), message, fix } : { message, fix };
}

/** A plugin entry's `only`/`exclude` items that name no member the plugin declares. */
function strayFilters(
  c: CheckContext,
  entry: { source: string; name: string; items: string[] },
  f: Found,
) {
  const { source, name, items } = entry;
  const plugin = c.run.state.lock.find({ kind: 'plugin', name }, source);
  if (!plugin) return;
  const members = new Set((plugin.deps ?? []).map((d) => `${d.kind}:${d.name}`.toLowerCase()));
  for (const item of items)
    if (!members.has(item.toLowerCase()))
      f.fail.push(
        problem(
          `plugin ${name}: ${item} names no member of the plugin`,
          `edit palm.yaml: remove ${item} from plugin ${name}`,
          plugin,
        ),
      );
}

/** Every palm.yaml entry (and `mcp:` server) has a lock entry; plugin filters name members. */
function manifestSide(c: CheckContext, f: Found): void {
  const { manifest, lock } = c.run.state;
  for (const { source, kind, entry } of manifest.allEntries()) {
    const message = `${kind} ${entry.name} is in palm.yaml but not in palm.lock.yaml`;
    if (!lock.find({ kind, name: entry.name }, source)) f.fail.push(problem(message, install(c)));
    else if (kind === 'plugin')
      strayFilters(
        c,
        { source, name: entry.name, items: [...(entry.only ?? []), ...(entry.exclude ?? [])] },
        f,
      );
  }
  for (const name of Object.keys(manifest.mcp))
    if (!lock.find({ kind: 'mcp', name }, MANIFEST_SOURCE))
      f.fail.push(problem(`mcp ${name} is in palm.yaml but not in palm.lock.yaml`, install(c)));
}

function listedInManifest(c: CheckContext, e: LockEntry): boolean {
  const { manifest, lock } = c.run.state;
  if (e.source === MANIFEST_SOURCE) return !!manifest.mcp[e.name];
  if (e.via) return !!lock.find({ kind: 'plugin', name: Via.parse(e.via).name }, e.source);
  return manifest.hasEntry(e.source, e.kind, e.name);
}

/** Every lock entry is in palm.yaml and names a locked source. */
function entrySide(c: CheckContext, f: Found): void {
  const { lock } = c.run.state;
  for (const e of lock.entries) {
    if (!listedInManifest(c, e))
      f.fail.push(
        problem(`${e.kind} ${e.name} is in palm.lock.yaml but not in palm.yaml`, install(c), e),
      );
    if (e.source !== MANIFEST_SOURCE && !lock.source(e.source))
      f.fail.push(
        problem(
          `source ${e.source} of ${e.kind} ${e.name} is missing from palm.lock.yaml`,
          install(c),
          e,
        ),
      );
  }
}

/** What a lock source lacks to be rebuilt anywhere: a git sha, or a url or path. */
function lacking(ls: LockSource): string | undefined {
  if (ls.url) return ls.sha ? undefined : 'sha';
  return ls.path === undefined ? 'url or path' : undefined;
}

/** Sources agree on refs and the lock carries what rebuilds them. */
function sourceSide(c: CheckContext, f: Found): void {
  const { lock, sources } = c.run.state;
  for (const ref of sources.all()) {
    const ls = lock.source(ref.name);
    if (!ls || ref.isLocal || ls.ref === ref.source.ref) continue;
    const refs = `ref ${ref.source.ref ?? '(none)'} in palm.yaml, ${ls.ref ?? '(none)'} in palm.lock.yaml`;
    f.fail.push(problem(`source ${ref.name}: ${refs}`, install(c)));
  }
  for (const [name, ls] of Object.entries(lock.sources)) {
    const lacks = lacking(ls);
    if (lacks) f.fail.push(problem(`source ${name} in palm.lock.yaml lacks ${lacks}`, install(c)));
  }
}

/**
 * K3: an installed agent that preloads a skill (`skills:` in its frontmatter) nobody installed
 * gets a warning naming the install command; palm installs nothing on its own (PLAN §6).
 */
export function preloads(c: CheckContext): CheckRun {
  const f = found();
  const { lock, paths } = c.run.state;
  const has = (name: string) =>
    lock.entries.some((x) => x.kind === 'skill' && !x.declined && sameName(x.name, name));
  for (const e of lock.entries) {
    const entity = e.kind === 'agent' ? c.renders.get(lockId(e))?.entity : undefined;
    if (entity?.def.kind !== 'agent') continue;
    for (const skill of entity.def.agent.skills ?? [])
      if (!has(skill))
        f.warn.push(
          problem(
            `agent ${e.name} preloads skill ${skill}, not installed`,
            palmCommand('install', [e.source, skill], paths.scope),
            e,
          ),
        );
  }
  return checkRun(
    'preloads',
    {
      ok: 'every skill an agent preloads is installed',
      bad: (n) => `${count(n, 'preloaded skill')} not installed`,
    },
    f,
  );
}

export function manifestLock(c: CheckContext): CheckRun {
  const f = found();
  manifestSide(c, f);
  entrySide(c, f);
  sourceSide(c, f);
  return checkRun(
    'manifest-lock',
    {
      ok: 'manifest and lock agree',
      bad: (n) => `${count(n, 'disagreement')} between palm.yaml and palm.lock.yaml`,
    },
    f,
  );
}

/**
 * B3: an in-repo entry whose own files changed since the lock (its content hash moved) is the
 * drift signal, per entry, so two pull requests that touch two entries do not conflict in
 * palm.lock.yaml. The entry is then reported here, not again by `lock-disk`.
 */
export function localSources(c: CheckContext): CheckRun {
  const f = found();
  const { state } = c.run;
  const local = new Set(
    state.sources
      .all()
      .filter((s) => s.isLocal)
      .map((s) => s.name),
  );
  for (const e of state.lock.entries) {
    if (!local.has(e.source) || e.declined || e.kind === 'plugin') continue;
    const out = c.renders.get(lockId(e));
    if (!out || out.content === e.content) continue;
    c.drifted.add(lockId(e));
    const moved = `content ${short(e.content, 7)} → ${short(out.content, 7)}`;
    f.fail.push(
      problem(
        `${e.kind} ${e.name} in source ${e.source} changed since palm.lock.yaml (${moved})`,
        `${install(c)}, then commit palm.lock.yaml and the files it re-rendered`,
        e,
      ),
    );
  }
  const bad = (n: number) =>
    `${count(n, 'in-repo entity', 'in-repo entities')} changed since the lock`;
  return checkRun('local-sources', { ok: 'in-repo sources match the lock', bad }, f);
}

/** Every lock source is declared; every declared local source exists. */
export function sourcesDeclared(c: CheckContext): CheckRun {
  const f = found();
  const { state } = c.run;
  for (const name of Object.keys(state.lock.sources))
    if (!state.manifest.hasSource(name))
      f.fail.push(problem(`source ${name} is in palm.lock.yaml but not in palm.yaml`, install(c)));
  for (const ref of state.sources.all()) {
    if (!ref.isLocal || !ref.source.path || existsSync(ref.source.path)) continue;
    const rel = state.paths.lockForm(ref.source.path);
    f.fail.push(problem(`source ${ref.name}: ${rel} is missing`, `restore the directory ${rel}`));
  }
  const bad = (n: number) => `${count(n, 'source')} not declared or missing`;
  return checkRun('sources-declared', { ok: 'every source is declared', bad }, f);
}
