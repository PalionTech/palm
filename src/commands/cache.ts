/**
 * `palm cache info` and `palm cache clean`: the checkouts and indexes under $PALM_HOME/cache.
 * Cleaning keeps every origin registered; the next command that needs one fetches it again.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import pc from 'picocolors';
import { PalmError } from '../core/errors.js';
import type { PalmContext } from '../core/types.js';
import { pathExists } from '../lib/fs.js';
import type { App } from './app.js';
import { dirSize, formatBytes } from './disk.js';
import type { Invocation } from './grammar.js';
import { displayPath, type GlobalOptions, makeContext } from './shared.js';

export interface CacheInfo {
  path: string;
  exists: boolean;
  bytes: number;
  /** Directories: one per origin repository (holding one checkout per ref). */
  checkouts: number;
  /** `*.index.json` files: one per origin, ref and layout. */
  indexes: number;
}

export function cacheDirOf(ctx: PalmContext): string {
  return join(ctx.paths.palmHome, 'cache');
}

export async function cacheInfo(dir: string): Promise<CacheInfo> {
  if (!(await pathExists(dir)))
    return { path: dir, exists: false, bytes: 0, checkouts: 0, indexes: 0 };
  const entries = await readdir(dir, { withFileTypes: true });
  return {
    path: dir,
    exists: true,
    bytes: await dirSize(dir),
    checkouts: entries.filter((e) => e.isDirectory()).length,
    indexes: entries.filter((e) => e.isFile() && e.name.endsWith('.index.json')).length,
  };
}

async function info(ctx: PalmContext, app: App): Promise<void> {
  const i = await cacheInfo(cacheDirOf(ctx));
  const out = app.out;
  if (out.jsonMode) return out.json(i);
  const row = (label: string, value: string) => out.out(`  ${pc.dim(label.padEnd(12))}${value}`);
  out.out(pc.bold('cache'));
  row('path', displayPath(ctx, i.path));
  row('size', i.exists ? formatBytes(i.bytes) : pc.dim('empty'));
  row('checkouts', String(i.checkouts));
  row('indexes', String(i.indexes));
  if (i.exists && i.bytes > 0) out.hint('\nfree the space with: palm cache clean --yes');
}

async function confirmClean(ctx: PalmContext, i: CacheInfo): Promise<void> {
  if (ctx.flags.yes) return;
  if (!ctx.ui.isInteractive)
    throw new PalmError(
      'E_NON_INTERACTIVE',
      'palm cache clean removes every checkout and index; confirm with --yes',
      'palm cache clean --yes',
    );
  const ok = await ctx.ui.confirm(
    `Remove ${i.checkouts} checkouts and ${i.indexes} indexes (${formatBytes(i.bytes)})?`,
    false,
  );
  if (!ok) throw new PalmError('E_CANCELLED', 'cancelled');
}

async function clean(ctx: PalmContext, app: App): Promise<void> {
  const i = await cacheInfo(cacheDirOf(ctx));
  const out = app.out;
  if (!i.exists || (i.checkouts === 0 && i.indexes === 0 && i.bytes === 0)) {
    if (out.jsonMode) out.json({ removed: false, ...i });
    else out.hint('The cache is already empty.');
    return;
  }
  if (ctx.flags.dryRun) {
    if (out.jsonMode) out.json({ removed: false, dryRun: true, ...i });
    else out.hint(`dry run: would remove ${displayPath(ctx, i.path)} (${formatBytes(i.bytes)})`);
    return;
  }
  await confirmClean(ctx, i);
  await rm(i.path, { recursive: true, force: true });
  if (out.jsonMode) return out.json({ removed: true, ...i });
  out.removed(
    `${i.checkouts} checkouts and ${i.indexes} indexes (${formatBytes(i.bytes)}) from ${displayPath(ctx, i.path)}`,
  );
  out.hint('origins stay registered; the next command that needs one fetches it again');
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const ctx = await makeContext(app, inv.opts as GlobalOptions);
  if (inv.command === 'cache clean') return clean(ctx, app);
  return info(ctx, app);
}
