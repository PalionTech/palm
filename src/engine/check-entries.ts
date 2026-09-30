/**
 * The checks about what each lock entry holds on disk as a whole (FINDINGS-v2 ruling 29):
 * `render` (an entry whose render is empty, E3), `partial` (an active target the entry is not
 * on, Y5 Z5), `orphans` (files inside an entity folder palm owns that the lock does not list,
 * C13), `pending` (under -g, files this machine holds that the pulled lock no longer lists, J7)
 * and `source-paths` (a lock-owned path whose real path lies inside a declared source, C3).
 * Nothing is written.
 */
import { realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { CheckProblem, CheckRun, LockEntry } from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import { isWithin } from '../lib/fs.js';
import {
  type CheckContext,
  checkRun,
  count,
  entityOf,
  found,
  missingTargets,
  notApplicable,
  rendersFiles,
} from './check-kit.js';
import { localSourceDirs, orphansOf } from './orphans.js';
import { palmCommand } from './report.js';
import { pendingRemovals } from './sync.js';

function install(c: CheckContext, words: string[] = [], extra?: string): string {
  return palmCommand('install', words, c.run.state.paths.scope, extra);
}

function problem(e: LockEntry, message: string, fix: string, file?: string): CheckProblem {
  const p: CheckProblem = { entity: entityOf(e), message, fix };
  if (file !== undefined) p.file = file;
  return p;
}

/** E3: an entry the lock records with an empty render: installed for no target. */
export function renderCheck(c: CheckContext): CheckRun {
  const f = found();
  for (const e of c.run.state.lock.entries.filter(rendersFiles))
    if (Object.keys(e.render).length === 0 && missingTargets(c, e).length)
      f.fail.push(problem(e, `${e.kind} ${e.name} is installed for no target`, install(c)));
  return checkRun(
    'render',
    {
      ok: 'every entry is rendered',
      bad: (n) => `${count(n, 'entry', 'entries')} installed for no target`,
    },
    f,
  );
}

/**
 * T7 Y2': the fix for a target palm refuses to render for is the refusal's own hint (a bare
 * `palm install` would refuse again); a target that failed for another reason is installed again.
 */
function partialFix(c: CheckContext, e: LockEntry, missing: readonly string[]): string {
  const refusals = c.renders.get(lockId(e))?.refusals ?? [];
  const hints = [
    ...new Set(
      refusals.filter((r) => r.target && missing.includes(r.target) && r.hint).map((r) => r.hint),
    ),
  ];
  return hints.length ? hints.join('; ') : install(c);
}

/** Y5 Z5: an entry installed for some of its targets and not the others. */
export function partialCheck(c: CheckContext): CheckRun {
  const f = found();
  for (const e of c.run.state.lock.entries.filter(rendersFiles)) {
    const missing = missingTargets(c, e);
    if (Object.keys(e.render).length && missing.length)
      f.fail.push(
        problem(
          e,
          `${e.kind} ${e.name} is not installed for ${missing.join(', ')}`,
          partialFix(c, e, missing),
        ),
      );
  }
  return checkRun(
    'partial',
    {
      ok: 'every entry is on all its targets',
      bad: (n) => `${count(n, 'entry', 'entries')} partial`,
    },
    f,
  );
}

/** C13: files inside an entity folder palm owns that the lock does not list. */
export async function orphansCheck(c: CheckContext): Promise<CheckRun> {
  const f = found();
  const { state } = c.run;
  for (const e of state.lock.entries.filter(rendersFiles))
    for (const { dir, file } of await orphansOf(state, e)) {
      const message = `${file} is inside ${dir}/ but palm.lock.yaml does not list it`;
      f.fail.push(problem(e, message, install(c, [e.source, e.name], '--force'), file));
    }
  return checkRun(
    'orphans',
    {
      ok: 'no stray file in a folder palm owns',
      bad: (n) => `${count(n, 'stray file')} in folders palm owns`,
    },
    f,
  );
}

/** J7: under -g, files this machine holds that the pulled lock no longer lists. */
export async function pendingCheck(c: CheckContext): Promise<CheckRun> {
  const { state } = c.run;
  if (state.paths.scope !== 'global' || !state.applied)
    return notApplicable('pending', 'applied files outside the lock', 'global scope only');
  const f = found();
  const { files, fragments } = await pendingRemovals(state);
  const left = [...files, ...fragments.map((m) => `${m.at} in ${m.file}`)];
  const shown = left.slice(0, 3);
  if (left.length)
    f.fail.push({
      message: `applied files no longer in the lock: ${left.length} (${shown.join(', ')}${left.length > 3 ? ', …' : ''})`,
      fix: `${install(c)} removes them`,
    });
  return checkRun(
    'pending',
    { ok: 'no applied file outside the lock', bad: () => 'applied files no longer in the lock' },
    f,
  );
}

/** The real path of `abs`, or of its nearest existing ancestor with the rest appended. */
async function realOf(abs: string): Promise<string> {
  const real = await realpath(abs).catch(() => undefined);
  if (real !== undefined) return real;
  const parent = dirname(abs);
  return parent === abs ? abs : join(await realOf(parent), basename(abs));
}

/** X4: one line per entity and source, with a count: `3 files of skill tdd lie inside …`. */
function insideProblem(c: CheckContext, e: LockEntry, source: string, files: string[]) {
  const [first = ''] = files;
  const what =
    files.length === 1 ? `${first} lies` : `${files.length} files of ${e.kind} ${e.name} lie`;
  const shown = files.length === 1 ? '' : ` (${first}, …)`;
  return problem(
    e,
    `${what} inside the declared source ${c.run.state.paths.lockForm(source)}${shown}; palm never deletes inside a source`,
    'remove the link that leads into the source, or move the source to a folder of its own',
    first,
  );
}

/**
 * C3: a path palm owns that reaches into a declared source through a link (`.claude/skills ->
 * ../skill`): its real path lies inside the source while the path itself does not (a source at
 * the project root holds every output path by design and is not reported). One line per entity
 * (X4).
 */
export async function sourcePaths(c: CheckContext): Promise<CheckRun> {
  const f = found();
  const { lock, paths } = c.run.state;
  const dirs = localSourceDirs(c.run.state);
  const reals = await Promise.all(dirs.map(realOf));
  for (const e of lock.entries.filter(rendersFiles)) {
    const inside = new Map<string, string[]>();
    for (const file of [...new Set([...e.files, ...(e.merged ?? []).map((m) => m.file)])]) {
      const abs = paths.abs(file);
      const real = await realOf(abs);
      const at = reals.findIndex((s, i) => isWithin(real, s) && !isWithin(abs, dirs[i] ?? s));
      const source = reals[at];
      if (source) inside.set(source, [...(inside.get(source) ?? []), file]);
    }
    for (const [source, files] of inside) f.fail.push(insideProblem(c, e, source, files));
  }
  return checkRun(
    'source-paths',
    {
      ok: 'no generated path lies inside a source',
      bad: (n) => `${count(n, 'generated path')} inside a declared source`,
    },
    f,
  );
}
