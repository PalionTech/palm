/**
 * Rule 3 (DESIGN §5): a marketplace file. Every entry with a relative source is scanned as a
 * plugin at that path; remote entries are not fetched: a warning names the `palm install` line
 * that declares them.
 */

import { join, resolve } from 'node:path';
import { messageOf } from '../../core/errors.js';
import {
  describeEntrySource,
  installInput,
  type Marketplace,
  type MarketplaceEntry,
  readMarketplace,
  selfEntryPath,
} from '../marketplace.js';
import { findPluginManifest, type PluginManifest } from '../plugin-manifest.js';
import type { ScanContext } from '../scan-context.js';
import { escapesRoot, joinRel, normRel } from '../util.js';
import { scanPlugin } from './plugin-manifest.js';

/**
 * A path inside the repository as a path inside the scanned source: below the source's `root`
 * it is relative to it; the root itself (or above it) is the source root.
 */
function rebaseSelf(ctx: ScanContext, repoPath: string): string {
  const root = normRel(ctx.source.root ?? '');
  if (root === '') return repoPath;
  return repoPath.startsWith(`${root}/`) ? repoPath.slice(root.length + 1) : '';
}

/** A remote entry: never fetched; the warning names the line that declares it. */
function warnRemote(ctx: ScanContext, entry: MarketplaceEntry): void {
  const s = entry.source;
  const remote = installInput(s);
  if (!remote) {
    ctx.warnings.push(
      `plugin "${entry.name}": unsupported source ${describeEntrySource(s)}; skipped`,
    );
    return;
  }
  const root = remote.root ? `, then set root: ${remote.root} on it in palm.yaml` : '';
  ctx.warnings.push(
    `remote plugin "${entry.name}" (${describeEntrySource(s)}) not fetched: declare it: palm install ${remote.input} <names>${root}`,
  );
}

/** A source-relative plugin directory, checked: inside the source and present. */
async function localRoot(
  ctx: ScanContext,
  entry: MarketplaceEntry,
  rootRel: string,
): Promise<string | undefined> {
  const shown = describeEntrySource(entry.source);
  if (escapesRoot(rootRel)) {
    ctx.warnings.push(`plugin "${entry.name}": source ${shown} points outside the source; skipped`);
    return undefined;
  }
  if ((await ctx.fsKind(rootRel)) !== 'dir') {
    ctx.warnings.push(`plugin "${entry.name}": source directory ${shown} not found; skipped`);
    return undefined;
  }
  return rootRel;
}

/**
 * The source-relative plugin directory of an entry; undefined (with a warning) when unusable. An
 * entry that names the scanned repository itself is local (ruling C21).
 */
async function entryRoot(
  ctx: ScanContext,
  mpRootRel: string,
  entry: MarketplaceEntry,
): Promise<string | undefined> {
  const self = selfEntryPath(entry.source, ctx.source.url);
  if (self !== undefined) return localRoot(ctx, entry, rebaseSelf(ctx, self));
  if (entry.source.type !== 'local') {
    warnRemote(ctx, entry);
    return undefined;
  }
  return localRoot(ctx, entry, joinRel(mpRootRel, entry.source.path));
}

async function loadMarketplace(
  ctx: ScanContext,
  fileAbs: string,
): Promise<Marketplace | undefined> {
  try {
    return await readMarketplace(fileAbs);
  } catch (e) {
    ctx.warnings.push(`ignored marketplace: ${messageOf(e)}`);
    return undefined;
  }
}

/** Source-relative form of an absolute path inside the source. */
const sourceRel = (ctx: ScanContext, abs: string): string =>
  normRel(abs.slice(ctx.rootAbs.length + 1));

/**
 * Scan every local entry of the marketplace as a plugin (the root plugin too when no entry
 * covers it). Returns false when the marketplace file is unusable.
 */
export async function scanMarketplace(
  ctx: ScanContext,
  fileAbs: string,
  rootManifest: PluginManifest | undefined,
): Promise<boolean> {
  const mp = await loadMarketplace(ctx, fileAbs);
  if (!mp) return false;
  ctx.warnings.push(...mp.warnings);
  const marketplaceRel = sourceRel(ctx, fileAbs);
  const mpRootRel = sourceRel(ctx, resolve(mp.rootDir));
  let rootCovered = false;
  for (const entry of mp.entries) {
    const rootRel = await entryRoot(ctx, mpRootRel, entry);
    if (rootRel === undefined) continue;
    const manifest =
      rootRel === ''
        ? rootManifest
        : await findPluginManifest(join(ctx.rootAbs, rootRel), ctx.warnings, rootRel);
    if (rootRel === '') rootCovered = true;
    const sharedRoot = rootRel === mpRootRel;
    await scanPlugin(ctx, { rootRel, manifest, entry, sharedRoot, marketplaceRel });
  }
  if (!rootCovered && rootManifest) await scanPlugin(ctx, { rootRel: '', manifest: rootManifest });
  return true;
}
