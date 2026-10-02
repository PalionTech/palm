/**
 * `targets` (B2): the targets palm.yaml names against the ones the lock rendered for. A target
 * dropped from `targets:` still has its files on disk until the next install removes them, so
 * check says how many before that install runs (a failure: palm.yaml and the lock disagree).
 * The engine's `droppedTargets` finds them, the same list the install's dry run prints. A
 * target added to `targets:` is `partial`'s. Nothing is written.
 */
import type { CheckRun } from '../core/types.js';
import { type CheckContext, checkRun, count, found } from './check-kit.js';
import { palmCommand } from './report.js';
import { droppedTargets } from './targets.js';

/** B2: a target dropped from palm.yaml whose files the next install removes. */
export function targetsCheck(c: CheckContext): CheckRun {
  const f = found();
  const { ctx, deps, state } = c.run;
  const { scope } = state.paths;
  for (const d of droppedTargets(ctx, deps, state)) {
    const n = d.files.length;
    const what = `${count(n, 'file')} ${n === 1 ? 'is' : 'are'} removed by the next palm install`;
    f.fail.push({
      message: `${d.target} removed from targets in palm.yaml: ${what}`,
      fix: `${palmCommand('install', [], scope)} removes them (--dry-run lists them); to keep them, add ${d.target} back to targets: in palm.yaml`,
    });
  }
  return checkRun(
    'targets',
    {
      ok: 'palm.yaml targets match the lock',
      bad: (n) => `${count(n, 'target')} removed from palm.yaml, still installed`,
    },
    f,
  );
}
