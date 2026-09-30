/**
 * Running prepared jobs (DESIGN §6 steps 5 to 10): every entity rendered and diffed, clashes
 * with another owner refused, moving sources shown and confirmed, consent asked once for the
 * whole run, sources that cannot move as a unit held back, then one entity at a time with
 * palm.yaml and the lock saved once something is on disk.
 *
 * A stop request (the CLI's first Ctrl-C, `requestInstallStop`) is honoured between entities,
 * before the first write included (K16): before anything is written the run is E_CANCELLED;
 * after, the result says how far it got (`interrupted`) and the CLI exits 130 after printing
 * it (L11). palm never listens for signals itself; the CLI owns them.
 */
import { withScopeLock } from '../core/context.js';
import { PalmError } from '../core/errors.js';
import type { ExecUnit, PalmContext } from '../core/types.js';
import { applyPrepared } from './apply.js';
import { askForConsent, type Job, type Prepared, prepareJob, type Run } from './jobs.js';
import { confirmMoves, holdBack, type Move } from './moves.js';
import { refuseConflicts } from './owners.js';
import { failureOf } from './report.js';
import { type ScopeState, saveScope } from './scope.js';

let stopRequested = false;

/** Asks the running install to stop before its next entity (the CLI's first Ctrl-C). */
export function requestInstallStop(): void {
  stopRequested = true;
}

function cancelled(): PalmError {
  return new PalmError('E_CANCELLED', 'cancelled; nothing was written');
}

/** Runs `fn` holding the scope's process lock (DESIGN §2); a dry run takes none. A stop request ends with the run. */
export async function lockScope<T>(
  ctx: PalmContext,
  state: ScopeState,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return ctx.flags.dryRun ? await fn() : await withScopeLock(state.paths, fn);
  } finally {
    stopRequested = false;
  }
}

/** Renders and diffs every job; a job that cannot be prepared is a failure, not an error. */
export async function prepareAll(run: Run, jobs: Job[]): Promise<Prepared[]> {
  const out: Prepared[] = [];
  for (const job of jobs) {
    if (stopRequested) throw cancelled();
    try {
      out.push(await prepareJob(run, job));
    } catch (e) {
      if (e instanceof PalmError && (e.code === 'E_CANCELLED' || e.code === 'E_NON_INTERACTIVE'))
        throw e;
      const { kind, name } = job.entity;
      run.result.failures.push(failureOf({ kind, name, source: job.source.name }, e));
    }
  }
  return out;
}

/** Applies prepared jobs one by one, saving once something is on disk; stops early on a stop request. */
export async function applyAll(run: Run, prepared: Prepared[]): Promise<void> {
  for (const [i, p] of prepared.entries()) {
    if (stopRequested) {
      if (!run.touched) throw cancelled();
      run.result.interrupted = { done: i, total: prepared.length };
      run.result.warnings.push(
        `cancelled after ${i} of ${prepared.length}; palm.lock.yaml records what was installed`,
      );
      return;
    }
    run.result.outcomes.push(await applyPrepared(run, p));
    if (run.touched) await saveScope(run.state);
  }
}

/** What a run knows before it prepares its jobs. */
export interface RunPlan {
  /** Sources whose commit moves: shown and confirmed, then held back as a unit (moves.ts). */
  moves?: Move[];
  /** Lock ids this run removes: they own nothing any more (owners.ts). */
  leaving?: ReadonlySet<string>;
  /** The trusted units before an update, for the consent diff. */
  previous?: Record<string, ExecUnit>;
  /** The person confirmed the moves already (`palm update` asked `Apply N changes?`). */
  confirmed?: boolean;
}

/**
 * Everything before the first write: prepare, refuse clashes, show and confirm moves, consent,
 * hold back sources that cannot move. Returns what to apply and the sources held back.
 */
export async function prepareRun(
  run: Run,
  jobs: Job[],
  plan: RunPlan = {},
): Promise<{ prepared: Prepared[]; held: Set<string> }> {
  const all = await prepareAll(run, jobs);
  const { kept, refused } = refuseConflicts(run, all, plan.leaving);
  const moves = plan.moves ?? [];
  if (!plan.confirmed) await confirmMoves(run, moves, kept);
  await askForConsent(run, kept, plan.previous);
  return holdBack(run, moves, kept, refused);
}

/** The whole pipeline: prepare, then apply. */
export async function runJobs(run: Run, jobs: Job[], plan: RunPlan = {}): Promise<void> {
  const { prepared } = await prepareRun(run, jobs, plan);
  await applyAll(run, prepared);
}

/**
 * The end of a run (K1, R6, Z1, V4): palm.yaml and the lock are written when the run succeeded,
 * or when it changed the disk (they must record what the disk holds). A run that failed and
 * wrote nothing writes nothing: no declared source, no rename, no moved commit. True when saved.
 */
export async function settle(run: Run, failed: boolean): Promise<boolean> {
  if (!run.touched && (failed || run.result.failures.length)) return false;
  await saveScope(run.state);
  return true;
}
