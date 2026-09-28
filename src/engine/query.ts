import { getIndex } from '../core/cache.js';
import { allOrigins, findOrigin, originId } from '../core/config.js';
import { messageOf, PalmError } from '../core/errors.js';
import type {
  Entity,
  EntityRef,
  Kind,
  LockEntry,
  OriginIndex,
  OriginSpec,
  PalmContext,
  Scope,
} from '../core/types.js';
import { DepRef } from '../domain/dep-ref.js';
import { Lock } from '../domain/lock.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { type EngineDeps, resolveEngineDeps } from './deps.js';

// ---------------------------------------------------------------------------
// Shared helpers (also used by install/update)
// ---------------------------------------------------------------------------

export interface SourcedIndex {
  spec: OriginSpec;
  index: OriginIndex;
}

/** Where a candidate entity lives. Absent `index` = synthesized (registry / ad hoc MCP). */
export interface CandidateSource {
  spec?: OriginSpec;
  index?: OriginIndex;
  /** Absolute origin root on disk. */
  root?: string;
  url?: string;
  ref?: string;
  sha?: string;
}

export interface Candidate {
  entity: Entity;
  source: CandidateSource;
}

/** Memoizes origin indexes for the duration of one engine operation. */
export class IndexSession {
  private readonly one = new Map<string, Promise<SourcedIndex>>();
  private allP?: Promise<SourcedIndex[]>;

  constructor(
    private readonly ctx: PalmContext,
    private readonly scan: EngineDeps['scan'],
    private readonly refresh = false,
  ) {}

  get(spec: OriginSpec): Promise<SourcedIndex> {
    const key = `${spec.alias}\0${originId(spec)}\0${spec.ref ?? ''}`;
    let p = this.one.get(key);
    if (!p) {
      p = getIndex(this.ctx, spec, { refresh: this.refresh, scan: this.scan }).then((index) => ({
        spec,
        index,
      }));
      this.one.set(key, p);
    }
    return p;
  }

  /** A registered origin by alias; throws E_ORIGIN when unknown. */
  byAlias(alias: string, ref?: string): Promise<SourcedIndex> {
    const spec = findOrigin(this.ctx, alias);
    if (!spec) {
      const known = allOrigins(this.ctx).map((o) => o.alias);
      throw new PalmError(
        'E_ORIGIN',
        `Unknown origin "${alias}"`,
        known.length
          ? `Known origins: ${known.join(', ')}. Add one: palm install origin <owner/repo>`
          : 'Add one: palm install origin <owner/repo>',
      );
    }
    return this.get(ref ? { ...spec, ref } : spec);
  }

  all(): Promise<SourcedIndex[]> {
    this.allP ??= Promise.all(
      allOrigins(this.ctx).map((o) =>
        this.get(o).catch((e: unknown) => {
          this.ctx.log.warn(`Skipping origin "${o.alias}": ${messageOf(e)}`);
          return undefined;
        }),
      ),
    ).then((r) => r.filter((x): x is SourcedIndex => !!x));
    return this.allP;
  }
}

function sourceOf(si: SourcedIndex): CandidateSource {
  const s: CandidateSource = { spec: si.spec, index: si.index, root: si.index.root };
  if (si.spec.type === 'git' && si.spec.url) s.url = si.spec.url;
  if (si.index.ref) s.ref = si.index.ref;
  if (si.index.sha) s.sha = si.index.sha;
  return s;
}

