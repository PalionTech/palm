/**
 * The checks that read generated files (DESIGN §6 "Check"): `lock-disk` and `hidden-unicode`.
 * With `--offline` and a commit missing from the cache, `lock-disk` says so instead of
 * reporting a difference (E13). Nothing is written.
 */
import { readFile } from 'node:fs/promises';
import type { CheckProblem, CheckRun, LockEntry, Rendered, TargetId } from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import { scanHiddenUnicode } from '../lib/unicode.js';
import {
  type CheckContext,
  checkRun,
  count,
  entityOf,
  type Found,
  found,
  rendersFiles,
  skipped,
} from './check-kit.js';
import { fileStates, fragmentStates, ownedFragments } from './diff.js';
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
  for (const [key, s] of await fragmentStates(c.run.state.paths, r, ownedFragments(e))) {
    const file = key.split('#')[0] as string;
    if (s === 'missing')
      f.fail.push(problem(e, file, `palm's entry in ${file} is missing`, fix.restore));
    if (s === 'changed')
      f.fail.push(problem(e, file, `palm's entry in ${file} was changed`, fix.force));
  }
}

async function entryDisk(c: CheckContext, e: LockEntry, f: Found): Promise<void> {
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

/**
 * O12 X2 B5 E4': entries palm could not render because their commit is not cached (offline) were
 * not checked, so the check is never ✓: `skipped` with a line naming how many, or the failure
 * with the count beside it.
 */
function withOffline(c: CheckContext, run: CheckRun, offline: number): CheckRun {
  if (!offline) return run;
  const what = `${count(offline, 'entity', 'entities')} not checked (cache empty)`;
  const fix = palmCommand('install', [], c.run.state.paths.scope);
  if (run.status === 'fail') return { ...run, label: `${run.label}; ${what}` };
  return {
    ...run,
    status: 'skipped',
    label: `generated files: ${what}`,
    problems: [...run.problems, { message: `lock-disk did not run for ${what}`, fix }],
  };
}

/** Every listed file and fragment is on disk as the render recomputed from the cache has it. */
export async function lockDisk(c: CheckContext): Promise<CheckRun> {
  const f = found();
  const entries = c.run.state.lock.entries.filter(rendersFiles);
  const offline = entries.filter((e) => c.offline.has(lockId(e)));
  const fix = palmCommand('install', [], c.run.state.paths.scope);
  if (offline.length && offline.length === entries.length)
    return skipped('lock-disk', 'generated files', 'cache empty', fix);
  for (const e of entries)
    if (!c.drifted.has(lockId(e)) && !c.offline.has(lockId(e))) await entryDisk(c, e, f);
  const run = checkRun(
    'lock-disk',
    {
      ok: 'generated files match the lock',
      bad: (n) => `${count(n, 'generated file')} ${n === 1 ? 'differs' : 'differ'} from the lock`,
    },
    f,
  );
  return withOffline(c, run, offline.length);
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
