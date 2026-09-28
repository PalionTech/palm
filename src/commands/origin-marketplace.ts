/**
 * `palm install origin <marketplace.json | directory | URL>` (and the hidden old
 * `palm origin import`): every plugin a marketplace lists becomes an origin. Each is fetched and
 * indexed before it is saved. Reading, downloading and expanding the marketplace is
 * src/index/marketplace.ts; this module picks the entries and saves them.
 */
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { messageOf, PalmError } from '../core/errors.js';
import type { OriginIndex, OriginSpec, PalmContext } from '../core/types.js';
import type { Output } from '../ui/output.js';
import { describeLocation, indexOrigin, kindCounts } from './origin.js';

/** Directory a marketplace file's relative sources resolve against (index/marketplace `marketplaceRootFor`). */
export { marketplaceRootFor as marketplaceRootDir } from '../index/marketplace.js';

const HTTP_URL = /^https?:\/\//i;

/**
 * For a marketplace.json URL, the raw download URL plus the repo it belongs to.
 * GitHub `blob/<ref>/…` and raw.githubusercontent.com URLs map to `https://github.com/<o>/<r>.git` at `<ref>`.
 */
export function marketplaceUrlBase(url: string): {
  rawUrl: string;
  base: { url?: string; ref?: string };
  relPath: string;
} {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.hostname === 'github.com' && parts[2] === 'blob' && parts.length >= 5) {
    const [owner, repo, , ref, ...rest] = parts;
    return {
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join('/')}`,
      base: { url: `https://github.com/${owner}/${repo}.git`, ref },
      relPath: rest.join('/'),
    };
  }
  if (u.hostname === 'raw.githubusercontent.com' && parts.length >= 4) {
    const [owner, repo, ref, ...rest] = parts;
    return {
      rawUrl: url,
      base: { url: `https://github.com/${owner}/${repo}.git`, ref },
      relPath: rest.join('/'),
    };
  }
  return { rawUrl: url, base: {}, relPath: u.pathname.split('/').pop() || 'marketplace.json' };
}

/**
 * Whether an origin spec is a marketplace: a `marketplace.json` path or URL by name, or a local
 * `.json` file whose content has a `plugins` array.
 */
export async function isMarketplaceInput(cwd: string, input: string): Promise<boolean> {
  if (/marketplace\.json$/i.test(input)) return true;
  if (!/\.json$/i.test(input)) return false;
  if (HTTP_URL.test(input)) return true;
  const { readMarketplace } = await import('../index/marketplace.js');
  return readMarketplace(resolve(cwd, input)).then(
    () => true,
    () => false,
  );
}

/**
 * What to hand to `parseMarketplace`: the raw URL of a remote marketplace (index/marketplace
 * downloads it and derives the repository, ref and root from GitHub URLs), or the local file,
 * found under a directory when a directory is given.
 */
async function marketplaceSource(ctx: PalmContext, input: string): Promise<string> {
  if (HTTP_URL.test(input)) {
    if (ctx.flags.offline)
      throw new PalmError(
        'E_NETWORK',
        'cannot download a marketplace file with --offline',
        `run it online: palm install origin ${input}`,
      );
    return marketplaceUrlBase(input).rawUrl;
  }
  const abs = resolve(ctx.paths.cwd, input);
  const st = await stat(abs).catch(() => undefined);
  if (!st)
    throw new PalmError('E_NOT_FOUND', `no such file or directory: ${abs}`, `ls ${dirname(abs)}`);
  if (!st.isDirectory()) return abs;
  const { findMarketplaceFile } = await import('../index/marketplace.js');
  const found = await findMarketplaceFile(abs);
  if (found) return found;
  throw new PalmError(
    'E_NOT_FOUND',
    `no marketplace.json under ${abs}`,
    `point at the file: palm install origin ${join(input, '.claude-plugin', 'marketplace.json')}`,
  );
}

