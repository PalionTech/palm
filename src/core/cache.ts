/**
 * The index cache (DESIGN.md section 5 "Index"): a source's scan result stored beside its
 * checkouts, keyed by the commit (git) or tree hash (local) plus the layout. The scanner is
 * always injected, so core never imports the index layer.
 */
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SourceRef } from '../domain/source.js';
import { pathExists, readJsonFile, walkFiles, writeJsonFile } from '../lib/fs.js';
import { isRecord } from '../lib/object.js';
import { messageOf } from './errors.js';
import { hashValue } from './hash.js';
import type {
  EngineDeps,
  PalmContext,
  PalmPaths,
  Source,
  SourceCheckout,
  SourceIndex,
} from './types.js';

/**
 * Bump when the shape of cached indexes changes: older files are then a cache miss and rescanned
 * once. 3: entities carry `source` (not `origin`), references and closures; commands are skills.
 */
export const INDEX_FORMAT = 3;

/** `$PALM_HOME/cache`: checkouts and index files; safe to delete. */
export function cacheDir(paths: PalmPaths): string {
  return join(paths.palmHome, 'cache');
}

/** Creates the cache directory with mode 0700 (DESIGN.md section 8), fixing the mode if it exists. */
export async function ensureCacheDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

interface StoredIndex extends SourceIndex {
  format: number;
  cacheKey: string;
}

/** Every entity at least names its kind, name, path and definition. */
function hasEntityShape(e: unknown): boolean {
  return (
    isRecord(e) &&
    typeof e.kind === 'string' &&
    typeof e.name === 'string' &&
    typeof e.path === 'string' &&
    isRecord(e.def)
  );
}

/** Cheap shape check of a cache file (a truncated, hand-edited or older file is a miss). */
function isStoredIndex(v: unknown): v is StoredIndex {
  if (!isRecord(v) || v.format !== INDEX_FORMAT || typeof v.cacheKey !== 'string') return false;
  if (!Array.isArray(v.warnings) || typeof v.detected !== 'string') return false;
  return Array.isArray(v.entities) && v.entities.every(hasEntityShape);
}

/** The cached index at `file` when it is well-formed (and, given a `key`, was written for it). */
async function readStoredIndex(file: string, key?: string): Promise<SourceIndex | undefined> {
  try {
    const cached: unknown = await readJsonFile<unknown>(file);
    if (!isStoredIndex(cached) || (key !== undefined && cached.cacheKey !== key)) return undefined;
    const { cacheKey: _k, format: _f, ...index } = cached;
    return index;
  } catch {
    return undefined; // missing or unreadable: scan
  }
}

/** `index` under the source name `name` (two names for one location share the cache file). */
function withName(index: SourceIndex, name: string): SourceIndex {
  if (index.source === name && index.entities.every((e) => e.source === name)) return index;
  return { ...index, source: name, entities: index.entities.map((e) => ({ ...e, source: name })) };
}

function cacheKeyOf(checkout: SourceCheckout): string {
  const { source } = checkout;
  return hashValue({
    format: INDEX_FORMAT,
    version: checkout.sha ?? checkout.tree ?? '',
    root: source.root ?? '',
    layout: source.layout ?? null,
  });
}

/** The source the scanner sees: its versions come from the tag actually checked out. */
function scanInput(checkout: SourceCheckout): Source {
  const { source } = checkout;
  return checkout.ref && checkout.ref !== source.ref ? { ...source, ref: checkout.ref } : source;
}

/**
 * The scanned index of a checkout (`fetchSource`), cached as
 * `<cache>/<sourceId>@<sha8 or tree8>[~<layout8>].index.json`. A cache file is used when its
 * shape and key check out (not with `refresh`); anything else is rescanned once with `scan`.
 */
export async function getIndex(
  ctx: PalmContext,
  checkout: SourceCheckout,
  opts: { scan: EngineDeps['scan']; refresh?: boolean },
): Promise<SourceIndex> {
  const ref = SourceRef.of(checkout.source);
  const version = checkout.sha ?? checkout.tree;
  const file = version ? ref.indexFile(cacheDir(ctx.paths), version) : undefined;
  const key = cacheKeyOf(checkout);
  const cached = file && !opts.refresh ? await readStoredIndex(file, key) : undefined;
  if (cached) return withName({ ...cached, root: checkout.root }, ref.name);
  const result = await opts.scan(checkout.root, scanInput(checkout));
  const index: SourceIndex = {
    entities: result.entities.map((e) => ({ ...e, source: ref.name })),
    warnings: result.warnings ?? [],
    detected: result.detected,
    source: ref.name,
    sourceId: checkout.sourceId,
    root: checkout.root,
  };
  if (checkout.sha) index.sha = checkout.sha;
  if (checkout.ref) index.ref = checkout.ref;
  if (checkout.tree) index.tree = checkout.tree;
  if (file) await storeIndex(ctx, file, { ...index, format: INDEX_FORMAT, cacheKey: key });
  return index;
}

async function storeIndex(ctx: PalmContext, file: string, stored: StoredIndex): Promise<void> {
  try {
    await ensureCacheDir(cacheDir(ctx.paths));
    await writeJsonFile(file, stored);
  } catch (e) {
    ctx.log.debug(`could not write index cache ${file}: ${messageOf(e)}`);
  }
}

/**
 * The index cached for `source` at `version` (a sha or tree hash), without fetching or scanning
 * (`palm get sources`, `describe source`). Undefined when absent or not of this format.
 */
export async function readCachedIndex(
  ctx: PalmContext,
  source: SourceRef,
  version: string,
): Promise<SourceIndex | undefined> {
  const index = await readStoredIndex(source.indexFile(cacheDir(ctx.paths), version));
  return index && withName(index, source.name);
}

/** Removes `$PALM_HOME/cache` (sources stay declared); reports how many bytes it held. */
export async function cleanCache(paths: PalmPaths): Promise<{ removedBytes: number }> {
  const dir = cacheDir(paths);
  if (!(await pathExists(dir))) return { removedBytes: 0 };
  const { files } = await walkFiles(dir);
  const removedBytes = files.reduce((n, f) => n + f.size, 0);
  await rm(dir, { recursive: true, force: true });
  return { removedBytes };
}
