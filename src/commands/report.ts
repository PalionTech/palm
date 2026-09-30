/**
 * How every command that writes (install, bare install, install mcp, create, update) ends: the
 * summary (or the JSON document), the targets line on the run that wrote `targets:` to
 * palm.yaml, and exit 1 when anything failed, 130 after a Ctrl-C.
 */
import type { InstallResult, PalmContext } from '../core/types.js';
import type { ScopeState } from '../create/engine.js';
import { failureCount, printInstallSummary } from '../ui/output.js';
import type { App } from './app.js';
import { ExitSignal } from './grammar.js';
import { EXIT } from './main.js';
import { engine, targetDirs } from './shared.js';

export interface InstallReport {
  /** The scope as it was before the run (palm.yaml targets, lock size). */
  before: ScopeState;
  /** The scope after it: the targets written, the lock sources. */
  after: ScopeState;
  /** Print `from <source> <version>` on each line (the run named its entities). */
  from?: boolean;
  /** The `--json` document when it is more than the result (update: the plan too). */
  json?: unknown;
  /** More paths the commit line names (`palm create`: the source directory). */
  alsoCommit?: string[];
  /** The run named its entities: their unchanged rows print, and "Nothing installed." when none did. */
  named?: boolean;
  /** The source as a printed command names it (K9): the key once declared, else as typed. */
  sourceWord?: (source: string) => string;
}

/** Y26, C28: what a dry run reports as data: `would-install`, not `installed`. */
const WOULD: Readonly<Record<string, string>> = {
  installed: 'would-install',
  updated: 'would-update',
  're-rendered': 'would-re-render',
  restored: 'would-restore',
  removed: 'would-remove',
};

function dryRunDoc(doc: unknown): unknown {
  const d = doc as { outcomes?: Array<{ status: string }> };
  if (!Array.isArray(d?.outcomes)) return doc;
  const outcomes = d.outcomes.map((o) => ({ ...o, status: WOULD[o.status] ?? o.status }));
  return { ...d, outcomes };
}

/** Where the targets came from, on the run that detected them and wrote them to palm.yaml. */
async function detected(app: App, ctx: PalmContext, r: InstallReport): Promise<string[]> {
  if (r.before.manifest.targets !== undefined) return [];
  if (r.after.manifest.targets === undefined && !ctx.flags.dryRun) return [];
  return targetDirs(app, ctx, r.after);
}

export async function reportInstall(
  ctx: PalmContext,
  app: App,
  result: InstallResult,
  r: InstallReport,
): Promise<void> {
  const out = app.out;
  const doc = r.json ?? result;
  if (out.jsonMode) out.json(ctx.flags.dryRun ? dryRunDoc(doc) : doc);
  else
    printInstallSummary(out, result, {
      scope: r.after.paths.scope,
      targets: r.after.targets,
      dryRun: ctx.flags.dryRun,
      first: r.before.lock.size === 0,
      detected: await detected(app, ctx, r),
      ...(r.from ? { from: r.after.lock.sources } : {}),
      ...(r.alsoCommit ? { alsoCommit: r.alsoCommit } : {}),
      ...(r.named ? { named: true } : {}),
      ...(r.sourceWord ? { sourceWord: r.sourceWord } : {}),
    });
  if (app.interrupted) throw new ExitSignal(EXIT.cancelled);
  if (failureCount(result)) throw new ExitSignal(EXIT.failure);
}

/** Run an install with the first Ctrl-C meaning "stop after the current entity". */
export async function interruptible<T>(app: App, fn: () => Promise<T>): Promise<T> {
  app.onInterrupt = () => void engine(app).requestInstallStop();
  try {
    return await fn();
  } finally {
    app.onInterrupt = undefined;
  }
}