async function chooseEntries(ctx: PalmContext, origins: OriginSpec[]): Promise<OriginSpec[]> {
  if (!ctx.ui.isInteractive || ctx.flags.yes) return origins;
  return ctx.ui.pickMany(
    `Add which of the ${origins.length} marketplace entries as origins?`,
    origins.map((o) => ({
      value: o,
      label: o.alias,
      hint: [o.url ?? o.path, o.root, o.ref && `#${o.ref}`].filter(Boolean).join(' '),
    })),
    origins,
  );
}

interface ImportResult {
  added: Array<{ spec: OriginSpec; counts: string }>;
  existing: Array<{ spec: OriginSpec; as: string }>;
  skipped: Array<{ spec: OriginSpec; error: string }>;
}

/** Fetch and index each new entry, then save it; entries that cannot be indexed are skipped. */
async function addEntries(
  ctx: PalmContext,
  chosen: OriginSpec[],
  project: boolean,
): Promise<ImportResult> {
  const { addOrigin, allOrigins, originId } = await import('../core/config.js');
  const same = (a: OriginSpec, b: OriginSpec): boolean =>
    originId(a) === originId(b) && (a.ref ?? '') === (b.ref ?? '');
  const result: ImportResult = { added: [], existing: [], skipped: [] };
  for (const spec of chosen) {
    const known = allOrigins(ctx).find((o) => same(o, spec));
    if (known) {
      result.existing.push({ spec, as: known.alias });
      continue;
    }
    try {
      const index: OriginIndex = await indexOrigin(ctx, spec);
      const saved = ctx.flags.dryRun
        ? spec
        : await addOrigin(ctx, spec, { scope: project ? 'project' : 'global' });
      result.added.push({ spec: saved, counts: kindCounts(index.entities) });
    } catch (e) {
      result.skipped.push({ spec, error: messageOf(e) });
    }
  }
  return result;
}

function printImport(out: Output, r: ImportResult, dryRun: boolean): void {
  if (out.jsonMode) {
    out.json({
      added: r.added.map((a) => a.spec),
      existing: r.existing.map((x) => ({ alias: x.spec.alias, registeredAs: x.as })),
      skipped: r.skipped.map((s) => ({ alias: s.spec.alias, error: s.error })),
    });
    return;
  }
  if (r.added.length)
    out.table(
      r.added.map((a) => [a.spec.alias, describeLocation(a.spec), a.spec.ref ?? '', a.counts]),
      ['alias', 'location', 'ref', 'entities'],
    );
  for (const x of r.existing) out.unchanged(`${x.spec.alias}: already registered as ${x.as}`);
  for (const s of r.skipped) out.warn(`skipped ${s.spec.alias}: ${s.error}`);
  const n = r.added.length;
  const also = r.existing.length ? `, ${r.existing.length} already registered` : '';
  if (dryRun) out.hint(`\ndry run: would add ${n} origin${n === 1 ? '' : 's'}${also}`);
  else out.added(`${n} origin${n === 1 ? '' : 's'}${also}`);
}

/** Add the plugins a marketplace lists as origins (file, directory or URL). */
export async function importMarketplace(
  ctx: PalmContext,
  out: Output,
  opts: { input: string; project: boolean },
): Promise<void> {
  const source = await marketplaceSource(ctx, opts.input);
  const { parseMarketplace } = await import('../index/marketplace.js');
  const { origins, warnings } = await parseMarketplace(source, {});
  for (const w of warnings) out.warn(w);
  if (origins.length === 0) {
    out.warn('the marketplace lists no plugins palm can add');
    if (out.jsonMode) out.json({ added: [], existing: [], skipped: [] });
    return;
  }
  const result = await addEntries(ctx, await chooseEntries(ctx, origins), opts.project);
  printImport(out, result, ctx.flags.dryRun);
  if (!out.jsonMode && result.added.length) out.hint('list them with: palm get origins');
}