export function candidatesIn(
  pool: SourcedIndex[],
  kind: Kind | undefined,
  name: string,
): Candidate[] {
  const lower = name.toLowerCase();
  const out: Candidate[] = [];
  for (const si of pool) {
    for (const e of si.index.entities) {
      if ((kind === undefined || e.kind === kind) && e.name.toLowerCase() === lower)
        out.push({ entity: e, source: sourceOf(si) });
    }
  }
  return out;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      prev[j] = Math.min(tmp + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

/** How close `name` is to the query `q` (lower-cased): edit distance, 0–1 for substrings; undefined when far. */
function closeness(q: string, name: string): number | undefined {
  const n = name.toLowerCase();
  const d = levenshtein(q, n);
  const sub = n.includes(q) || q.includes(n);
  if (sub) return Math.min(d, 1);
  return d <= 3 ? d : undefined;
}

/** Up to `limit` names close to `name` (edit distance ≤ 3 or substring). */
export function suggestNames(
  pool: SourcedIndex[],
  kind: Kind | undefined,
  name: string,
  limit = 5,
): string[] {
  const q = name.toLowerCase();
  const scored = new Map<string, number>();
  const entities = pool.flatMap((si) => si.index.entities);
  for (const e of entities) {
    const score = kind === undefined || e.kind === kind ? closeness(q, e.name) : undefined;
    const label = `${e.name}@${e.origin}`;
    if (score !== undefined && (scored.get(label) ?? Number.POSITIVE_INFINITY) > score)
      scored.set(label, score);
  }
  return [...scored.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([l]) => l);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listInstalled(
  ctx: PalmContext,
  scope: Scope,
  kind?: Kind,
): Promise<LockEntry[]> {
  const { entries } = await Lock.load(ScopePaths.of(ctx, scope).lockFile);
  return kind ? entries.filter((e) => e.kind === kind) : entries;
}

/** What a user names on the command line: kind (optional), name, origin (optional). */
export interface EntityQuery {
  kind?: Kind | undefined;
  name: string;
  origin?: string | undefined;
}

/** E_NOT_FOUND for a query that names nothing installed in the scope, with the command that lists what is. */
export function notInstalled(q: EntityQuery, scope: Scope): PalmError {
  const what = q.kind ? `${q.kind} "${q.name}"` : `"${q.name}"`;
  const from = q.origin ? ` from ${q.origin}` : '';
  const where = scope === 'global' ? 'globally' : 'in this project';
  const list = `palm get${q.kind ? ` ${q.kind}s` : ''}${scope === 'global' ? ' -g' : ''}`;
  return new PalmError(
    'E_NOT_FOUND',
    `${what}${from} is not installed ${where}`,
    `see what is installed: ${list}${scope === 'global' ? '' : ' (add -g for global installs)'}`,
  );
}

async function poolFor(
  session: IndexSession,
  opts: { origin?: string; from?: OriginSpec },
): Promise<SourcedIndex[]> {
  if (opts.from) return [await session.get(opts.from)];
  if (opts.origin) return [await session.byAlias(opts.origin)];
  return session.all();
}

export async function findCandidates(
  ctx: PalmContext,
  query: { kind?: Kind | undefined; name: string },
  opts: { origin?: string; from?: OriginSpec; refresh?: boolean },
  deps?: Partial<EngineDeps>,
): Promise<Entity[]> {
  const d = await resolveEngineDeps(deps);
  const session = new IndexSession(ctx, d.scan, !!opts.refresh);
  return candidatesIn(await poolFor(session, opts), query.kind, query.name).map((c) => c.entity);
}

function scoreEntity(e: Entity, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const n = e.name.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.includes(q)) return 60;
  if (e.description?.toLowerCase().includes(q)) return 40;
  return 0;
}

export async function searchIndex(
  ctx: PalmContext,
  query: string,
  opts: { kind?: Kind; origin?: string; refresh?: boolean },
  deps?: Partial<EngineDeps>,
): Promise<Array<{ entity: Entity; score: number }>> {
  const d = await resolveEngineDeps(deps);
  const session = new IndexSession(ctx, d.scan, !!opts.refresh);
  const pool = await poolFor(session, { origin: opts.origin });
  const hits: Array<{ entity: Entity; score: number }> = [];
  for (const si of pool) {
    for (const entity of si.index.entities) {
      if (opts.kind && entity.kind !== opts.kind) continue;
      const score = scoreEntity(entity, query);
      if (score > 0) hits.push({ entity, score });
    }
  }
  return hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.entity.name.localeCompare(b.entity.name) ||
      a.entity.origin.localeCompare(b.entity.origin),
  );
}

/** An agent's declared dependencies as `name[@origin][#ref]` specs: skills, MCP servers, instructions. */
export function agentDepSpecs(entity: Entity): Array<{ kind: Kind; dep: DepRef }> {
  if (entity.def.kind !== 'agent') return [];
  const a = entity.def.agent;
  const out: Array<{ kind: Kind; dep: DepRef }> = [];
  const add = (kind: Kind, specs: string[] | undefined): void => {
    for (const spec of specs ?? []) {
      try {
        out.push({ kind, dep: DepRef.parse(spec) });
      } catch {
        // an empty entry: nothing to depend on
      }
    }
  };
  add('skill', a.skills);
  add('mcp', a.mcpServers);
  add('instruction', a.instructions);
  return out;
}

/** Direct dependencies of an entity (plugin members; agent skills, MCP servers and instructions). */
export function entityDeps(entity: Entity): EntityRef[] {
  if (entity.def.kind === 'plugin')
    return entity.def.members.map((m) => ({ kind: m.kind, name: m.name }));
  return agentDepSpecs(entity).map((d) => ({ kind: d.kind, name: d.dep.name }));
}

/** Scanner warnings about an entity whose name is taken twice in one origin (the first copy is indexed). */
export function duplicateWarnings(
  index: Pick<OriginIndex, 'warnings'>,
  kind: Kind | undefined,
  name?: string,
): string[] {
  return index.warnings.filter((w) => {
    const m = /^duplicate (\w+) "([^"]+)"/.exec(w);
    return (
      !!m &&
      (!kind || m[1] === kind) &&
      (name === undefined || m[2]?.toLowerCase() === name.toLowerCase())
    );
  });
}

