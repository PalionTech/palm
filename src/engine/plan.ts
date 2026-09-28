/**
 * Planning an install (DESIGN §6 steps 2–6): each request is classified once, resolved to one
 * chosen entity (origin index, MCP registry, ad hoc definition, or the commit the lock names),
 * and composites are expanded into their members and dependencies. Nothing is written here.
 */
import { join } from 'node:path';
import { addOrigin } from '../core/config.js';
import { refreshOrigins } from '../core/context.js';
import { messageOf, PalmError } from '../core/errors.js';
import { hashPath, hashValue } from '../core/hash.js';
import type {
  Entity,
  InstallRequest,
  Kind,
  LockEntry,
  McpManifestEntry,
  McpServerConfig,
  OriginSpec,
  PalmContext,
  Scope,
} from '../core/types.js';
import { DepRef } from '../domain/dep-ref.js';
import { entityId, Via } from '../domain/entity-key.js';
import type { Lock } from '../domain/lock.js';
import { isSafeName } from '../lib/names.js';
import type { EngineDeps } from './deps.js';
import {
  agentDepSpecs,
  type Candidate,
  type CandidateSource,
  candidatesIn,
  type IndexSession,
  type SourcedIndex,
  suggestNames,
} from './query.js';

/**
 * An engine request: the public `InstallRequest`, or a replay of a lock entry (bare
 * `palm install` deploys the commit the lock names), optionally with the MCP config key the
 * manifest recorded for a registry server.
 */
export interface EngineRequest extends InstallRequest {
  /** Deploy exactly this lock entry's origin commit (`sha`), keeping its `ref`. */
  locked?: LockEntry;
  /** Registry servers: the config key palm.yaml recorded (`name:`), kept on reinstall. */
  mcpName?: string;
}

/**
 * A request classified once at the boundary: an ad hoc MCP definition, an MCP registry name,
 * a lock replay, or a dependency reference resolved against the origin indexes.
 */
type Planned =
  | { mode: 'adhoc'; config: McpServerConfig }
  | { mode: 'registry'; name: string; version?: string | undefined; key?: string | undefined }
  | { mode: 'replay'; locked: LockEntry }
  | IndexRequest;

interface IndexRequest {
  mode: 'index';
  kind?: Kind | undefined;
  dep: DepRef;
  /** Ad hoc origin for this request (unregistered). */
  from?: OriginSpec | undefined;
}

export function planned(req: EngineRequest): Planned {
  if (req.adhocMcp) return { mode: 'adhoc', config: req.adhocMcp };
  if (req.locked) return { mode: 'replay', locked: req.locked };
  const dep = DepRef.from(req.spec, req.kind);
  if (req.registry)
    return { mode: 'registry', name: req.registry, version: dep.ref, key: req.mcpName };
  return { mode: 'index', kind: req.kind, dep, from: req.from };
}

/** One entity to deploy: a chosen candidate, requested directly or reached through a plugin/agent. */
export interface PlanItem extends Candidate {
  direct: boolean;
  via?: string;
  manifestDep?: DepRef | McpManifestEntry;
  /** Dependency already installed another way: report unchanged, touch nothing. */
  keep?: LockEntry;
  /** Content hash, computed once (consent pre-pass, then deploy). */
  hash?: string;
  /** Read at the commit the lock names (lock replay); agent dependencies follow the lock too. */
  replay?: boolean;
}

/** Everything resolution needs; `claimed` holds MCP config keys (lower case) → owner. */
export interface ResolveContext {
  ctx: PalmContext;
  deps: EngineDeps;
  session: IndexSession;
  lock: Lock;
  warnings: string[];
  scope: Scope;
  /** Replays deploy the lock's commits; `frozen` never writes palm.yaml (alias registration). */
  frozen: boolean;
  claimed: Map<string, string>;
}

