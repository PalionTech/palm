/**
 * Origin resources: `palm install origin <spec>`, `palm uninstall origin <alias>...` and
 * `palm update origins [alias...]`. `get`/`describe` views live in origin-view.ts.
 */
import pc from 'picocolors';
import { isPalmError, messageOf, PalmError } from '../core/errors.js';
import { pluralize } from '../core/kinds.js';
import {
  type Entity,
  KINDS,
  type Kind,
  type LayoutDescriptor,
  type OriginIndex,
  type OriginSpec,
  type PalmContext,
} from '../core/types.js';
import type { Output } from '../ui/output.js';
import type { App } from './app.js';
import { ExitSignal, type Invocation, usage } from './grammar.js';
import { type GlobalOptions, makeContext, shortSha, withSpinner } from './shared.js';

export interface OriginCliOptions extends GlobalOptions {
  alias?: string;
  ref?: string;
  root?: string;
  project?: boolean;
  layout?: string[];
}

const LAYOUT_LIST_KEYS = [
  'skills',
  'agents',
  'commands',
  'instructions',
  'hooks',
  'mcp',
  'exclude',
  'include',
] as const;

const LAYOUT_HINT = `use kind=glob, kind one of: ${LAYOUT_LIST_KEYS.join(', ')}, or nameFrom=frontmatter|dirname`;

function layoutEntry(v: string): { key: string; val: string } {
  const eq = v.indexOf('=');
  const key = eq > 0 ? v.slice(0, eq).trim() : '';
  const val = eq > 0 ? v.slice(eq + 1).trim() : '';
  if (!key || !val) throw usage(`invalid --layout "${v}"`, LAYOUT_HINT);
  if (key === 'nameFrom' && val !== 'frontmatter' && val !== 'dirname')
    throw usage(`invalid --layout nameFrom=${val}`, 'use nameFrom=frontmatter or nameFrom=dirname');
  if (key !== 'nameFrom' && !(LAYOUT_LIST_KEYS as readonly string[]).includes(key))
    throw usage(`unknown --layout key "${key}"`, LAYOUT_HINT);
  return { key, val };
}

/** `--layout skills='skills/.curated/*' --layout exclude='**\/drafts/**' --layout nameFrom=dirname` → LayoutDescriptor. */
export function parseLayoutOptions(values: string[] | undefined): LayoutDescriptor | undefined {
  if (!values?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const v of values) {
    const { key, val } = layoutEntry(v);
    if (key === 'nameFrom') {
      out.nameFrom = val;
      continue;
    }
    const globs = val
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    out[key] = [...((out[key] as string[] | undefined) ?? []), ...globs];
  }
  return out as LayoutDescriptor;
}