export interface EntityInfo {
  entity?: Entity;
  lock?: LockEntry;
  deps: EntityRef[];
  warnings: string[];
}

/** The indexed entity the query names (first origin that has it) and its duplicate-name warnings. */
async function indexedEntity(
  ctx: PalmContext,
  query: { kind: Kind; name: string; origin?: string | undefined },
  deps: Partial<EngineDeps> | undefined,
): Promise<{ entity?: Entity; warnings: string[] }> {
  const d = await resolveEngineDeps(deps);
  const session = new IndexSession(ctx, d.scan);
  const pool = await poolFor(session, query.origin ? { origin: query.origin } : {});
  const first = candidatesIn(pool, query.kind, query.name)[0];
  if (!first) return { warnings: [] };
  const warnings = first.source.index
    ? duplicateWarnings(first.source.index, query.kind, first.entity.name)
    : [];
  return { entity: first.entity, warnings };
}

export async function getEntityInfo(
  ctx: PalmContext,
  query: { kind: Kind; name: string },
  opts: { origin?: string | undefined; scope: Scope },
  deps?: Partial<EngineDeps>,
): Promise<EntityInfo> {
  const { kind, name } = query;
  const installed = await Lock.load(ScopePaths.of(ctx, opts.scope).lockFile);
  const lock =
    installed.find({ kind, name }, opts.origin) ??
    installed.select({ kind, name, origin: opts.origin })[0];
  const origin =
    opts.origin ??
    (lock && lock.origin !== 'registry' && lock.origin !== 'adhoc' ? lock.origin : undefined);
  let found: { entity?: Entity; warnings: string[] } = { warnings: [] };
  try {
    found = await indexedEntity(ctx, { kind, name: lock?.name ?? name, origin }, deps);
  } catch (e) {
    if (!lock) throw e;
    ctx.log.debug(`index lookup for ${kind} ${name} failed: ${messageOf(e)}`);
  }
  const { entity, warnings } = found;
  const depRefs = entity ? entityDeps(entity) : (lock?.deps ?? []);
  return { ...(entity ? { entity } : {}), ...(lock ? { lock } : {}), deps: depRefs, warnings };
}
