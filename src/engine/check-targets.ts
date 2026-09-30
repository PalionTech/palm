/**
 * `targets` (B2): the targets palm.yaml names against the ones the lock rendered for. A target
 * dropped from `targets:` still has its files on disk until the next install removes them, so
 * check says how many before that install runs (a failure: palm.yaml and the lock disagree).
 * A target added to `targets:` is `partial`'s. Nothing is written.
 */
import type { CheckRun, TargetId } from '../core/types.js';
import { isWithin } from '../lib/fs.js';
import { type CheckContext, checkRun, count, found } from './check-kit.js';
import { palmCommand } from './report.js';

/** Targets some lock entry rendered for that palm.yaml no longer names. */
function dropped(c: CheckContext): TargetId[] {
  const { lock, targets } = c.run.state;
  const rendered = new Set(lock.entries.flatMap((e) => Object.keys(e.render) as TargetId[]));
  return [...rendered].filter((t) => !targets.includes(t)).sort();
}

/** The output directories of `ids` (absolute). */
function dirsOf(c: CheckContext, ids: readonly TargetId[]): string[] {
  const { ctx, deps, state } = c.run;
  const { paths } = state;
  return ids.flatMap((t) =>
    deps
      .getTarget(t)
      .outputDirs(paths.scope, paths.root, ctx.env)
      .map((d) => paths.abs(d)),
  );
}

/** Files and merged entries under `t`'s output directories that no active target writes there. */
function leftBehind(c: CheckContext, t: TargetId): number {
  const { lock, paths, targets } = c.run.state;
  const own = dirsOf(c, [t]);
  const kept = dirsOf(c, targets);
  const counts = (file: string) => {
    const abs = paths.abs(file);
    return own.some((d) => isWithin(abs, d)) && !kept.some((d) => isWithin(abs, d));
  };
  let n = 0;
  for (const e of lock.entries) {
    if (e.render[t] === undefined) continue;
    n += e.files.filter(counts).length;
    n += (e.merged ?? []).filter((m) => counts(m.file)).length;
  }
  return n;
}

/** B2: a target dropped from palm.yaml whose files the next install removes. */
export function targetsCheck(c: CheckContext): CheckRun {
  const f = found();
  const { scope } = c.run.state.paths;
  for (const t of dropped(c)) {
    const n = leftBehind(c, t);
    const what = `${count(n, 'file')} ${n === 1 ? 'is' : 'are'} removed by the next palm install`;
    f.fail.push({
      message: `${t} removed from targets in palm.yaml: ${what}`,
      fix: `${palmCommand('install', [], scope)} removes them (--dry-run lists them); to keep them, add ${t} back to targets: in palm.yaml`,
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