/** Entity counts per kind of an index. */
export function countMap(entities: Pick<Entity, 'kind'>[]): Partial<Record<Kind, number>> {
  const out: Partial<Record<Kind, number>> = {};
  for (const e of entities) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

/** "12 skills, 3 agents" for the entities of an index. */
export function kindCounts(entities: Pick<Entity, 'kind'>[]): string {
  const counts = countMap(entities);
  const parts = KINDS.filter((k) => counts[k]).map((k) => {
    const n = counts[k] ?? 0;
    return `${n} ${pluralize(k, n)}`;
  });
  return parts.length ? parts.join(', ') : 'no entities';
}

export function describeLocation(spec: OriginSpec): string {
  const base = spec.type === 'local' ? (spec.path ?? '') : (spec.url ?? '');
  return spec.root ? `${base} ${pc.dim(`/${spec.root}`)}` : base;
}

/** Fetch and scan an origin (registered or not) into the cache, under a spinner. */
export async function indexOrigin(ctx: PalmContext, spec: OriginSpec): Promise<OriginIndex> {
  const { getIndex } = await import('../core/cache.js');
  return withSpinner(
    ctx,
    {
      message: `Fetching and indexing ${spec.alias}`,
      json: false,
      done: (ix) => `${spec.alias}: ${kindCounts(ix.entities)}`,
    },
    () => getIndex(ctx, spec, { refresh: true }),
  );
}

/** A runnable command that shows why fetching `spec` failed. */
function fetchHint(spec: OriginSpec, input: string): string {
  if (spec.type === 'local') return `check the directory: ls ${spec.path ?? input}`;
  return `check that it exists: git ls-remote ${spec.url ?? input}`;
}

const SPEC_HINT =
  'palm install origin owner/repo   (or owner/repo/sub/dir, a git URL, an existing directory)';

async function parseSpec(ctx: PalmContext, input: string, o: OriginCliOptions) {
  const { parseOriginInput } = await import('../core/config.js');
  const layout = parseLayoutOptions(o.layout);
  try {
    return parseOriginInput(input, {
      alias: o.alias,
      ref: o.ref,
      root: o.root,
      cwd: ctx.paths.cwd,
      ...(layout ? { layout } : {}),
    });
  } catch (e) {
    if (!isPalmError(e) || e.hint) throw e;
    throw new PalmError(e.code, e.message, SPEC_HINT);
  }
}

/** Fetch + index first; a failure saves nothing and names the command that shows why. */
async function indexBeforeSaving(
  ctx: PalmContext,
  spec: OriginSpec,
  input: string,
): Promise<OriginIndex> {
  try {
    return await indexOrigin(ctx, spec);
  } catch (e) {
    throw new PalmError(
      isPalmError(e) ? e.code : 'E_ORIGIN',
      `origin ${spec.alias} was not added: ${messageOf(e)}`,
      ctx.flags.offline
        ? `fetch it once online: palm install origin ${input}`
        : fetchHint(spec, input),
    );
  }
}

function reportAdded(out: Output, spec: OriginSpec, index: OriginIndex, dryRun: boolean): void {
  for (const w of index.warnings) out.warn(`${spec.alias}: ${w}`);
  if (out.jsonMode) {
    out.json({ origin: spec, counts: countMap(index.entities), detected: index.detected });
    return;
  }
  const summary = `${kindCounts(index.entities)}; detected: ${index.detected}`;
  const line = `origin ${pc.bold(spec.alias)} → ${describeLocation(spec)} (${summary})`;
  if (dryRun) out.hint(`dry run: would add ${line}`);
  else out.added(line);
  const example = index.entities[0];
  if (example)
    out.hint(`  install with: palm install ${example.kind} ${example.name}@${spec.alias}`);
}

async function installOne(ctx: PalmContext, out: Output, input: string, o: OriginCliOptions) {
  const spec = await parseSpec(ctx, input, o);
  const index = await indexBeforeSaving(ctx, spec, input);
  if (ctx.flags.dryRun) return reportAdded(out, spec, index, true);
  const { addOrigin } = await import('../core/config.js');
  const saved = await addOrigin(ctx, spec, { scope: o.project ? 'project' : 'global' });
  reportAdded(out, saved, index, false);
}

/**
 * `palm install origin <spec>...`: parse, fetch and index, and only then save (config.yaml, or
 * palm.yaml with --project). A marketplace.json (path or URL) adds each plugin it lists.
 */
export async function installOrigin(inv: Invocation, app: App): Promise<void> {
  const o = inv.opts as OriginCliOptions;
  if (inv.names.length === 0)
    throw usage('name the origin to install', 'palm install origin owner/repo');
  if (inv.names.length > 1 && (o.alias || o.ref || o.root || o.layout))
    throw usage(
      '--alias, --ref, --root and --layout apply to one origin at a time',
      `palm install origin ${inv.names[0]} --alias <alias>`,
    );
  const ctx = await makeContext(app, o);
  const { importMarketplace, isMarketplaceInput } = await import('./origin-marketplace.js');
  for (const input of inv.names) {
    if (inv.marketplace || (await isMarketplaceInput(ctx.paths.cwd, input)))
      await importMarketplace(ctx, app.out, { input, project: Boolean(o.project) });
    else await installOne(ctx, app.out, input, o);
  }
}

/** `palm uninstall origin <alias>...`: unregister (installed entities stay installed). */
export async function uninstallOrigin(inv: Invocation, app: App): Promise<void> {
  if (inv.names.length === 0)
    throw usage(
      'name the origin to remove',
      'palm get origins   then   palm uninstall origin <alias>',
    );
  const ctx = await makeContext(app, inv.opts as GlobalOptions);
  const { removeOrigin } = await import('../core/config.js');
  const removed: string[] = [];
  for (const alias of inv.names) {
    if (ctx.flags.dryRun) app.out.hint(`dry run: would remove origin ${alias}`);
    else {
      await removeOrigin(ctx, alias);
      app.out.removed(`origin ${alias}`);
    }
    removed.push(alias);
  }
  if (app.out.jsonMode) app.out.json({ removed, dryRun: ctx.flags.dryRun });
}

interface UpdateResult {
  alias: string;
  counts?: Partial<Record<Kind, number>>;
  sha?: string;
  error?: string;
}

async function updateOne(ctx: PalmContext, out: Output, spec: OriginSpec): Promise<UpdateResult> {
  try {
    const index = await indexOrigin(ctx, spec);
    for (const w of index.warnings) out.debug(`${spec.alias}: ${w}`);
    const at = index.sha ? pc.dim(` @ ${shortSha(index.sha)}`) : '';
    out.updated(`${pc.bold(spec.alias)}: ${kindCounts(index.entities)}${at}`);
    return { alias: spec.alias, counts: countMap(index.entities), sha: index.sha };
  } catch (e) {
    out.error(`${spec.alias}: ${messageOf(e)}`);
    return { alias: spec.alias, error: messageOf(e) };
  }
}

/** `palm update origins [alias...]`: refetch and rescan (all when none is named). */
export async function updateOrigins(inv: Invocation, app: App): Promise<void> {
  const ctx = await makeContext(app, inv.opts as GlobalOptions);
  const { allOrigins, resolveOriginQuery } = await import('../core/config.js');
  const specs = inv.names.length
    ? inv.names.map((q) => resolveOriginQuery(ctx, q))
    : allOrigins(ctx);
  if (specs.length === 0) {
    app.out.hint('No origins to update. Add one with: palm install origin owner/repo');
    if (app.out.jsonMode) app.out.json([]);
    return;
  }
  const results: UpdateResult[] = [];
  for (const spec of specs) results.push(await updateOne(ctx, app.out, spec));
  if (app.out.jsonMode) app.out.json(results);
  const failed = results.filter((r) => r.error);
  if (!failed.length) return;
  if (!app.out.jsonMode)
    app.out.error(
      `${failed.length} of ${results.length} origins failed to update: ${failed.map((f) => f.alias).join(', ')}`,
      `see why: palm describe origin ${failed[0]?.alias ?? '<alias>'}`,
    );
  throw new ExitSignal(1);
}
