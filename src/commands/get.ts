/**
 * `palm get [kind] [names...]` (aliases `list`, `ls`): installed entities (from the lock),
 * `--available` what the origins offer, `get origins`, `get targets` and `get all`.
 */
import pc from 'picocolors';
import { PalmError } from '../core/errors.js';
import { pluralize } from '../core/kinds.js';
import type {
  Entity,
  Kind,
  LockEntry,
  OriginIndex,
  OriginSpec,
  PalmContext,
  Scope,
} from '../core/types.js';
import { type Output, truncate } from '../ui/output.js';
import type { App } from './app.js';
import type { Invocation } from './grammar.js';
import { getOrigins, originRows, originsJson, printOrigins } from './origin-view.js';
import {
  entityKind,
  type GlobalOptions,
  makeContext,
  scopeOf,
  shortSha,
  withSpinner,
} from './shared.js';
import { getTargets, printTargets, targetsView } from './targets.js';

interface GetOptions extends GlobalOptions {
  available?: boolean;
  origin?: string;
}

/** `-o` values of the installed view for entries that came from palm's own pseudo-origins. */
export const PSEUDO_ORIGINS = ['mine', 'registry', 'adhoc'] as const;

export function lockVersion(e: LockEntry): string {
  if (e.ref && e.sha) return `${e.ref} ${pc.dim(`(${shortSha(e.sha)})`)}`;
  return e.ref ?? shortSha(e.sha);
}

const byKindName = (a: { kind: string; name: string }, b: { kind: string; name: string }): number =>
  a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);

/** Installed entries of one kind, one origin alias (the lock's `origin`) and/or some names, sorted. */
export function filterInstalled(
  entries: LockEntry[],
  opts: { kind?: Kind; origin?: string; names?: string[] } = {},
): LockEntry[] {
  const origin = opts.origin?.toLowerCase();
  const names = opts.names?.length ? new Set(opts.names.map((n) => n.toLowerCase())) : undefined;
  return entries
    .filter(
      (e) =>
        (!opts.kind || e.kind === opts.kind) &&
        (!origin || e.origin.toLowerCase() === origin) &&
        (!names || names.has(e.name.toLowerCase())),
    )
    .sort(byKindName);
}

/**
 * The lock alias `-o <query>` selects in the installed view: `mine`, `registry` and `adhoc` as is,
 * else the registered origin `resolve` finds; an origin removed after installing still matches its
 * entries by alias.
 */
export function installedOriginAlias(
  query: string,
  entries: LockEntry[],
  resolve: (query: string) => OriginSpec,
): string {
  const q = query.trim().toLowerCase();
  if ((PSEUDO_ORIGINS as readonly string[]).includes(q)) return q;
  try {
    return resolve(query).alias;
  } catch (e) {
    if (
      e instanceof PalmError &&
      e.code === 'E_NOT_FOUND' &&
      entries.some((x) => x.origin.toLowerCase() === q)
    )
      return q;
    throw e;
  }
}

export interface AvailableGroup {
  origin: string;
  entities: Entity[];
  duplicates: string[];
}

/** One group per origin index (optionally only `origin`), entities of `kind` sorted by kind and name. */
export function availableGroups(
  indexes: OriginIndex[],
  opts: {
    kind?: Kind;
    origin?: string;
    names?: string[];
    duplicates?: (ix: OriginIndex, kind?: Kind) => string[];
  } = {},
): AvailableGroup[] {
  const origin = opts.origin?.toLowerCase();
  const names = opts.names?.length ? new Set(opts.names.map((n) => n.toLowerCase())) : undefined;
  const keep = (e: Entity) =>
    (!opts.kind || e.kind === opts.kind) && (!names || names.has(e.name.toLowerCase()));
  return indexes
    .filter((ix) => !origin || ix.origin.toLowerCase() === origin)
    .map((ix) => ({
      origin: ix.origin,
      entities: ix.entities.filter(keep).sort(byKindName),
      duplicates: opts.duplicates ? opts.duplicates(ix, opts.kind) : [],
    }));
}

interface EntityQuery {
  kind?: Kind;
  origin?: string;
  names: string[];
  scope: Scope;
}

async function loadIndexes(
  ctx: PalmContext,
  q: EntityQuery,
): Promise<{ indexes: OriginIndex[]; only?: OriginSpec }> {
  const cache = await import('../core/cache.js');
  const { scanOrigin: scan } = await import('../index/scan.js');
  if (!q.origin) {
    const indexes = await withSpinner(ctx, { message: 'Reading origin indexes' }, () =>
      cache.getAllIndexes(ctx, { scan }),
    );
    return { indexes };
  }
  const only = ctx.origins.resolveQuery(q.origin).spec;
  const index = await withSpinner(ctx, { message: `Reading the ${only.alias} index` }, () =>
    cache.getIndex(ctx, only, { scan }),
  );
  return { indexes: [index], only };
}

