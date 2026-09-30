/**
 * `palm cache clean [--yes]` (DESIGN.md §10): delete `$PALM_HOME/cache`, the checkouts and
 * indexes. Sources stay declared; the next command that needs one fetches it again. Without a
 * terminal it needs `--yes`.
 */
import { join } from 'node:path';
import { PalmError } from '../core/errors.js';
import type { PalmContext } from '../core/types.js';
import { formatBytes } from '../ui/format.js';
import type { App } from './app.js';
import type { Invocation } from './grammar.js';
import { displayPath, engine, type GlobalOptions, makeContext } from './shared.js';

async function confirmClean(ctx: PalmContext, shown: string): Promise<void> {
  if (ctx.flags.yes) return;
  if (!ctx.ui.isInteractive)
    throw new PalmError(
      'E_NON_INTERACTIVE',
      `palm cache clean deletes ${shown} and there is no terminal to ask`,
      'confirm it',
      { retryWith: '--yes' },
    );
  if (!(await ctx.ui.confirm(`Delete ${shown}?`, false)))
    throw new PalmError('E_CANCELLED', 'cancelled');
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const ctx = await makeContext(app, inv.opts as GlobalOptions);
  const shown = displayPath(ctx, join(ctx.paths.palmHome, 'cache'));
  const out = app.out;
  if (ctx.flags.dryRun) {
    if (out.jsonMode) out.json({ removed: false, dryRun: true, cache: shown });
    else out.hint(`dry run: would delete ${shown}`);
    return;
  }
  await confirmClean(ctx, shown);
  const { removedBytes } = await engine(app).cleanCache(ctx.paths);
  if (out.jsonMode) return out.json({ removed: true, cache: shown, removedBytes });
  out.mark('-', `${shown} (${formatBytes(removedBytes)})`);
  out.hint('sources stay declared; the next install fetches what it needs');
}
