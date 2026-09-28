import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { allOrigins, originId } from './config.js';
import { PalmError } from './errors.js';
import { fetchOrigin } from './git.js';
import { hashValue } from './hash.js';
import { cacheDir } from './paths.js';
import type {
  OriginCheckout,
  OriginIndex,
  OriginSpec,
  PalmContext,
  ScanOriginFn,
} from './types.js';

/** Bump when the shape of cached indexes changes. */
const INDEX_FORMAT = 1;

interface StoredIndex extends OriginIndex {
  cacheKey: string;
}

/**
 * `<palmHome>/cache/<originId>[@<ref>][~<layout hash>].index.json`. Two aliases of one repository
 * with different layout descriptors (or refs) share the checkout but never an index.
 */
export function indexFilePath(ctx: PalmContext, spec: OriginSpec): string {
  const ref = spec.type === 'git' ? spec.ref : undefined;
  const suffix = ref ? `@${ref.replace(/[^A-Za-z0-9._-]/g, '-')}` : '';
  const layout = spec.layout
    ? `~${hashValue(spec.layout)
        .replace(/^sha256:/, '')
        .slice(0, 8)}`
    : '';
  return join(cacheDir(ctx.paths), `${originId(spec)}${suffix}${layout}.index.json`);
}

function cacheKey(spec: OriginSpec, checkout: OriginCheckout): string {
  return hashValue({
    format: INDEX_FORMAT,
    sha: checkout.sha,
    root: spec.root ?? '',
    layout: spec.layout ?? null,
  });
}

/** Default scanner, loaded lazily so a missing module gives a clear error. */
export async function loadDefaultScan(): Promise<ScanOriginFn> {
  try {
    // biome-ignore lint/style/noRestrictedImports: known layer violation (core -> index); PLAN.md wave 2/3 inverts it by injecting the scanner.
    const mod = await import('../index/scan.js');
    return mod.scanOrigin;
  } catch (e) {
    throw new PalmError(
      'E_INTERNAL',
      `Scanner module unavailable (src/index/scan.ts): ${(e as Error).message}`,
    );
  }
}

function withAlias(index: OriginIndex, alias: string): OriginIndex {
  if (index.origin === alias && index.entities.every((e) => e.origin === alias)) return index;
  return {
    ...index,
    origin: alias,
    entities: index.entities.map((e) => ({ ...e, origin: alias })),
  };
}

/**
 * Fetch an origin (unless cached) and return its scanned index. Git origins
 * reuse `<originId>.index.json` while the checked-out sha is unchanged; local
 * origins are rescanned every time.
 */
export async function getIndex(
  ctx: PalmContext,
  spec: OriginSpec,
  opts: { refresh?: boolean; scan?: ScanOriginFn } = {},
): Promise<OriginIndex> {
  const checkout = await fetchOrigin(ctx, spec, { refresh: opts.refresh });
  const file = indexFilePath(ctx, spec);
  const key = cacheKey(spec, checkout);
  if (spec.type === 'git' && !opts.refresh) {
    try {
      const cached = JSON.parse(await readFile(file, 'utf8')) as StoredIndex;
      if (cached.cacheKey === key && Array.isArray(cached.entities)) {
        const { cacheKey: _k, ...index } = cached;
        return withAlias({ ...index, root: checkout.root }, spec.alias);
      }
    } catch {
      // no usable cache: scan below
    }
  }
  const scan = opts.scan ?? (await loadDefaultScan());
  // The scanner derives versions from a semver tag: give it the ref actually checked out.
  const result = await scan(
    checkout.root,
    checkout.ref && !spec.ref ? { ...spec, ref: checkout.ref } : spec,
  );
  const index: OriginIndex = {
    entities: result.entities.map((e) => ({ ...e, origin: spec.alias })),
    warnings: result.warnings ?? [],
    detected: result.detected,
    origin: spec.alias,
    originId: checkout.originId,
    root: checkout.root,
    scannedAt: new Date().toISOString(),
  };
  if (checkout.sha) index.sha = checkout.sha;
  if (checkout.ref) index.ref = checkout.ref;
  try {
    await mkdir(cacheDir(ctx.paths), { recursive: true });
    const stored: StoredIndex = { ...index, cacheKey: key };
    await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  } catch (e) {
    ctx.log.debug(`could not write index cache ${file}: ${(e as Error).message}`);
  }
  return index;
}

/** Indexes of every configured origin (config + project manifest). Failing origins are skipped with a warning. */
export async function getAllIndexes(
  ctx: PalmContext,
  opts: { refresh?: boolean; scan?: ScanOriginFn } = {},
): Promise<OriginIndex[]> {
  const results = await Promise.all(
    allOrigins(ctx).map(async (o) => {
      try {
        return await getIndex(ctx, o, opts);
      } catch (e) {
        ctx.log.warn(`Skipping origin "${o.alias}": ${(e as Error).message}`);
        return undefined;
      }
    }),
  );
  return results.filter((r): r is OriginIndex => !!r);
}

export async function invalidateIndex(ctx: PalmContext, spec: OriginSpec): Promise<void> {
  await rm(indexFilePath(ctx, spec), { force: true });
}
