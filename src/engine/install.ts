import { join } from 'node:path';
import { messageOf, PalmError } from '../core/errors.js';
import { hashPath, hashValue } from '../core/hash.js';
import {
  type DeployInput,
  type Entity,
  type InstallOptions,
  type InstallOutcome,
  type InstallRequest,
  type InstallResult,
  type Kind,
  type LockEntry,
  type McpManifestEntry,
  type McpServerConfig,
  type MergedRecord,
  type OriginSpec,
  type PalmContext,
  type SecretPolicy,
  TARGET_IDS,
  type TargetId,
} from '../core/types.js';
import { DepRef } from '../domain/dep-ref.js';
import { entityId, isViaKind, lockId, Via } from '../domain/entity-key.js';
import { Lock } from '../domain/lock.js';
import { Manifest } from '../domain/manifest.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { optionalSecretNames } from '../domain/secrets.js';
import { deepEqual } from '../lib/object.js';
import { type EngineDeps, resolveEngineDeps } from './deps.js';
import {
  agentDepSpecs,
  type Candidate,
  type CandidateSource,
  candidatesIn,
  entityDeps,
  IndexSession,
  type SourcedIndex,
  suggestNames,
} from './query.js';
import { undeployEntries } from './uninstall.js';

/**
 * An install request, classified once at the boundary (`InstallRequest` encodes the three
 * modes as optional fields): an ad hoc MCP definition, an MCP registry name, or a
 * dependency reference resolved against the origin indexes.
 */
type Planned =
  | { mode: 'adhoc'; config: McpServerConfig }
  | { mode: 'registry'; name: string; version?: string | undefined }
  | IndexRequest;

interface IndexRequest {
  mode: 'index';
  kind?: Kind | undefined;
  dep: DepRef;
  /** Ad hoc origin for this request (unregistered). */
  from?: OriginSpec | undefined;
}

function planned(req: InstallRequest): Planned {
  if (req.adhocMcp) return { mode: 'adhoc', config: req.adhocMcp };
  const dep = DepRef.from(req.spec);
  if (req.registry) return { mode: 'registry', name: req.registry, version: dep.ref };
  return { mode: 'index', kind: req.kind, dep, from: req.from };
}

/** One entity to deploy: a chosen candidate, requested directly or reached through a plugin/agent. */
interface PlanItem extends Candidate {
  direct: boolean;
  via?: string;
  manifestDep?: DepRef | McpManifestEntry;
  /** Dependency already installed another way: report unchanged, touch nothing. */
  keep?: LockEntry;
}

const nowIso = (): string => new Date().toISOString();

/**
 * One outcome per kind+name+origin. When an entity shows up twice (installed directly and
 * reached again as a plugin/agent dependency), the more informative outcome wins: anything
 * over a plain `unchanged`, otherwise the first.
 */
export function dedupeOutcomes(outcomes: InstallOutcome[]): InstallOutcome[] {
  const byKey = new Map<string, InstallOutcome>();
  for (const o of outcomes) {
    const key = lockId(o.entry);
    const prev = byKey.get(key);
    if (!prev || (prev.status === 'unchanged' && o.status !== 'unchanged')) byKey.set(key, o);
  }
  return [...byKey.values()];
}

/** A target's "MCP x: export A, B in the environment …" note whose variables the engine already listed. */
function coveredExportNote(note: string, exported: Set<string>): boolean {
  const m = /^MCP \S+: export (.+) in the environment /.exec(note);
  const vars = m?.[1];
  return !!vars && vars.split(', ').every((v) => exported.has(v));
}

function orderTargets(ids: Iterable<TargetId>): TargetId[] {
  const set = new Set(ids);
  return TARGET_IDS.filter((t) => set.has(t));
}

export function defaultSecretPolicy(
  ctx: PalmContext,
  scope: InstallOptions['scope'],
  override?: SecretPolicy,
): SecretPolicy {
  return override ?? ctx.config.secrets?.[scope] ?? (scope === 'global' ? 'literal' : 'env-ref');
}

