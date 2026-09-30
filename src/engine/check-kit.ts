/**
 * Shared pieces of `palm check`: the context every check reads (the scope, the lock entries
 * rendered again from the cache, whether the scope is in a git repository) and the builders of
 * one check's result.
 */
import { isPalmError, type PalmError } from '../core/errors.js';
import type { CheckProblem, CheckRun, Entity, LockEntry, TargetId } from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import type { Run } from './jobs.js';
import type { RenderOutput } from './render.js';
import { renderLockedOrThrow } from './verify.js';

/** A lock entry rendered again: the renders, closure, unit and the entity it came from. */
export type LockedRender = RenderOutput & { entity: Entity };

export interface CheckContext {
  run: Run;
  /** The scope is inside a git repository (project scope only). */
  git: boolean;
  /**
   * Each lock entry rendered again as locked, for the targets it records and every active
   * target it lacks (to tell a partial install from a skipped target); undefined when palm
   * cannot render it.
   */
  renders: Map<string, LockedRender | undefined>;
  /** Entries palm could not render because their commit is not cached and `--offline` is set (E13). */
  offline: Set<string>;
  /**
   * B3: entries palm could not render because the source could not be fetched or the cache not
   * written (E_NETWORK, E_IO naming the path, E_SOURCE for a ref the source lacks), by lock id.
   * `lock-disk` reports the error itself, never a difference.
   */
  unreachable: Map<string, PalmError>;
  /** In-repo entries whose content changed since the lock (reported once, by `local-sources`). */
  drifted: Set<string>;
}

export interface Found {
  fail: CheckProblem[];
  warn: CheckProblem[];
}

export const found = (): Found => ({ fail: [], warn: [] });

export interface Labels {
  ok: string;
  bad: (n: number) => string;
  /** The label when only warnings were found (default: `bad`). */
  warned?: (n: number) => string;
}

/** Problems once each: a file two targets share (a closure script) is one problem, not two. */
function unique(list: readonly CheckProblem[]): CheckProblem[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const e = p.entity;
    const key = [e?.kind, e?.name, e?.source, p.file, p.message].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One check's result: `fail` when any failing problem, else `warn` when any warning, else `ok`. */
export function checkRun(id: string, labels: Labels, f: Found): CheckRun {
  const problems = unique([...f.fail, ...f.warn]);
  if (f.fail.length) return { id, label: labels.bad(problems.length), status: 'fail', problems };
  if (f.warn.length) {
    const label = (labels.warned ?? labels.bad)(problems.length);
    return { id, label, status: 'warn', problems };
  }
  return { id, label: labels.ok, status: 'ok', problems };
}

/** Checks that do not apply to the scope (a global-only check in a project): never a failure. */
const NOT_APPLICABLE = new WeakSet<CheckRun>();

/**
 * A check that could not run, never shown as passed (`skipped`, E12). Its one problem line says
 * so, so `--quiet` prints it too (O12), and `--strict` fails on it.
 */
export function skipped(
  id: string,
  what: string,
  why = 'not a git repository',
  fix?: string,
): CheckRun {
  const problem: CheckProblem = { message: `${id} did not run: ${why}` };
  if (fix) problem.fix = fix;
  return { id, label: `${what}: skipped (${why})`, status: 'skipped', problems: [problem] };
}

/** A check that does not apply to the scope (`skipped`, no problem; `--strict` ignores it). */
export function notApplicable(id: string, what: string, why: string): CheckRun {
  const run: CheckRun = { id, label: `${what}: skipped (${why})`, status: 'skipped', problems: [] };
  NOT_APPLICABLE.add(run);
  return run;
}

/** False for a check `notApplicable` built. */
export function applies(run: CheckRun): boolean {
  return !NOT_APPLICABLE.has(run);
}

export function entityOf(e: LockEntry): CheckProblem['entity'] {
  return { kind: e.kind, name: e.name, source: e.source };
}

/** `n thing` / `n things`. */
export function count(n: number, word: string, plural = `${word}s`): string {
  return `${n} ${n === 1 ? word : plural}`;
}

/** The targets a lock entry should be on: the scope's, narrowed by the entry's `targets`. */
function expectedTargets(run: Run, e: LockEntry): TargetId[] {
  const narrowed = e.targets;
  const scope = run.state.targets;
  return narrowed?.length ? scope.filter((t) => narrowed.includes(t)) : [...scope];
}

/** Targets the install recorded as skipped (`<id>: skipped` notes): nothing to write there. */
function skippedTargets(e: LockEntry): Set<string> {
  return new Set(
    (e.notes ?? []).flatMap((n) => {
      const m = /^([a-z]+): skipped$/.exec(n);
      return m?.[1] ? [m[1]] : [];
    }),
  );
}

/**
 * The active targets the entry should be on but the lock does not record (a partial install,
 * or a target added since). A target the render skips (no such kind there) does not count.
 */
export function missingTargets(c: CheckContext, e: LockEntry): TargetId[] {
  const out = c.renders.get(lockId(e));
  const skippedHere = skippedTargets(e);
  return expectedTargets(c.run, e).filter(
    (t) => e.render[t] === undefined && !skippedHere.has(t) && !out?.renders[t]?.skipped,
  );
}

/** True for entries the checks that read the disk look at (not plugins, not declined). */
export function rendersFiles(e: LockEntry): boolean {
  return e.kind !== 'plugin';
}

/** Errors that say the source could not be reached, not that the files differ (B3). */
const UNREACHABLE: ReadonlySet<string> = new Set(['E_NETWORK', 'E_IO', 'E_SOURCE', 'E_GIT']);

type RenderSink = Pick<CheckContext, 'run' | 'offline' | 'unreachable'>;

async function renderOne(c: RenderSink, e: LockEntry): Promise<LockedRender | undefined> {
  const recorded = Object.keys(e.render) as TargetId[];
  const targets = [...new Set([...recorded, ...expectedTargets(c.run, e)])];
  try {
    return await renderLockedOrThrow(c.run, e, targets);
  } catch (err) {
    if (!isPalmError(err)) return undefined;
    if (c.run.ctx.flags.offline && err.code === 'E_NETWORK') c.offline.add(lockId(e));
    else if (UNREACHABLE.has(err.code)) c.unreachable.set(lockId(e), err);
    return undefined;
  }
}

/** Renders every installed entry once, for the checks that compare the disk with the render. */
export async function renderAll(c: RenderSink): Promise<Map<string, LockedRender | undefined>> {
  const out = new Map<string, LockedRender | undefined>();
  for (const e of c.run.state.lock.entries)
    if (rendersFiles(e)) out.set(lockId(e), await renderOne(c, e));
  return out;
}
