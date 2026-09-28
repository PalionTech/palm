/** `palm get origins` and `palm describe origin <alias>`. */
import { join } from 'node:path';
import pc from 'picocolors';
import type { OriginIndex, OriginSpec, PalmContext } from '../core/types.js';
import type { Output } from '../ui/output.js';
import { usage } from './grammar.js';
import { countMap, describeLocation, indexOrigin, kindCounts } from './origin.js';
import { displayPath, shortSha } from './shared.js';

/** The cached index of an origin, without fetching (core/cache checks its shape and format). */
async function readCachedIndex(
  ctx: PalmContext,
  spec: OriginSpec,
): Promise<OriginIndex | undefined> {
  return (await import('../core/cache.js')).readCachedIndex(ctx, spec);
}

function scopeOfOrigin(ctx: PalmContext, spec: OriginSpec): 'global' | 'project' {
  return ctx.config.origins.some((s) => s.alias === spec.alias) ? 'global' : 'project';
}

function indexSummary(index: OriginIndex | undefined) {
  if (!index) return null;
  return {
    counts: countMap(index.entities),
    sha: index.sha,
    ref: index.ref,
    detected: index.detected,
    warnings: index.warnings,
    scannedAt: index.scannedAt,
  };
}

async function registered(ctx: PalmContext, names: string[]): Promise<OriginSpec[]> {
  const { allOrigins, resolveOriginQuery } = await import('../core/config.js');
  return names.length ? names.map((q) => resolveOriginQuery(ctx, q)) : allOrigins(ctx);
}

function printOriginTable(ctx: PalmContext, out: Output, rows: OriginRow[]): void {
  out.table(
    rows.map(({ spec, index }) => [
      spec.alias,
      spec.type,
      describeLocation(spec),
      spec.ref ?? (index?.ref ? pc.dim(index.ref) : ''),
      scopeOfOrigin(ctx, spec),
      index ? kindCounts(index.entities) : pc.dim('not indexed'),
    ]),
    ['alias', 'type', 'location', 'ref', 'scope', 'entities'],
  );
  if (!out.verbose) return;
  for (const { spec, index } of rows) {
    if (!index) continue;
    const sha = index.sha ? `, sha ${shortSha(index.sha)}` : '';
    out.out(
      `\n${pc.bold(spec.alias)} ${pc.dim(`detected: ${index.detected}${sha}, scanned ${index.scannedAt}`)}`,
    );
    for (const w of index.warnings) out.out(`  ${pc.yellow('!')} ${w}`);
  }
}

export interface OriginRow {
  spec: OriginSpec;
  index?: OriginIndex;
}

/** Registered origins (or the named ones) with their cached index, without fetching. */
export async function originRows(ctx: PalmContext, names: string[]): Promise<OriginRow[]> {
  const specs = await registered(ctx, names);
  return Promise.all(
    specs.map(async (spec) => ({ spec, index: await readCachedIndex(ctx, spec) })),
  );
}

export function originsJson(ctx: PalmContext, rows: OriginRow[]): unknown[] {
  return rows.map(({ spec, index }) => ({
    ...spec,
    scope: scopeOfOrigin(ctx, spec),
    indexed: indexSummary(index),
  }));
}

/** The origins table (`--verbose`: detection details and index warnings). */
export function printOrigins(ctx: PalmContext, out: Output, rows: OriginRow[]): void {
  if (rows.length === 0) {
    out.hint('No origins yet. Add one with: palm install origin owner/repo');
    return;
  }
  printOriginTable(ctx, out, rows);
}

/** `palm get origins [alias...]`: registered origins and what their cached index holds. */
export async function getOrigins(ctx: PalmContext, out: Output, names: string[]): Promise<void> {
  const rows = await originRows(ctx, names);
  if (out.jsonMode) out.json(originsJson(ctx, rows));
  else printOrigins(ctx, out, rows);
}

function row(out: Output, label: string, value: string | undefined): void {
  if (value) out.out(`  ${pc.dim(label.padEnd(12))}${value}`);
}

function layoutText(spec: OriginSpec): string {
  if (!spec.layout) return 'auto-detected';
  return Object.entries(spec.layout)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' ');
}

function checkoutDir(ctx: PalmContext, spec: OriginSpec, index?: OriginIndex): string | undefined {
  if (spec.type === 'local') return spec.path;
  if (!index) return undefined;
  return index.root ?? join(ctx.paths.palmHome, 'cache', index.originId);
}

async function loadIndex(ctx: PalmContext, spec: OriginSpec): Promise<OriginIndex | undefined> {
  const cached = await readCachedIndex(ctx, spec);
  if (cached || ctx.flags.offline) return cached;
  try {
    return await indexOrigin(ctx, spec);
  } catch (e) {
    ctx.log.warn(`${spec.alias} could not be indexed: ${(e as Error).message}`);
    return undefined;
  }
}

function printOrigin(ctx: PalmContext, out: Output, spec: OriginSpec, index?: OriginIndex) {
  out.out(`${pc.bold(`origin ${spec.alias}`)}  ${pc.dim(scopeOfOrigin(ctx, spec))}`);
  if (spec.description) out.out(`  ${spec.description}`);
  out.out();
  row(out, 'type', spec.type);
  row(out, spec.type === 'local' ? 'path' : 'url', spec.path ?? spec.url);
  row(out, 'ref', spec.ref ?? (index?.ref ? `${index.ref} ${pc.dim('(latest)')}` : undefined));
  row(out, 'sha', shortSha(index?.sha));
  row(out, 'root', spec.root);
  row(out, 'layout', layoutText(spec));
  row(out, 'detected', index?.detected ?? pc.dim('not indexed'));
  row(out, 'entities', index ? kindCounts(index.entities) : undefined);
  row(out, 'scanned', index?.scannedAt);
  for (const w of index?.warnings ?? []) out.out(`  ${pc.yellow('!')} ${w}`);
  const dir = checkoutDir(ctx, spec, index);
  row(out, 'checkout', dir ? displayPath(ctx, dir) : undefined);
}

/** `palm describe origin <alias>`: url, ref, sha, root, layout, detection, counts, cache paths. */
export async function describeOrigin(ctx: PalmContext, out: Output, names: string[]) {
  const [query, ...extra] = names;
  if (!query || extra.length)
    throw usage(
      'name one origin to describe',
      'palm get origins   then   palm describe origin <alias>',
    );
  const { resolveOriginQuery } = await import('../core/config.js');
  const { indexFilePath } = await import('../core/cache.js');
  const spec = resolveOriginQuery(ctx, query);
  const index = await loadIndex(ctx, spec);
  const indexFile = indexFilePath(ctx, spec);
  if (out.jsonMode) {
    const cache = { index: indexFile, checkout: checkoutDir(ctx, spec, index) ?? null };
    out.json({ origin: spec, scope: scopeOfOrigin(ctx, spec), index: indexSummary(index), cache });
    return;
  }
  printOrigin(ctx, out, spec, index);
  row(out, 'index file', displayPath(ctx, indexFile));
}
