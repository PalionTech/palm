import { getIndex } from '../core/cache.js';
import { allOrigins, findOrigin, originId } from '../core/config.js';
import { messageOf, PalmError } from '../core/errors.js';
import { findEntry, loadLock } from '../core/lockfile.js';
import { parseDepRef } from '../core/manifest.js';
import { lockPath } from '../core/paths.js';
import type {
  DepRef,
  Entity,
  EntityRef,
  Kind,
  LockEntry,
  OriginIndex,
  OriginSpec,
  PalmContext,
  ScanOriginFn,
  Scope,
} from '../core/types.js';
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
    private readonly scan: ScanOriginFn,
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
          ? `Known origins: ${known.join(', ')}. Add one with \`palm origin add <owner/repo>\`.`
          : 'Add one with `palm origin add <owner/repo>`.',
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

export function sourceOf(si: SourcedIndex): CandidateSource {
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
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
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
  for (const si of pool) {
    for (const e of si.index.entities) {
      if (kind !== undefined && e.kind !== kind) continue;
      const n = e.name.toLowerCase();
      const d = levenshtein(q, n);
      const sub = n.includes(q) || q.includes(n);
      if (d <= 3 || sub) {
        const label = `${e.name}@${e.origin}`;
        const score = sub ? Math.min(d, 1) : d;
        if (!scored.has(label) || scored.get(label)! > score) scored.set(label, score);
      }
    }
  }
  return [...scored.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([l]) => l);
}

export function nameMatchesEntry(e: LockEntry, name: string): boolean {
  const lower = name.toLowerCase();
  return (
    e.name.toLowerCase() === lower ||
    (e.kind === 'mcp' && e.origin === 'registry' && e.path.toLowerCase() === lower)
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listInstalled(
  ctx: PalmContext,
  scope: Scope,
  kind?: Kind,
): Promise<LockEntry[]> {
  const lock = await loadLock(lockPath(ctx.paths, scope));
  return kind ? lock.entries.filter((e) => e.kind === kind) : lock.entries;
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
  kind: Kind | undefined,
  name: string,
  opts: { origin?: string; from?: OriginSpec; refresh?: boolean },
  deps?: Partial<EngineDeps>,
): Promise<Entity[]> {
  const d = await resolveEngineDeps(deps);
  const session = new IndexSession(ctx, d.scan, !!opts.refresh);
  return candidatesIn(await poolFor(session, opts), kind, name).map((c) => c.entity);
}

export function scoreEntity(e: Entity, query: string): number {
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
        out.push({ kind, dep: parseDepRef(spec) });
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
      (name === undefined || m[2]!.toLowerCase() === name.toLowerCase())
    );
  });
}

export async function getEntityInfo(
  ctx: PalmContext,
  kind: Kind,
  name: string,
  opts: { origin?: string; scope: Scope },
  deps?: Partial<EngineDeps>,
): Promise<{ entity?: Entity; lock?: LockEntry; deps: EntityRef[]; warnings: string[] }> {
  const lockFile = await loadLock(lockPath(ctx.paths, opts.scope));
  const lock =
    findEntry(lockFile, kind, name, opts.origin) ??
    lockFile.entries.find(
      (e) =>
        e.kind === kind && nameMatchesEntry(e, name) && (!opts.origin || e.origin === opts.origin),
    );
  const origin =
    opts.origin ??
    (lock && lock.origin !== 'registry' && lock.origin !== 'adhoc' ? lock.origin : undefined);
  let entity: Entity | undefined;
  const warnings: string[] = [];
  try {
    const d = await resolveEngineDeps(deps);
    const session = new IndexSession(ctx, d.scan);
    const cands = candidatesIn(await poolFor(session, { origin }), kind, lock?.name ?? name);
    const first = cands[0];
    entity = first?.entity;
    if (first?.source.index)
      warnings.push(...duplicateWarnings(first.source.index, kind, first.entity.name));
  } catch (e) {
    if (!lock) throw e;
    ctx.log.debug(`index lookup for ${kind} ${name} failed: ${messageOf(e)}`);
  }
  const depRefs = entity ? entityDeps(entity) : (lock?.deps ?? []);
  return { ...(entity ? { entity } : {}), ...(lock ? { lock } : {}), deps: depRefs, warnings };
}