function lastSegment(name: string): string {
  return name.split('/').filter(Boolean).pop() ?? name;
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

export function mcpManifestEntry(cfg: McpServerConfig): McpManifestEntry {
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

function candidateLabel(c: Candidate): string {
  const e = c.entity;
  return [e.name, `(${e.kind})`, `@${e.origin}`, e.plugin ? `[${e.plugin}]` : '', e.version ?? '']
    .filter(Boolean)
    .join('  ');
}

/** Pick one of several candidates: --yes for byte-identical ones, else the picker, else E_AMBIGUOUS. */
async function choose(ctx: PalmContext, name: string, cands: Candidate[]): Promise<Candidate> {
  const [first, ...rest] = cands;
  if (first && rest.length === 0) return first;
  const hashes = await Promise.all(
    cands.map((c, i) => contentHashOf(c).catch(() => `unhashable-${i}`)),
  );
  if (first && ctx.flags.yes && hashes.every((h) => h === hashes[0])) return first;
  if (!ctx.ui.isInteractive) {
    const kinds = new Set(cands.map((c) => c.entity.kind));
    const forms = cands.map(
      (c) => `${kinds.size > 1 ? `${c.entity.kind} ` : ''}${c.entity.name}@${c.entity.origin}`,
    );
    throw new PalmError(
      'E_AMBIGUOUS',
      `"${name}" matches ${cands.length} entities`,
      `use name@origin${kinds.size > 1 ? ' (and a kind word)' : ''}: ${forms.join(', ')}`,
    );
  }
  return ctx.ui.pick(
    `"${name}" is available from several places. Which one?`,
    cands.map((c) => {
      const opt: { value: Candidate; label: string; hint?: string } = {
        value: c,
        label: candidateLabel(c),
      };
      if (c.entity.description) opt.hint = c.entity.description;
      return opt;
    }),
  );
}

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
    const cfg: McpServerConfig = { ...c.config, name: c.config.name || lastSegment(c.name) };
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

async function notFound(
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
      ? 'No origins are configured. Add one: palm origin add <owner/repo>'
      : 'Add an origin that provides it: palm origin add <owner/repo>',
  );
  return new PalmError(
    'E_NOT_FOUND',
    `No ${kind ?? 'entity'} named "${dep.name}"${origin ? ` in origin "${origin}"` : ' in any origin'}`,
    hint.join(' '),
  );
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

interface IndexLookup {
  dep: DepRef;
  pool: SourcedIndex[];
  /** Origin alias the lookup was limited to (`--from` or `name@origin`). */
  scopedTo?: string;
  cands: Candidate[];
  /** Nothing indexed matches, but the MCP registry may know the name. */
  registryFallback: boolean;
}

/** Match a request against the origin indexes (DESIGN §6 steps 3–5, before any registry lookup). */
async function lookupIndexed(session: IndexSession, req: IndexRequest): Promise<IndexLookup> {
  const { dep, from } = req;
  let pool: SourcedIndex[];
  let scopedTo: string | undefined;
  if (from) {
    pool = [await session.get(dep.ref ? { ...from, ref: dep.ref } : from)];
    scopedTo = from.alias;
  } else if (dep.origin) {
    pool = [await session.byAlias(dep.origin, dep.ref)];
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

function adhocItem(config: McpServerConfig): PlanItem {
  const cfg: McpServerConfig = { ...config, source: { type: 'adhoc' } };
  const entity = synthesizeMcp(cfg, 'adhoc', cfg.name);
  return { entity, source: {}, direct: true, manifestDep: mcpManifestEntry(cfg) };
}

async function registryItem(
  ctx: PalmContext,
  deps: EngineDeps,
  req: { name: string; version?: string | undefined },
): Promise<PlanItem> {
  const cands = await registryCandidates(ctx, deps, req.name, req.version);
  if (!cands.length)
    throw new PalmError(
      'E_NOT_FOUND',
      `MCP registry has no server "${req.name}"${req.version ? ` at ${req.version}` : ''}`,
    );
  const chosen = await choose(ctx, req.name, cands);
  return { ...chosen, direct: true, manifestDep: manifestDepFor(chosen.entity, req.version) };
}

async function indexItem(
  ctx: PalmContext,
  deps: EngineDeps,
  session: IndexSession,
  req: IndexRequest,
): Promise<PlanItem> {
  const found = await lookupIndexed(session, req);
  const { dep, scopedTo } = found;
  let cands = found.cands;
  if (found.registryFallback) {
    try {
      cands = await registryCandidates(ctx, deps, dep.name, dep.ref);
    } catch (e) {
      if (req.kind === 'mcp') throw e;
      ctx.log.debug(`registry lookup for ${dep.name} failed: ${messageOf(e)}`);
    }
  }
  if (cands.length === 0) throw await notFound(session, req.kind, found);

  let chosen = await choose(ctx, dep.name, cands);
  // `name#ref` without an origin: re-read the chosen origin at that ref.
  if (dep.ref && !scopedTo && chosen.source.spec && chosen.entity.origin !== 'registry') {
    const at = await session.get({ ...chosen.source.spec, ref: dep.ref });
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

/** Turn one request into a chosen entity (steps 3–5 of DESIGN §6). */
async function resolveRequest(
  ctx: PalmContext,
  deps: EngineDeps,
  session: IndexSession,
  req: Planned,
): Promise<PlanItem> {
  switch (req.mode) {
    case 'adhoc':
      return adhocItem(req.config);
    case 'registry':
      return registryItem(ctx, deps, req);
    case 'index':
      return indexItem(ctx, deps, session, req);
  }
}

interface ExpandContext {
  ctx: PalmContext;
  session: IndexSession;
  lock: Lock;
  warnings: string[];
}

/** The entity's lock entry when it is installed other than through `via` (keep that install). */
function installedElsewhere(lock: Lock, key: EntityKeyed, via: Via): LockEntry | undefined {
  return lock.findAll(key).find((e) => !via.is(e.via));
}

type EntityKeyed = { kind: Kind; name: string };

/** A plugin's members, from the plugin's own origin index. */
function pluginMembers(x: ExpandContext, item: PlanItem): PlanItem[] {
  const e = item.entity;
  if (e.def.kind !== 'plugin') return [];
  const parent = Via.of(e);
  const via = parent.toString();
  const pool = item.source.index?.entities ?? [];
  const out: PlanItem[] = [];
  for (const m of e.def.members) {
    const matches = pool.filter((x) => x.kind === m.kind && x.name === m.name);
    const member = matches.find((x) => x.plugin === e.name) ?? matches[0];
    if (!member) {
      x.warnings.push(
        `plugin ${e.name} lists ${m.kind} "${m.name}", which its origin does not provide`,
      );
      continue;
    }
    const keep = installedElsewhere(x.lock, member, parent);
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

/** An agent's skills, MCP servers and instructions not already `seen` in this plan. */
async function agentDeps(x: ExpandContext, item: PlanItem, seen: Set<string>): Promise<PlanItem[]> {
  const e = item.entity;
  if (e.def.kind !== 'agent') return [];
  const parent = Via.of(e);
  const via = parent.toString();
  const out: PlanItem[] = [];
  for (const w of agentDepSpecs(e)) {
    const key = { kind: w.kind, name: w.dep.name };
    if (seen.has(entityId(key))) continue;
    const keep = installedElsewhere(x.lock, key, parent);
    if (keep) {
      const { name, path, origin } = keep;
      const entity: Entity = { kind: w.kind, name, path, origin, def: placeholderDef(w.kind) };
      out.push({ entity, source: {}, direct: false, via, keep });
      continue;
    }
    const chosen = await resolveAgentDep(x, item, w);
    if (!chosen) {
      x.warnings.push(
        `agent ${e.name} uses ${w.kind} "${w.dep.name}"${w.dep.origin ? ` from ${w.dep.origin}` : ''}, which no origin provides; install it separately`,
      );
      continue;
    }
    out.push({ ...chosen, direct: false, via });
  }
  return out;
}

/** Composite expansion (DESIGN §6 step 6): plugin → members, agent → skills/MCP servers/instructions. */
async function expand(x: ExpandContext, direct: PlanItem[]): Promise<PlanItem[]> {
  const plan: PlanItem[] = [];
  const seen = new Set<string>();
  const queue = [...direct];
  for (let item = queue.shift(); item; item = queue.shift()) {
    const key = entityId(item.entity);
    if (seen.has(key)) continue;
    seen.add(key);
    plan.push(item);
    if (item.keep) continue;
    queue.push(...pluginMembers(x, item), ...(await agentDeps(x, item, seen)));
  }
  return plan;
}

/**
 * Resolve one agent dependency: an explicit `name@origin` from that origin only; otherwise
 * the agent's own origin first, then the origin an earlier install of this dependency came
 * from (so reinstalls never become ambiguous), then every origin (picker on ambiguity).
 */
async function resolveAgentDep(
  x: ExpandContext,
  agent: PlanItem,
  w: { kind: Kind; dep: DepRef },
): Promise<Candidate | undefined> {
  const { ctx, session } = x;
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
  const all = candidatesIn(await session.all(), w.kind, w.dep.name);
  const prior = x.lock.find({ kind: w.kind, name: w.dep.name });
  const sticky = prior ? all.filter((c) => c.entity.origin === prior.origin) : [];
  const cands = sticky.length ? sticky : all;
  return cands.length ? choose(ctx, w.dep.name, cands) : undefined;
}

/** Minimal def for entries reported from the lock without an index lookup. */
function placeholderDef(kind: Kind): Entity['def'] {
  if (kind === 'mcp') return { kind: 'mcp', mcp: { name: '', transport: 'stdio' } };
  return { kind: 'skill', skill: { name: '', description: '' } };
}

interface DeployContext {
  ctx: PalmContext;
  deps: EngineDeps;
  opts: InstallOptions;
  paths: ScopePaths;
  /** Updated as items deploy. */
  lock: Lock;
  warnings: string[];
}

/** Deploy one planned entity to its targets, record it in the lock and return the outcome. */
async function deployItem(dc: DeployContext, item: PlanItem): Promise<InstallOutcome> {
  const { ctx, deps, opts, paths, lock, warnings } = dc;
  if (item.keep) {
    const notes = [`already installed${item.keep.via ? ` (${item.keep.via})` : ''}`];
    return { entry: item.keep, status: 'unchanged', notes };
  }
  const { entity, source } = item;
  const scope = opts.scope;
  const root = paths.root;
  const hash = await contentHashOf(item);
  const existing = lock.find(entity, entity.origin);
  const others = lock.findAll(entity).filter((e) => e.origin !== entity.origin);
  const via = item.direct ? undefined : item.via;
  const withVia = (entry: LockEntry): LockEntry => {
    const out = { ...entry };
    if (via) out.via = via;
    else delete out.via;
    return out;
  };

  const declared = entity.kind === 'plugin' || entity.kind === 'agent' ? entityDeps(entity) : [];
  const withDeps = (entry: LockEntry): LockEntry => {
    const out = { ...entry };
    if (declared.length) out.deps = declared;
    else delete out.deps;
    return out;
  };

  const missingTargets = opts.targets.filter((t) => !existing?.targets.includes(t));
  const intact = !!existing && Lock.filesPresent(existing, paths);
  const sameContent =
    !!existing &&
    intact &&
    existing.contentHash === hash &&
    !ctx.flags.force &&
    others.length === 0;
  if (sameContent && missingTargets.length === 0) {
    const entry = withDeps(withVia(existing));
    lock.upsert(entry);
    return { entry, status: 'unchanged', notes: [] };
  }

  const notes: string[] = [];
  // Reinstall with new content (or --force, or another origin's copy): remove the old deployment first.
  const previous = sameContent ? [] : [...(existing ? [existing] : []), ...others];
  const deployTo = sameContent
    ? missingTargets
    : orderTargets([...(existing?.targets ?? []), ...opts.targets]);
  // Files plus `file#pointer` for merged keys: everything this entity may overwrite.
  const ownedFiles = [
    ...new Set(
      [...(existing ? [existing] : []), ...others].flatMap((p) => [
        ...p.files,
        ...(p.merged ?? []).map((m) => `${m.file}#${m.pointer}`),
      ]),
    ),
  ];

  const policy = defaultSecretPolicy(ctx, scope, opts.secretPolicy);
  const absPath = source.root ? join(source.root, entity.path) : root;
  let secretValues: Record<string, string> | undefined;
  const exported = new Set<string>();
  if (entity.def.kind === 'mcp') {
    const cfg = entity.def.mcp;
    if (!ctx.flags.dryRun) {
      const r = await deps.resolveSecrets(ctx, cfg, policy);
      if (Object.keys(r.values).length) secretValues = r.values;
      // Under literal, unresolved optional secrets are left out by the targets (they say so).
      if (r.envRefs.length && policy === 'env-ref') {
        const optional = optionalSecretNames(cfg);
        const required = r.envRefs.filter((v) => !optional.has(v));
        const maybe = r.envRefs.filter((v) => optional.has(v));
        if (required.length)
          notes.push(`export ${required.join(', ')} before starting the harness`);
        if (maybe.length)
          notes.push(
            `optional: export ${maybe.join(', ')} to use ${maybe.length === 1 ? 'it' : 'them'} (left empty otherwise)`,
          );
        for (const v of r.envRefs) exported.add(v);
      }
    } else if (cfg.secrets?.length) {
      notes.push(`needs secrets: ${cfg.secrets.map((s) => s.name).join(', ')}`);
    }
    if (
      (cfg.transport === 'http' || cfg.transport === 'sse') &&
      !cfg.secrets?.length &&
      !Object.keys(cfg.headers ?? {}).length
    ) {
      notes.push(
        'no credentials declared; the harness will start OAuth on first connect if the server needs it',
      );
    }
  }
  if (entity.def.kind === 'hook')
    notes.push(`hooks run shell commands on your machine; review ${absPath}`);

  // Secrets are resolved first so a failed prompt leaves the old installation in place.
  const replacing = previous.length > 0 && !ctx.flags.dryRun;
  if (replacing) {
    const protect = lock.protectedFiles(paths, previous);
    await undeployEntries(ctx, deps, scope, previous, protect, warnings);
  }
  if (others.length)
    notes.push(
      `replaces ${entity.kind} ${entity.name} from ${others.map((o) => o.origin).join(', ')}`,
    );

  const files: string[] = sameContent && existing ? [...existing.files] : [];
  const merged: MergedRecord[] = sameContent && existing ? [...(existing.merged ?? [])] : [];
  const okTargets: TargetId[] = sameContent && existing ? [...existing.targets] : [];
  const failures: Array<{ id: TargetId; error: unknown }> = [];
  let skipped = 0;
  if (entity.kind === 'plugin') {
    okTargets.push(...deployTo); // members carry the content; the plugin itself is bookkeeping
  } else {
    for (const id of deployTo) {
      try {
        const input: DeployInput = {
          entity,
          absPath,
          originRoot: source.root ?? root,
          scope,
          scopeRoot: root,
          secretPolicy: policy,
          ...(secretValues ? { secretValues } : {}),
          dryRun: ctx.flags.dryRun,
          force: ctx.flags.force,
          ownedFiles,
          env: ctx.env,
        };
        const res = await deps.getTarget(id).deploy(input);
        okTargets.push(id);
        if (res.skipped) {
          skipped++;
          notes.push(`${id}: skipped${res.notes.length ? ` (${res.notes.join('; ')})` : ''}`);
          continue;
        }
        for (const f of res.files) if (!files.includes(f)) files.push(f);
        for (const m of res.merged ?? []) if (!merged.some((x) => deepEqual(x, m))) merged.push(m);
        for (const n of res.notes) {
          if (coveredExportNote(n, exported)) continue; // already said once for all targets
          if (!notes.includes(`${id}: ${n}`)) notes.push(`${id}: ${n}`);
        }
      } catch (error) {
        failures.push({ id, error });
      }
    }
    const [firstFailure] = failures;
    if (firstFailure && failures.length === deployTo.length && okTargets.length === 0) {
      if (replacing)
        ctx.log.warn(
          `${entity.kind} ${entity.name}: the previous installation was removed before the reinstall failed`,
        );
      throw firstFailure.error;
    }
    for (const f of failures) {
      const msg = `${f.id}: ${messageOf(f.error)}`;
      notes.push(`failed: ${msg}`);
      warnings.push(`${entity.kind} ${entity.name} → ${msg}`);
    }
  }

  const entry: LockEntry = {
    kind: entity.kind,
    name: entity.name,
    origin: entity.origin,
    path: entity.path,
    contentHash: hash,
    installedAt: nowIso(),
    targets: orderTargets(okTargets),
    files,
  };
  if (source.url) entry.url = source.url;
  if (source.ref) entry.ref = source.ref;
  if (source.sha) entry.sha = source.sha;
  if (merged.length) entry.merged = merged;
  if (via) entry.via = via;
  if (declared.length) entry.deps = declared;
  // Replaced entries leave the lock only now: a failed reinstall above keeps them listed.
  if (replacing) for (const p of previous) lock.remove(p);
  lock.upsert(entry);
  if (existing && !intact && existing.contentHash === hash) notes.push('restored missing files');

  const allSkipped =
    entity.kind !== 'plugin' &&
    deployTo.length > 0 &&
    skipped === deployTo.length - failures.length &&
    skipped > 0;
  const replaced = existing || others.length ? 'updated' : 'installed';
  return { entry, status: allSkipped ? 'skipped' : replaced, notes };
}

/**
 * Fail fast on names that match nothing, before the CLI asks for targets: throws the same
 * E_NOT_FOUND (with suggestions) or E_ORIGIN that installEntities would. Ad hoc MCP servers
 * and names only the MCP registry may know are left to the engine (no network here), and so
 * is ambiguity (the engine's picker). Git origins come from the index cache, so the engine's
 * own lookup afterwards fetches nothing again.
 */
export async function preflightInstall(
  ctx: PalmContext,
  requests: InstallRequest[],
  depsIn?: Partial<EngineDeps>,
): Promise<void> {
  const deps = await resolveEngineDeps(depsIn);
  // installEntities reads the same origins and repeats their warnings; show them here only on failure.
  const warned: string[] = [];
  const quiet: PalmContext = { ...ctx, log: { ...ctx.log, warn: (msg) => void warned.push(msg) } };
  const session = new IndexSession(quiet, deps.scan);
  try {
    for (const req of requests.map(planned)) {
      if (req.mode !== 'index') continue;
      const l = await lookupIndexed(session, req);
      if (l.cands.length === 0 && !l.registryFallback) throw await notFound(session, req.kind, l);
    }
  } catch (e) {
    for (const msg of warned) ctx.log.warn(msg);
    throw e;
  }
}

/**
 * Install entities (DESIGN §6): resolve each request against the origin
 * indexes (or the MCP registry), expand composites, deploy to every target,
 * then record the lock and (for direct requests) the manifest.
 */
export async function installEntities(
  ctx: PalmContext,
  requests: InstallRequest[],
  opts: InstallOptions,
  depsIn?: Partial<EngineDeps>,
): Promise<InstallResult> {
  const deps = await resolveEngineDeps(depsIn, { targets: true });
  const session = new IndexSession(ctx, deps.scan);
  const warnings: string[] = [];
  const paths = ScopePaths.of(ctx, opts.scope);
  const lock = await Lock.load(paths.lockFile);
  const manifest = await Manifest.load(paths.manifestFile);
  const lockBefore = JSON.stringify(lock);
  const manifestBefore = JSON.stringify(manifest);

  const direct: PlanItem[] = [];
  for (const req of requests) direct.push(await resolveRequest(ctx, deps, session, planned(req)));
  const plan = await expand({ ctx, session, lock, warnings }, direct);

  const persist = async (): Promise<void> => {
    if (ctx.flags.dryRun) return;
    if (JSON.stringify(lock) !== lockBefore) await lock.save(paths.lockFile);
    if (JSON.stringify(manifest) !== manifestBefore) await manifest.save(paths.manifestFile);
  };

  const outcomes: InstallOutcome[] = [];
  const dc: DeployContext = { ctx, deps, opts, paths, lock, warnings };
  try {
    for (const item of plan) {
      outcomes.push(await deployItem(dc, item));
      if (item.direct && !opts.noSave && item.manifestDep)
        manifest.addDep(item.entity.kind, item.manifestDep);
    }
    await dropOrphans(dc, plan, manifest);
  } catch (e) {
    await persist();
    throw e;
  }
  await persist();
  return { outcomes, warnings };
}

/** Removes dependencies a plugin/agent no longer declares (not merely ones that failed to resolve). */
async function dropOrphans(dc: DeployContext, plan: PlanItem[], manifest: Manifest): Promise<void> {
  const { ctx, deps, opts, paths, lock, warnings } = dc;
  const orphans: LockEntry[] = [];
  for (const item of plan) {
    if (item.keep || !isViaKind(item.entity.kind)) continue;
    const declared = new Set(entityDeps(item.entity).map(entityId));
    orphans.push(...lock.childrenOf(item.entity).filter((e) => !declared.has(entityId(e))));
  }
  if (!orphans.length) return;
  const removal = lock.planRemoval(orphans, { listed: (e) => manifest.lists(e), checkRoots: true });
  const protect = lock.protectedFiles(paths, removal.removed);
  await undeployEntries(ctx, deps, opts.scope, removal.removed, protect, warnings);
  for (const o of removal.removed) {
    lock.remove(o);
    warnings.push(`removed ${o.kind} ${o.name}: no longer part of ${o.via}`);
  }
  lock.reparent(removal.kept);
}
