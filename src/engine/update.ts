import { getIndex } from '../core/cache.js';
import { findOrigin } from '../core/config.js';
import { PalmError } from '../core/errors.js';
import { loadLock } from '../core/lockfile.js';
import { isMcpManifestEntry, listDeps, loadManifest } from '../core/manifest.js';
import { lockPath, manifestPath } from '../core/paths.js';
import type {
  DepRef,
  InstallOutcome,
  InstallRequest,
  InstallResult,
  Kind,
  LockEntry,
  PalmContext,
  Scope,
} from '../core/types.js';
import { type EngineDeps, resolveEngineDeps } from './deps.js';
import { dedupeOutcomes, installEntities } from './install.js';
import { nameMatchesEntry } from './query.js';

function parentOf(lock: LockEntry[], e: LockEntry): LockEntry | undefined {
  if (!e.via) return undefined;
  const [kind, ...rest] = e.via.split(':');
  const name = rest.join(':');
  return lock.find((p) => p.kind === kind && p.name === name);
}

/** Refetch origins and reinstall the selected entries whose content changed. */
export async function updateEntities(
  ctx: PalmContext,
  refs: Array<{ kind?: Kind; name: string }>,
  opts: { scope: Scope },
  depsIn?: Partial<EngineDeps>,
): Promise<InstallResult> {
  const deps = await resolveEngineDeps(depsIn, { targets: true });
  const lock = await loadLock(lockPath(ctx.paths, opts.scope));
  const manifest = await loadManifest(manifestPath(ctx.paths, opts.scope));

  let selected: LockEntry[];
  if (refs.length) {
    selected = [];
    for (const ref of refs) {
      const matches = lock.entries.filter(
        (e) => (!ref.kind || e.kind === ref.kind) && nameMatchesEntry(e, ref.name),
      );
      if (!matches.length) {
        throw new PalmError(
          'E_NOT_FOUND',
          `${ref.kind ?? 'Nothing'} named "${ref.name}" is ${ref.kind ? 'not ' : ''}installed`,
          'See `palm list`.',
        );
      }
      selected.push(...matches);
    }
  } else {
    selected = lock.entries.filter((e) => !e.via);
  }
  // Dependencies are refreshed through the entity that pulled them in.
  const roots = new Map<string, LockEntry>();
  for (let e of selected) {
    for (let p = parentOf(lock.entries, e); p; p = parentOf(lock.entries, p)) e = p;
    roots.set(`${e.kind}\0${e.name}\0${e.origin}`, e);
  }

  const outcomes: InstallOutcome[] = [];
  const warnings: string[] = [];
  const refreshed = new Set<string>();
  const groups = new Map<string, { targets: LockEntry['targets']; requests: InstallRequest[] }>();
  for (const e of roots.values()) {
    let request: InstallRequest;
    if (e.origin === 'adhoc') {
      outcomes.push({
        entry: e,
        status: 'unchanged',
        notes: ['ad hoc MCP server: edit palm.yaml and run `palm install` to change it'],
      });
      continue;
    }
    const pinned = listDeps(manifest, e.kind).find((d) =>
      isMcpManifestEntry(d)
        ? d.name.toLowerCase() === e.name.toLowerCase() || d.registry === e.path
        : d.name.toLowerCase() === e.name.toLowerCase(),
    );
    if (e.origin === 'registry') {
      const spec: DepRef = { name: e.path };
      if (pinned && isMcpManifestEntry(pinned) && pinned.version) spec.ref = pinned.version;
      request = { kind: 'mcp', spec, registry: e.path };
    } else {
      const spec = findOrigin(ctx, e.origin);
      if (!spec) {
        warnings.push(`${e.kind} ${e.name}: origin "${e.origin}" is no longer registered; skipped`);
        outcomes.push({
          entry: e,
          status: 'skipped',
          notes: [`origin "${e.origin}" not registered`],
        });
        continue;
      }
      const ref = pinned && !isMcpManifestEntry(pinned) ? pinned.ref : undefined;
      const key = `${spec.alias}#${ref ?? ''}`;
      if (!refreshed.has(key)) {
        refreshed.add(key);
        try {
          await getIndex(ctx, ref ? { ...spec, ref } : spec, { refresh: true, scan: deps.scan });
        } catch (err) {
          warnings.push(`could not refresh origin "${spec.alias}": ${(err as Error).message}`);
        }
      }
      const dep: DepRef = { name: e.name, origin: e.origin };
      if (ref) dep.ref = ref;
      request = { kind: e.kind, spec: dep };
    }
    const gk = e.targets.join(',');
    const g = groups.get(gk) ?? { targets: e.targets, requests: [] };
    g.requests.push(request);
    groups.set(gk, g);
  }

  for (const g of groups.values()) {
    const r = await installEntities(
      ctx,
      g.requests,
      { scope: opts.scope, targets: g.targets, noSave: true },
      deps,
    );
    outcomes.push(...r.outcomes);
    warnings.push(...r.warnings);
  }
  return { outcomes: dedupeOutcomes(outcomes), warnings: [...new Set(warnings)] };
}
