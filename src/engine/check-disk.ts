/**
 * The checks that read generated files (DESIGN §6 "Check"): `lock-disk` and `hidden-unicode`.
 * `lock-disk` also fails on a partial install (an active target the entry is not on, Y5 Z5),
 * on files inside an entity directory the lock does not list (orphans, C13) and, under -g, on
 * files this machine holds that the lock no longer lists (J7). With `--offline` and an empty
 * cache it says so instead of reporting a difference (E13). Nothing is written.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { CheckProblem, CheckRun, LockEntry, Rendered, TargetId } from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import { isWithin, walkFiles } from '../lib/fs.js';
import { scanHiddenUnicode } from '../lib/unicode.js';
import {
  type CheckContext,
  checkRun,
  count,
  entityOf,
  type Found,
  found,
  missingTargets,
  rendersFiles,
  skipped,
} from './check-kit.js';
import { fileStates, fragmentStates } from './diff.js';
import { palmCommand } from './report.js';

const MAX_TEXT_BYTES = 1024 * 1024;

function fixes(c: CheckContext, e: LockEntry) {
  const scope = c.run.state.paths.scope;
  return {
    restore: palmCommand('install', [], scope),
    force: palmCommand('install', [e.source, e.name], scope, '--force'),
  };
}

function problem(
  e: LockEntry,
  file: string | undefined,
  message: string,
  fix: string,
): CheckProblem {
  return file === undefined
    ? { entity: entityOf(e), message, fix }
    : { entity: entityOf(e), file, message, fix };
}

async function targetFiles(c: CheckContext, e: LockEntry, r: Rendered, f: Found): Promise<void> {
  const { paths, applied } = c.run.state;
  const fix = fixes(c, e);
  for (const [file, s] of await fileStates(paths, r, applied ? { applied } : {})) {
    if (s === 'missing') f.fail.push(problem(e, file, `${file} is missing`, fix.restore));
    else if (s !== 'same')
      f.fail.push(problem(e, file, `${file} differs from what palm renders`, fix.force));
  }
}

async function targetFragments(
  c: CheckContext,
  e: LockEntry,
  r: Rendered,
  f: Found,
): Promise<void> {
  const fix = fixes(c, e);
  for (const [key, s] of await fragmentStates(c.run.state.paths, r)) {
    const file = key.split('#')[0] as string;
    if (s === 'missing')
      f.fail.push(problem(e, file, `palm's entry in ${file} is missing`, fix.restore));
    if (s === 'changed')
      f.fail.push(problem(e, file, `palm's entry in ${file} was changed`, fix.force));
  }
}

/** Y5 Z5 E3: an active target the entry is not installed for (or no target at all). */
function partial(c: CheckContext, e: LockEntry, f: Found): void {
  const missing = missingTargets(c, e);
  if (!missing.length) return;
  const none = Object.keys(e.render).length === 0;
  const what = none
    ? 'is installed for no target'
    : `is partial: not installed for ${missing.join(', ')}`;
  f.fail.push(problem(e, undefined, `${e.kind} ${e.name} ${what}`, fixes(c, e).restore));
}

async function entryDisk(c: CheckContext, e: LockEntry, f: Found): Promise<void> {
  partial(c, e, f);
  const out = c.renders.get(lockId(e));
  if (!out) {
    const message = `palm cannot render ${e.kind} ${e.name} from source ${e.source}`;
    f.fail.push(problem(e, undefined, message, fixes(c, e).restore));
    return;
  }
  for (const id of Object.keys(e.render) as TargetId[]) {
    const r = out.renders[id];
    if (!r || r.hash !== e.render[id]) {
      const message = `${e.kind} ${e.name} renders differently for ${id} than palm.lock.yaml records`;
      f.fail.push(problem(e, undefined, message, fixes(c, e).restore));
      continue;
    }
    await targetFiles(c, e, r, f);
    await targetFragments(c, e, r, f);
  }
}

/** The directories palm owns whole for an entry: a skill's folder per harness, a closure copy. */
function entityDirs(c: CheckContext, e: LockEntry): string[] {
  const dirs = new Set<string>();
  const segment = `/${e.name}/`;
  if (e.kind === 'skill')
    for (const file of e.files) {
      const at = file.indexOf(segment);
      if (at >= 0) dirs.add(file.slice(0, at + segment.length - 1));
    }
  const closure = e.exec?.closure?.root;
  if (closure?.startsWith(c.run.state.paths.lockForm(c.run.state.paths.assetsDir)))
    dirs.add(closure);
  return [...dirs];
}