/** MCP config keys already taken in the lock: key (lower case) → registry name or `origin:<alias>`. */
export function claimedMcpKeys(lock: Lock): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of lock.entries)
    if (e.kind === 'mcp') out.set(e.name.toLowerCase(), mcpOwner(e.origin, e.path));
  return out;
}

function mcpOwner(origin: string, path: string): string {
  return origin === 'registry' ? `registry:${path}` : `origin:${origin}`;
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------

function lastSegment(name: string): string {
  return name.split('/').filter(Boolean).pop() ?? name;
}

/** `text` as a safe config key: invalid characters → `-`, no leading/trailing punctuation. */
function keyOf(text: string | undefined): string | undefined {
  const key = (text ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '');
  return key && isSafeName(key) ? key : undefined;
}

/**
 * The scoped config key of a registry server whose short key is taken by another server:
 * `<namespace label>-<short name>` (`@b/mcp` → `b-mcp`, `io.github.b/weather` → `b-weather`).
 */
export function scopedMcpKey(registryName: string): string | undefined {
  const slash = registryName.lastIndexOf('/');
  const short = keyOf(lastSegment(registryName));
  if (slash <= 0 || !short) return short;
  const label = registryName.slice(0, slash).split(/[./@]/).filter(Boolean).pop();
  return keyOf(`${label ?? ''}-${short}`) ?? short;
}

function synthesizeMcp(
  cfg: McpServerConfig,
  origin: 'adhoc' | 'registry',
  path: string,
  extra: { version?: string; description?: string } = {},
): Entity {
  const e: Entity = { kind: 'mcp', name: cfg.name, path, origin, def: { kind: 'mcp', mcp: cfg } };
  const description =
    extra.description ?? cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(' ');
  if (description) e.description = description;
  if (extra.version) e.version = extra.version;
  return e;
}

function mcpManifestEntry(cfg: McpServerConfig): McpManifestEntry {
  const out: McpManifestEntry = { name: cfg.name };
  if (cfg.transport) out.transport = cfg.transport;
  if (cfg.command) out.command = cfg.command;
  if (cfg.args?.length) out.args = cfg.args;
  if (cfg.env && Object.keys(cfg.env).length) out.env = cfg.env;
  if (cfg.url) out.url = cfg.url;
  if (cfg.headers && Object.keys(cfg.headers).length) out.headers = cfg.headers;
  return out;
}

/** Content hash recorded in the lock: file/dir bytes, or the canonical config for MCP servers. */
export async function contentHashOf(c: Candidate): Promise<string> {
  const e = c.entity;
  if (e.def.kind === 'mcp') {
    const { source: _source, ...cfg } = e.def.mcp;
    return hashValue(cfg);
  }
  const root = c.source.root;
  if (!root) return hashValue(e.def);
  // Symlinks are hashed like the deploy copies them: followed only inside the origin.
  const abs = join(root, e.path);
  if (e.def.kind === 'hook' && e.def.hooks.pluginRootRel) {
    return hashValue([
      await hashPath(abs, { boundary: root }),
      await hashPath(join(root, e.def.hooks.pluginRootRel), { boundary: root }),
    ]);
  }
  return hashPath(abs, { boundary: root });
}

/** The item's content hash, computed on first use and kept on the item. */
export async function itemHash(item: PlanItem): Promise<string> {
  item.hash ??= await contentHashOf(item);
  return item.hash;
}

// ---------------------------------------------------------------------------
// Choosing among candidates
// ---------------------------------------------------------------------------

function candidateLabel(c: Candidate): string {
  const e = c.entity;
  return [e.name, `(${e.kind})`, `@${e.origin}`, e.plugin ? `[${e.plugin}]` : '', e.version ?? '']
    .filter(Boolean)
    .join('  ');
}

function ambiguous(name: string, cands: Candidate[]): PalmError {
  const kinds = new Set(cands.map((c) => c.entity.kind));
  const forms = cands.map(
    (c) => `${kinds.size > 1 ? `${c.entity.kind} ` : ''}${c.entity.name}@${c.entity.origin}`,
  );
  return new PalmError(
    'E_AMBIGUOUS',
    `"${name}" matches ${cands.length} entities`,
    `use name@origin${kinds.size > 1 ? ' (and a kind word)' : ''}: ${forms.join(', ')}`,
  );
}

/** Pick one of several candidates: --yes for byte-identical ones, else the picker, else E_AMBIGUOUS. */
async function choose(ctx: PalmContext, name: string, cands: Candidate[]): Promise<Candidate> {
  const [first, ...rest] = cands;
  if (first && rest.length === 0) return first;
  const hashes = await Promise.all(
    cands.map((c, i) => contentHashOf(c).catch(() => `unhashable-${i}`)),
  );
  if (first && ctx.flags.yes && hashes.every((h) => h === hashes[0])) return first;
  if (!ctx.ui.isInteractive) throw ambiguous(name, cands);
  return ctx.ui.pick(
    `"${name}" is available from several places. Which one?`,
    cands.map((c) => ({
      value: c,
      label: candidateLabel(c),
      ...(c.entity.description ? { hint: c.entity.description } : {}),
    })),
  );
}

// ---------------------------------------------------------------------------
// Registry, ad hoc and index requests
// ---------------------------------------------------------------------------

async function registryCandidates(
  ctx: PalmContext,
  deps: EngineDeps,
  name: string,
  version?: string,
): Promise<Candidate[]> {
  if (ctx.flags.offline) {
    ctx.log.debug(`offline: not querying the MCP registry for ${name}`);
    return [];
  }
  const opts: { registryUrl?: string; version?: string } = {};
  if (ctx.config.mcpRegistryUrl) opts.registryUrl = ctx.config.mcpRegistryUrl;
  if (version) opts.version = version;
  const found = await deps.resolveRegistry(name, opts);
  return found.map((c) => {
    const key = keyOf(c.config.name) ?? keyOf(lastSegment(c.name)) ?? lastSegment(c.name);
    const cfg: McpServerConfig = { ...c.config, name: key };
    cfg.source = { type: 'registry', ref: c.name, ...(c.version ? { version: c.version } : {}) };
    const extra: { version?: string; description?: string } = {};
    if (c.version) extra.version = c.version;
    if (c.description) extra.description = c.description;
    const source: CandidateSource = {};
    if (ctx.config.mcpRegistryUrl) source.url = ctx.config.mcpRegistryUrl;
    if (c.version) source.ref = c.version;
    return { entity: synthesizeMcp(cfg, 'registry', c.name, extra), source };
  });
}

/** The candidate renamed to config key `key` (entity name and MCP config name). */
function renamedMcp(c: Candidate, key: string): Candidate {
  if (c.entity.def.kind !== 'mcp' || c.entity.name === key) return c;
  const mcp = { ...c.entity.def.mcp, name: key };
  return { ...c, entity: { ...c.entity, name: key, def: { kind: 'mcp', mcp } } };
}

/**
 * Scoped MCP names stay distinct: a registry server keeps the key palm.yaml recorded; else its
 * short key, unless another server (another registry name, or an origin's server) holds that
 * key, in which case the namespace-scoped key (`@b/mcp` → `b-mcp`) is used.
 */
function claimMcpKey(rc: ResolveContext, c: Candidate, wanted?: string): Candidate {
  const owner = mcpOwner(c.entity.origin, c.entity.path);
  const keyed = renamedMcp(c, keyOf(wanted) ?? c.entity.name);
  const taken = rc.claimed.get(keyed.entity.name.toLowerCase());
  const scoped = scopedMcpKey(c.entity.path);
  const out = taken && taken !== owner && !wanted && scoped ? renamedMcp(keyed, scoped) : keyed;
  rc.claimed.set(out.entity.name.toLowerCase(), owner);
  return out;
}

function manifestDepFor(entity: Entity, ref: string | undefined): DepRef | McpManifestEntry {
  if (entity.origin === 'registry') {
    // Only a version the user asked for is pinned, so `palm update` can move to newer releases.
    const dep: McpManifestEntry = { name: entity.name, registry: entity.path };
    if (ref) dep.version = ref;
    return dep;
  }
  if (entity.origin === 'adhoc' && entity.def.kind === 'mcp')
    return mcpManifestEntry(entity.def.mcp);
  return DepRef.of(entity.name, entity.origin, ref);
}

export interface IndexLookup {
  dep: DepRef;
  pool: SourcedIndex[];
  /** Origin alias the lookup was limited to (`--from` or `name@origin`). */
  scopedTo?: string;
  cands: Candidate[];
  /** Nothing indexed matches, but the MCP registry may know the name. */
  registryFallback: boolean;
}

/**
 * A `#ref` pins a git origin. A local directory has only what is on disk, so a ref there is
 * refused (E_USAGE) rather than ignored and then saved to palm.yaml.
 */
function assertRefable(spec: OriginSpec, req: IndexRequest): void {
  const { dep, from } = req;
  if (!dep.ref || spec.type === 'git') return;
  const bare = from ? `${dep.name} --from ${spec.path ?? spec.alias}` : `${dep.withRef(undefined)}`;
  throw new PalmError(
    'E_USAGE',
    `"${dep}": origin "${spec.alias}" is a local directory, which has no refs`,
    `drop "#${dep.ref}": palm install ${req.kind ? `${req.kind} ` : ''}${bare}`,
  );
}

/** Match a request against the origin indexes (DESIGN §6 steps 3–5, before any registry lookup). */
export async function lookupIndexed(
  session: IndexSession,
  req: IndexRequest,
): Promise<IndexLookup> {
  const { dep, from } = req;
  let pool: SourcedIndex[];
  let scopedTo: string | undefined;
  if (from) {
    assertRefable(from, req);
    pool = [await session.get(dep.ref ? { ...from, ref: dep.ref } : from)];
    scopedTo = from.alias;
  } else if (dep.origin) {
    const si = await session.byAlias(dep.origin, dep.ref);
    assertRefable(si.spec, req);
    pool = [si];
    scopedTo = dep.origin;
  } else {
    pool = await session.all();
  }
  const cands = candidatesIn(pool, req.kind, dep.name);
  const registryFallback =
    cands.length === 0 &&
    !scopedTo &&
    (req.kind === 'mcp' || (req.kind === undefined && dep.name.includes('/')));
  return { dep, pool, ...(scopedTo ? { scopedTo } : {}), cands, registryFallback };
}

export async function notFound(
  session: IndexSession,
  kind: Kind | undefined,
  lookup: Pick<IndexLookup, 'dep' | 'pool' | 'scopedTo'>,
): Promise<PalmError> {
  const { dep, scopedTo: origin } = lookup;
  const searched = origin ? lookup.pool : await session.all();
  const suggestions = suggestNames(searched, kind, dep.name);
  const hint: string[] = [];
  if (suggestions.length) hint.push(`Did you mean: ${suggestions.join(', ')}?`);
  hint.push(
    searched.length === 0 && !origin
      ? 'No origins are configured. Add one: palm install origin <owner/repo>'
      : 'Add an origin that provides it: palm install origin <owner/repo>',
  );
  return new PalmError(
    'E_NOT_FOUND',
    `No ${kind ?? 'entity'} named "${dep.name}"${origin ? ` in origin "${origin}"` : ' in any origin'}`,
    hint.join(' '),
  );
}

function adhocItem(rc: ResolveContext, config: McpServerConfig): PlanItem {
  const cfg: McpServerConfig = { ...config, source: { type: 'adhoc' } };
  const entity = synthesizeMcp(cfg, 'adhoc', cfg.name);
  rc.claimed.set(cfg.name.toLowerCase(), mcpOwner('adhoc', cfg.name));
  return { entity, source: {}, direct: true, manifestDep: mcpManifestEntry(cfg) };
}

async function registryItem(
  rc: ResolveContext,
  req: { name: string; version?: string | undefined; key?: string | undefined },
): Promise<PlanItem> {
  const cands = await registryCandidates(rc.ctx, rc.deps, req.name, req.version);
  if (!cands.length)
    throw new PalmError(
      'E_NOT_FOUND',
      `MCP registry has no server "${req.name}"${req.version ? ` at ${req.version}` : ''}`,
      'search it: palm search mcp <words>',
    );
  const chosen = claimMcpKey(rc, await choose(rc.ctx, req.name, cands), req.key);
  return { ...chosen, direct: true, manifestDep: manifestDepFor(chosen.entity, req.version) };
}

/** Index candidates, or registry candidates when only the MCP registry may know the name. */
async function indexCandidates(rc: ResolveContext, req: IndexRequest): Promise<IndexLookup> {
  const found = await lookupIndexed(rc.session, req);
  if (!found.registryFallback) return found;
  try {
    const cands = await registryCandidates(rc.ctx, rc.deps, found.dep.name, found.dep.ref);
    return { ...found, cands };
  } catch (e) {
    if (req.kind === 'mcp') throw e;
    rc.ctx.log.debug(`registry lookup for ${found.dep.name} failed: ${messageOf(e)}`);
    return found;
  }
}

async function indexItem(rc: ResolveContext, req: IndexRequest): Promise<PlanItem> {
  const found = await indexCandidates(rc, req);
  const { dep, scopedTo } = found;
  if (found.cands.length === 0) throw await notFound(rc.session, req.kind, found);
  let chosen = await choose(rc.ctx, dep.name, found.cands);
  if (chosen.entity.origin === 'registry') chosen = claimMcpKey(rc, chosen);
  // `name#ref` without an origin: re-read the chosen origin at that ref.
  if (dep.ref && !scopedTo && chosen.source.spec && chosen.entity.origin !== 'registry') {
    const at = await rc.session.get({ ...chosen.source.spec, ref: dep.ref });
    const again = candidatesIn([at], chosen.entity.kind, chosen.entity.name)[0];
    if (!again) {
      throw new PalmError(
        'E_NOT_FOUND',
        `${chosen.entity.kind} "${chosen.entity.name}" not found in origin "${chosen.entity.origin}" at ${dep.ref}`,
      );
    }
    chosen = again;
  }
  return { ...chosen, direct: true, manifestDep: manifestDepFor(chosen.entity, dep.ref) };
}

/**
 * The origin a lock entry came from. An alias this machine does not know is registered from the
 * lock's `url` (and `root`): as a project origin, saved to palm.yaml (only for this run under
 * --frozen or --dry-run), with a warning. At global scope that is E_ORIGIN naming the URL.
 */
async function lockedOrigin(rc: ResolveContext, locked: LockEntry): Promise<OriginSpec> {
  const known = rc.ctx.origins.byAlias(locked.origin)?.spec;
  if (known) return known;
  const { origin, url } = locked;
  if (!url)
    throw new PalmError(
      'E_ORIGIN',
      `Origin "${origin}" is not registered on this machine, and the lock has no URL for it`,
      `register it: palm install origin <owner/repo> --alias ${origin}`,
    );
  if (rc.scope === 'global')
    throw new PalmError(
      'E_ORIGIN',
      `Origin "${origin}" (${url}) is not registered on this machine`,
      `register it: palm install origin ${url} --alias ${origin} -g`,
    );
  const spec: OriginSpec = { alias: origin, type: 'git', url };
  if (locked.root) spec.root = locked.root;
  if (rc.frozen || rc.ctx.flags.dryRun) {
    refreshOrigins(rc.ctx, { project: [...rc.ctx.origins.projectSpecs(), spec] });
    rc.warnings.push(`origin "${origin}" is not registered here; using ${url} from the lock`);
    return spec;
  }
  const saved = await addOrigin(rc.ctx, spec, { scope: 'project' });
  rc.warnings.push(`origin "${origin}" was not registered here; added ${url} to palm.yaml`);
  return saved;
}

/** The entity a lock entry names, read from its origin at the locked commit. */
async function replayItem(rc: ResolveContext, locked: LockEntry): Promise<PlanItem> {
  const spec = await lockedOrigin(rc, locked);
  const si = await rc.session.get(locked.sha ? { ...spec, ref: locked.sha } : spec);
  const found = candidatesIn([si], locked.kind, locked.name)[0];
  if (!found) {
    throw new PalmError(
      'E_NOT_FOUND',
      `${locked.kind} "${locked.name}" is not in origin "${locked.origin}" at ${locked.sha?.slice(0, 12) ?? 'its current state'}`,
      `move it to what the origin has now: palm update ${locked.kind} ${locked.name}`,
    );
  }
  const source: CandidateSource = { ...found.source };
  delete source.ref;
  if (locked.ref) source.ref = locked.ref;
  if (locked.sha) source.sha = locked.sha;
  const manifestDep = manifestDepFor(found.entity, undefined);
  return { ...found, source, direct: true, manifestDep, replay: true };
}

/** Turn one request into a chosen entity (steps 3–5 of DESIGN §6). */
export async function resolveRequest(rc: ResolveContext, req: EngineRequest): Promise<PlanItem> {
  const p = planned(req);
  switch (p.mode) {
    case 'adhoc':
      return adhocItem(rc, p.config);
    case 'registry':
      return registryItem(rc, p);
    case 'replay':
      return replayItem(rc, p.locked);
    case 'index':
      return indexItem(rc, p);
  }
}

// ---------------------------------------------------------------------------
// Composite expansion (DESIGN §6 step 6)
// ---------------------------------------------------------------------------

type EntityKeyed = { kind: Kind; name: string };

/** The entity's lock entry when it is installed other than through `via` (keep that install). */
function installedElsewhere(lock: Lock, key: EntityKeyed, via: Via): LockEntry | undefined {
  return lock.findAll(key).find((e) => !via.is(e.via));
}

/** A plugin's members, from the plugin's own origin index. */
function pluginMembers(rc: ResolveContext, item: PlanItem): PlanItem[] {
  const e = item.entity;
  if (e.def.kind !== 'plugin') return [];
  const parent = Via.of(e);
  const pool = item.source.index?.entities ?? [];
  const out: PlanItem[] = [];
  for (const m of e.def.members) {
    const matches = pool.filter((x) => x.kind === m.kind && x.name === m.name);
    const member = matches.find((x) => x.plugin === e.name) ?? matches[0];
    if (!member) {
      rc.warnings.push(
        `plugin ${e.name} lists ${m.kind} "${m.name}", which its origin does not provide`,
      );
      continue;
    }
    const keep = installedElsewhere(rc.lock, member, parent);
    const via = parent.toString();
    out.push({
      entity: member,
      source: item.source,
      direct: false,
      via,
      ...(keep ? { keep } : {}),
    });
  }
  return out;
}

/** Minimal def for entries reported from the lock without an index lookup. */
function placeholderDef(kind: Kind): Entity['def'] {
  if (kind === 'mcp') return { kind: 'mcp', mcp: { name: '', transport: 'stdio' } };
  return { kind: 'skill', skill: { name: '', description: '' } };
}

function keptItem(keep: LockEntry, kind: Kind, via: string): PlanItem {
  const { name, path, origin } = keep;
  const entity: Entity = { kind, name, path, origin, def: placeholderDef(kind) };
  return { entity, source: {}, direct: false, via, keep };
}

/** An agent's skills, MCP servers and instructions not already `seen` in this plan. */
async function agentDeps(
  rc: ResolveContext,
  item: PlanItem,
  seen: Set<string>,
): Promise<PlanItem[]> {
  const e = item.entity;
  if (e.def.kind !== 'agent') return [];
  const parent = Via.of(e);
  const via = parent.toString();
  const out: PlanItem[] = [];
  for (const w of agentDepSpecs(e)) {
    const key = { kind: w.kind, name: w.dep.name };
    if (seen.has(entityId(key))) continue;
    const keep = installedElsewhere(rc.lock, key, parent);
    const chosen = keep ? undefined : await resolveAgentDep(rc, item, w);
    if (keep) out.push(keptItem(keep, w.kind, via));
    else if (chosen) out.push({ ...chosen, direct: false, via });
    else
      rc.warnings.push(
        `agent ${e.name} uses ${w.kind} "${w.dep.name}"${w.dep.origin ? ` from ${w.dep.origin}` : ''}, which no origin provides; install it separately`,
      );
  }
  return out;
}

/** Composite expansion: plugin → members, agent → skills/MCP servers/instructions. */
export async function expand(rc: ResolveContext, direct: PlanItem[]): Promise<PlanItem[]> {
  const plan: PlanItem[] = [];
  const seen = new Set<string>();
  const queue = [...direct];
  for (let item = queue.shift(); item; item = queue.shift()) {
    const key = entityId(item.entity);
    if (seen.has(key)) continue;
    seen.add(key);
    plan.push(item);
    if (item.keep) continue;
    queue.push(...pluginMembers(rc, item), ...(await agentDeps(rc, item, seen)));
  }
  return plan;
}

/** A dependency installed before from a git origin: read it again at that commit. */
async function lockedDep(
  rc: ResolveContext,
  prior: LockEntry | undefined,
): Promise<Candidate | undefined> {
  if (!prior?.sha || prior.origin === 'registry' || prior.origin === 'adhoc') return undefined;
  const spec = rc.ctx.origins.byAlias(prior.origin)?.spec;
  if (!spec) return undefined;
  const si = await rc.session.get({ ...spec, ref: prior.sha }).catch(() => undefined);
  const found = si ? candidatesIn([si], prior.kind, prior.name)[0] : undefined;
  if (!found) return undefined;
  const source = { ...found.source, sha: prior.sha };
  if (prior.ref) source.ref = prior.ref;
  return { ...found, source, replay: true } as Candidate;
}

/**
 * Resolve one agent dependency: an explicit `name@origin` from that origin only; otherwise
 * the agent's own origin first, then (replaying the lock) the commit an earlier install of this
 * dependency came from, else that earlier install's origin (so reinstalls never become
 * ambiguous), then every origin (picker on ambiguity).
 */
async function resolveAgentDep(
  rc: ResolveContext,
  agent: PlanItem,
  w: { kind: Kind; dep: DepRef },
): Promise<Candidate | undefined> {
  const { ctx, session } = rc;
  if (w.dep.origin) {
    const si = await session.byAlias(w.dep.origin, w.dep.ref).catch((err: unknown) => {
      ctx.log.debug(`agent dependency ${w.dep.name}@${w.dep.origin}: ${messageOf(err)}`);
      return undefined;
    });
    const cands = si ? candidatesIn([si], w.kind, w.dep.name) : [];
    return cands.length ? choose(ctx, w.dep.name, cands) : undefined;
  }
  const own =
    agent.source.index && agent.source.spec
      ? candidatesIn([{ spec: agent.source.spec, index: agent.source.index }], w.kind, w.dep.name)
      : [];
  if (own.length) return choose(ctx, w.dep.name, own);
  const prior = rc.lock.find({ kind: w.kind, name: w.dep.name });
  const replayed = agent.replay ? await lockedDep(rc, prior) : undefined;
  if (replayed) return replayed;
  const all = candidatesIn(await session.all(), w.kind, w.dep.name);
  const sticky = prior ? all.filter((c) => c.entity.origin === prior.origin) : [];
  const cands = sticky.length ? sticky : all;
  return cands.length ? choose(ctx, w.dep.name, cands) : undefined;
}
