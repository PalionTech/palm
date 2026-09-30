/**
 * Running prepared jobs (DESIGN §6 steps 6 to 10): consent once for the whole run, then one
 * entity at a time with the lock and palm.yaml saved after each and again in `finally`. SIGINT
 * stops after the current entity (E_CANCELLED, exit 130); a second Ctrl-C ends palm at once.
 */
import { withScopeLock } from '../core/context.js';
import { PalmError } from '../core/errors.js';
import type { ExecUnit, PalmContext } from '../core/types.js';
import { applyPrepared } from './apply.js';
import { askForConsent, type Job, type Prepared, prepareJob, type Run } from './jobs.js';
import { failureOf } from './report.js';
import { type ScopeState, saveScope } from './scope.js';

interface StopState {
  stop: boolean;
}

const running = new Set<StopState>();

/** Asks every running install to stop after its current entity (the SIGINT handler's job). */
export function requestInstallStop(): void {
  for (const r of running) r.stop = true;
}

function watchInterrupt(ctx: PalmContext): { state: StopState; dispose: () => void } {
  const state: StopState = { stop: false };
  running.add(state);
  const onSigint = (): void => {
    if (state.stop) {
      dispose();
      process.kill(process.pid, 'SIGINT');
      return;
    }
    state.stop = true;
    ctx.log.warn('Interrupted: palm stops after the current entity (Ctrl-C again to quit now)');
  };
  const dispose = (): void => {
    process.off('SIGINT', onSigint);
    running.delete(state);
  };
  process.on('SIGINT', onSigint);
  return { state, dispose };
}

function interrupted(done: number, total: number): PalmError {
  return new PalmError(
    'E_CANCELLED',
    `interrupted after ${done} of ${total}; palm.lock.yaml records what was installed`,
    'run the same command again to finish',
  );
}

/** Runs `fn` holding the scope's process lock (DESIGN §2); a dry run takes none. */
export async function lockScope<T>(
  ctx: PalmContext,
  state: ScopeState,
  fn: () => Promise<T>,
): Promise<T> {
  return ctx.flags.dryRun ? fn() : withScopeLock(state.paths, fn);
}

/** Renders and diffs every job; a job that cannot be prepared is a failure, not an error. */
export async function prepareAll(run: Run, jobs: Job[]): Promise<Prepared[]> {
  const out: Prepared[] = [];
  for (const job of jobs) {
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

/** Applies prepared jobs one by one, saving after each; stops early on SIGINT. */
export async function applyAll(run: Run, prepared: Prepared[]): Promise<void> {
  const watch = watchInterrupt(run.ctx);
  try {
    for (const [i, p] of prepared.entries()) {
      if (watch.state.stop) throw interrupted(i, prepared.length);
      run.result.outcomes.push(await applyPrepared(run, p));
      await saveScope(run.state);
    }
  } finally {
    watch.dispose();
    await saveScope(run.state);
  }
}

/** The whole pipeline: prepare every job, ask consent once, apply. */
export async function runJobs(
  run: Run,
  jobs: Job[],
  previous?: Record<string, ExecUnit>,
): Promise<void> {
  const prepared = await prepareAll(run, jobs);
  await askForConsent(run, prepared, previous);
  await applyAll(run, prepared);
}