/** Files below `dir` (lock form) that no lock entry lists. */
async function unlisted(c: CheckContext, dir: string, listed: Set<string>): Promise<string[]> {
  const abs = c.run.state.paths.abs(dir);
  const local = c.run.state.sources
    .all()
    .flatMap((s) => (s.isLocal && s.source.path ? [s.source.path] : []));
  if (!existsSync(abs) || local.some((s) => isWithin(abs, s))) return [];
  return (await walkFiles(abs)).files.map((f) => `${dir}/${f.rel}`).filter((r) => !listed.has(r));
}

/** C13: files inside an entity directory palm owns that the lock does not list. */
async function orphans(c: CheckContext, f: Found): Promise<void> {
  const { lock } = c.run.state;
  const listed = new Set(lock.entries.flatMap((e) => e.files));
  for (const e of lock.entries.filter(rendersFiles))
    for (const dir of entityDirs(c, e))
      for (const rel of await unlisted(c, dir, listed)) {
        const message = `${rel} is inside ${dir}/ but palm.lock.yaml does not list it`;
        f.fail.push(problem(e, rel, message, fixes(c, e).force));
      }
}

/** J7: under -g, files this machine holds that the pulled lock no longer lists. */
function appliedLeftovers(c: CheckContext, f: Found): void {
  const { applied, lock, paths } = c.run.state;
  if (!applied) return;
  const listed = new Set(lock.entries.flatMap((e) => e.files.map((p) => paths.abs(p))));
  const left = applied.record.files.filter((x) => !listed.has(x.path) && existsSync(x.path));
  if (!left.length) return;
  f.fail.push({
    message: `applied files no longer in the lock: ${left.length} (${left
      .slice(0, 3)
      .map((x) => paths.lockForm(x.path))
      .join(', ')}${left.length > 3 ? ', …' : ''})`,
    fix: `${palmCommand('install', [], paths.scope)} removes them`,
  });
}

/** Every listed file and fragment is on disk as the render recomputed from the cache has it. */
export async function lockDisk(c: CheckContext): Promise<CheckRun> {
  const f = found();
  const entries = c.run.state.lock.entries.filter(rendersFiles);
  const offline = entries.filter((e) => c.offline.has(lockId(e)));
  if (offline.length && offline.length === entries.length)
    return skipped('lock-disk', 'generated files', 'cache empty; run palm install');
  for (const e of entries)
    if (!c.drifted.has(lockId(e)) && !c.offline.has(lockId(e))) await entryDisk(c, e, f);
  await orphans(c, f);
  appliedLeftovers(c, f);
  const skippedNote = offline.length
    ? `; ${count(offline.length, 'entity', 'entities')} skipped (cache empty; run palm install)`
    : '';
  return checkRun(
    'lock-disk',
    {
      ok: `generated files match the lock${skippedNote}`,
      bad: (n) => `${count(n, 'problem')} with generated files${skippedNote}`,
    },
    f,
  );
}

// ---------------------------------------------------------------------------
// hidden-unicode
// ---------------------------------------------------------------------------

async function textOf(abs: string): Promise<string | undefined> {
  const data = await readFile(abs).catch(() => undefined);
  if (!data || data.length > MAX_TEXT_BYTES || data.subarray(0, 8192).includes(0)) return undefined;
  return data.toString('utf8');
}

/** No critical hidden Unicode in a generated file (zero-width characters warn). */
export async function hiddenUnicode(c: CheckContext): Promise<CheckRun> {
  const f = found();
  const { paths } = c.run.state;
  for (const e of c.run.state.lock.entries)
    for (const file of e.files) {
      const text = await textOf(paths.abs(file));
      const findings = text ? scanHiddenUnicode(text) : [];
      const critical = findings.find((x) => x.severity === 'critical');
      const any = critical ?? findings[0];
      if (!any) continue;
      const message = `${file} holds ${any.name} (U+${any.codePoint.toString(16).toUpperCase()})`;
      (critical ? f.fail : f.warn).push(
        problem(e, file, message, `fix the source, then ${fixes(c, e).force}`),
      );
    }
  return checkRun(
    'hidden-unicode',
    {
      ok: 'no hidden Unicode in generated files',
      bad: (n) => `${count(n, 'file')} with hidden Unicode`,
    },
    f,
  );
}