function printAvailable(out: Output, groups: AvailableGroup[], empty: string): void {
  const nonEmpty = groups.filter((gr) => gr.entities.length > 0);
  if (nonEmpty.length === 0) {
    out.hint(empty);
    return;
  }
  nonEmpty.forEach((gr, i) => {
    if (i > 0) out.out();
    out.out(`${pc.bold(gr.origin)} ${pc.dim(`(${gr.entities.length})`)}`);
    out.table(
      gr.entities.map((e) => [e.kind, e.name, e.version ?? '', truncate(e.description, 70)]),
      ['kind', 'name', 'version', 'description'],
    );
    for (const w of gr.duplicates) out.warn(`${gr.origin}: ${w}`);
  });
}

/** `palm get [kind] --available [-o origin]`: what the origins offer, grouped by origin. */
async function getAvailable(ctx: PalmContext, out: Output, q: EntityQuery): Promise<void> {
  const { indexes, only } = await loadIndexes(ctx, q);
  const { duplicateWarnings } = await import('../engine/query.js');
  const groups = availableGroups(indexes, {
    kind: q.kind,
    origin: only?.alias,
    names: q.names,
    duplicates: duplicateWarnings,
  });
  if (out.jsonMode) return out.json(groups);
  const what = q.kind ? pluralize(q.kind, 2) : 'entities';
  printAvailable(
    out,
    groups,
    only
      ? `No ${what} available in origin ${only.alias}.`
      : `No ${what} available. Add an origin with: palm install origin owner/repo`,
  );
}

async function installedEntries(ctx: PalmContext, q: EntityQuery): Promise<LockEntry[]> {
  const { listInstalled } = await import('../engine/query.js');
  const installed = await listInstalled(ctx, q.scope, q.kind);
  let origin: string | undefined;
  if (q.origin) {
    origin = installedOriginAlias(q.origin, installed, (s) => ctx.origins.resolveQuery(s).spec);
  }
  return filterInstalled(installed, { kind: q.kind, origin, names: q.names });
}

function printInstalled(out: Output, entries: LockEntry[], empty: string): void {
  if (entries.length === 0) {
    out.hint(empty);
    return;
  }
  out.table(
    entries.map((e) => [
      e.kind,
      e.name,
      e.origin,
      lockVersion(e),
      e.targets.join(','),
      e.via ?? '',
    ]),
    ['kind', 'name', 'origin', 'version', 'targets', 'via'],
  );
}

/** E_NOT_FOUND (exit 1) when a name the user gave matches no installed entry, as describe/why do. */
async function assertNamedInstalled(entries: LockEntry[], q: EntityQuery): Promise<void> {
  const found = new Set(entries.map((e) => e.name.toLowerCase()));
  const missing = q.names.find((n) => !found.has(n.toLowerCase()));
  if (missing === undefined) return;
  const { notInstalled } = await import('../engine/query.js');
  throw notInstalled({ kind: q.kind, name: missing, origin: q.origin }, q.scope);
}

/** `palm get [kind] [names...]`: what is installed in the scope (from the lockfile). */
async function getInstalled(ctx: PalmContext, out: Output, q: EntityQuery): Promise<void> {
  const entries = await installedEntries(ctx, q);
  await assertNamedInstalled(entries, q);
  if (out.jsonMode) return out.json(entries);
  const what = q.kind ? pluralize(q.kind, 2) : 'entities';
  const from = q.origin ? ` from origin ${q.origin}` : '';
  printInstalled(
    out,
    entries,
    `No ${what} installed in the ${q.scope} scope${from}. Find some with: palm get ${q.kind ?? 'skill'}s --available`,
  );
}

/** `palm get all`: installed entities, origins and targets of the scope. */
async function getAll(ctx: PalmContext, out: Output, o: GetOptions): Promise<void> {
  const scope = scopeOf(o);
  const installed = await installedEntries(ctx, { names: [], scope });
  const origins = await originRows(ctx, []);
  const targets = await targetsView(ctx, { scope, target: o.target, names: [] });
  if (out.jsonMode) {
    out.json({ installed, origins: originsJson(ctx, origins, out.verbose), targets });
    return;
  }
  out.out(pc.bold('Installed'));
  printInstalled(out, installed, `Nothing installed in the ${scope} scope.`);
  out.out(`\n${pc.bold('Origins')}`);
  printOrigins(ctx, out, origins);
  out.out(`\n${pc.bold('Targets')}`);
  printTargets(ctx, out, targets);
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const o = inv.opts as GetOptions;
  const scope = scopeOf(o);
  const interactive = inv.resource === 'target' ? false : undefined;
  const kind =
    inv.resource === 'origin' || inv.resource === 'target' || inv.resource === 'all'
      ? undefined
      : entityKind(inv.resource, 'get');
  const ctx = await makeContext(app, o, { interactive });
  if (inv.resource === 'origin') return getOrigins(ctx, app.out, inv.names);
  if (inv.resource === 'target')
    return getTargets(ctx, app.out, { scope, target: o.target, names: inv.names });
  if (inv.resource === 'all') return getAll(ctx, app.out, o);
  const q: EntityQuery = { kind, origin: o.origin, names: inv.names, scope };
  return o.available ? getAvailable(ctx, app.out, q) : getInstalled(ctx, app.out, q);
}
