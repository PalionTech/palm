/**
 * `palm update`: selection (the named entries, lifted to the root of their `via` chain) →
 * plan (refresh each origin's index and compare the locked content with what the origin holds
 * now; nothing in the scope is written) → apply (reinstall the roots whose content, members or
 * rendering changed, through `installEntities`, which persists the lock).
 *
 * The CLI prints the plan, asks before applying and passes `--yes` / `--dry-run` through;
 * `updateEntities` is plan + apply without asking.
 */
import { getIndex } from '../core/cache.js';
import { isPalmError, messageOf, PalmError } from '../core/errors.js';
import { hashPath } from '../core/hash.js';
import {
  type Entity,
  type EntityRef,
  type InstallFailure,
  type InstallOutcome,
  type InstallRequest,
  type InstallResult,
  type Kind,
  type LockEntry,
  type McpServerConfig,
  type OriginIndex,
  type OriginSpec,
  type PalmContext,
  type RegistryCandidate,
  type Scope,
  TARGET_IDS,
  type TargetId,
  TRANSFORM_VERSION,
} from '../core/types.js';
import { DepRef } from '../domain/dep-ref.js';
import { entityId, isViaKind, lockId, Via } from '../domain/entity-key.js';
import { Lock } from '../domain/lock.js';
import { isMcpManifestEntry, Manifest } from '../domain/manifest.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { type EngineDeps, resolveEngineDeps } from './deps.js';
import { dedupeOutcomes, installEntities } from './install.js';
import { contentHashOf } from './plan.js';
import {
  type Candidate,
  candidatesIn,
  type EntityQuery,
  entityDeps,
  notInstalled,
} from './query.js';

/** `~ updated`, `+ added` (a new plugin member / agent dependency), `- removed`, `= unchanged`, `x failed`, `! skipped`. */
export type UpdateMark = 'updated' | 'added' | 'removed' | 'unchanged' | 'failed' | 'skipped';

export interface UpdatePlanItem {
  mark: UpdateMark;
  kind: Kind;
  name: string;
  origin: string;
  /** `plugin:<name>` / `agent:<name>` for dependencies. */
  via?: string;
  /** Locked version: `v1.0.0 (abc1234)`, a sha, or `content <hash>` when neither changed. */
  from?: string;
  /** Version after the update. */
  to?: string;
  /** Files palm wrote that the user changed since (an update would overwrite them; only with --force). */
  atRisk: string[];
  /** Why an item is unchanged, skipped or failed. */
  note?: string;
}

export interface UpdatePlan {
  scope: Scope;
  items: UpdatePlanItem[];
  /** Reinstall requests for the roots that change, grouped by the targets they are installed to. */
  apply: Array<{ targets: TargetId[]; requests: InstallRequest[] }>;
  /** Unchanged entries (reported as `unchanged` outcomes). */
  unchanged: LockEntry[];
  failures: InstallFailure[];
  warnings: string[];
}

export interface UpdateResult extends InstallResult {
  plan: UpdatePlanItem[];
}

/** True when applying the plan would change something. */
export function planChanges(plan: UpdatePlan): number {
  return plan.items.filter((i) => ['updated', 'added', 'removed'].includes(i.mark)).length;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * The entries to refresh: the named ones (all direct installs when none are named), each
 * replaced by the root of its `via` chain, since dependencies are refreshed through the
 * entity that pulled them in.
 */
function selectRoots(lock: Lock, refs: readonly EntityQuery[], scope: Scope): LockEntry[] {
  const selected = refs.length
    ? refs.flatMap((ref) => {
        const matches = lock.select(ref);
        if (matches.length) return matches;
        throw notInstalled(ref, scope);
      })
    : lock.entries.filter((e) => !e.via);
  const roots = new Map<string, LockEntry>();
  for (const e of selected) {
    const root = lock.rootOf(e);
    roots.set(lockId(root), root);
  }
  return [...roots.values()];
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

interface Planner {
  ctx: PalmContext;
  deps: EngineDeps;
  paths: ScopePaths;
  lock: Lock;
  manifest: Manifest;
  /** Refreshed indexes per origin alias + ref (each origin is fetched once per run). */
  indexes: Map<string, Promise<OriginIndex>>;
  plan: UpdatePlan;
}

/**
 * What an entry resolves to now: the candidate and its content hash, or why there is nothing
 * to compare (`current`: ad hoc, offline registry), nothing to fetch from (`skipped`), the
 * entity is gone (`missing`) or the origin failed (`failed`).
 */
type Resolution =
  | { found: Candidate; hash: string }
  | { current: string }
  | { skipped: string }
  | { missing: string }
  | { failed: InstallFailure; why: string };

function shortHash(hash: string | undefined): string {
  return (hash ?? '').replace(/^sha256:/, '').slice(0, 7) || '?';
}

function versionLabel(v: { ref?: string | undefined; sha?: string | undefined }): string {
  const short = v.sha?.slice(0, 7);
  if (!v.ref) return short ?? '';
  return short && v.ref !== v.sha ? `${v.ref} (${short})` : v.ref;
}

function failureOf(e: LockEntry, err: unknown, prefix: string): InstallFailure {
  const f: InstallFailure = {
    kind: e.kind,
    name: e.name,
    origin: e.origin,
    code: isPalmError(err) ? err.code : 'E_INTERNAL',
    message: `${prefix}: ${messageOf(err)}`,
  };
  if (isPalmError(err) && err.hint) f.hint = err.hint;
  return f;
}

/** The ref (or registry version) palm.yaml pins for a root (`name@origin#ref`), if any. */
function pinnedRef(p: Planner, e: LockEntry): string | undefined {
  const dep = p.manifest.depFor(e);
  if (!dep) return undefined;
  return isMcpManifestEntry(dep) ? dep.version : dep.ref;
}

/** The origin's index at `ref`, fetched again (once per origin and ref in a run). */
function refreshedIndex(
  p: Planner,
  spec: OriginSpec,
  ref: string | undefined,
): Promise<OriginIndex> {
  const key = `${spec.alias}#${ref ?? ''}`;
  let index = p.indexes.get(key);
  if (!index) {
    index = getIndex(p.ctx, ref ? { ...spec, ref } : spec, { refresh: true, scan: p.deps.scan });
    p.indexes.set(key, index);
  }
  return index;
}

/** The entry's entity in its origin's refreshed index, with its content hash. */
async function resolveIndexed(
  p: Planner,
  e: LockEntry,
  ref: string | undefined,
): Promise<Resolution> {
  const spec = p.ctx.origins.byAlias(e.origin)?.spec;
  if (!spec)
    return {
      skipped: `origin "${e.origin}" is not registered (register it: palm install origin <spec> --alias ${e.origin})`,
    };
  let index: OriginIndex;
  try {
    index = await refreshedIndex(p, spec, ref);
  } catch (err) {
    const why = `unreachable origin "${e.origin}"`;
    return { failed: failureOf(e, err, why), why };
  }
  const found = candidatesIn([{ spec, index }], e.kind, e.name)[0];
  if (!found) return { missing: `origin "${e.origin}" no longer has ${e.kind} "${e.name}"` };
  return { found, hash: await contentHashOf(found) };
}

/** The registry's server as installEntities would synthesize it (its hash is the lock's contentHash). */
function registryCandidate(e: LockEntry, c: RegistryCandidate): Candidate {
  const name = c.config.name || c.name.split('/').filter(Boolean).pop() || c.name;
  const mcp: McpServerConfig = { ...c.config, name };
  const entity: Entity = {
    kind: 'mcp',
    name,
    path: e.path,
    origin: 'registry',
    def: { kind: 'mcp', mcp },
  };
  return { entity, source: c.version ? { ref: c.version } : {} };
}

async function resolveRegistry(p: Planner, e: LockEntry): Promise<Resolution> {
  if (p.ctx.flags.offline) return { current: 'offline: the MCP registry was not checked' };
  const version = pinnedRef(p, e);
  const registryUrl = p.ctx.config.mcpRegistryUrl;
  try {
    const opts = { ...(registryUrl ? { registryUrl } : {}), ...(version ? { version } : {}) };
    const c = (await p.deps.resolveRegistry(e.path, opts))[0];
    if (!c) return { missing: `the MCP registry no longer has "${e.path}"` };
    const found = registryCandidate(e, c);
    return { found, hash: await contentHashOf(found) };
  } catch (err) {
    return {
      failed: failureOf(e, err, 'unreachable MCP registry'),
      why: 'unreachable MCP registry',
    };
  }
}

async function resolveEntry(
  p: Planner,
  e: LockEntry,
  ref: string | undefined,
): Promise<Resolution> {
  if (e.origin === 'adhoc')
    return { current: 'ad hoc MCP server: edit palm.yaml and run palm install to change it' };
  if (e.origin === 'registry') return resolveRegistry(p, e);
  return resolveIndexed(p, e, ref);
}

/** Why a resolved entry needs a reinstall, or undefined when it is current. */
function changeOf(p: Planner, e: LockEntry, hash: string): string | undefined {
  if (hash !== e.contentHash) return 'content';
  if (e.transform < TRANSFORM_VERSION) return 'rendering';
  if (!Lock.filesPresent(e, p.paths)) return 'missing files';
  return undefined;
}

function baseItem(e: LockEntry, mark: UpdateMark, note?: string): UpdatePlanItem {
  const item: UpdatePlanItem = { mark, kind: e.kind, name: e.name, origin: e.origin, atRisk: [] };
  if (e.via) item.via = e.via;
  if (note) item.note = note;
  return item;
}

const CHANGE_NOTES: Record<string, string> = {
  rendering: 're-render: this palm version writes it differently',
  'missing files': 'restore files removed by hand',
};

/** `~ updated` with the version change and the user-edited files the reinstall would overwrite. */
async function updatedItem(
  p: Planner,
  e: LockEntry,
  r: { found: Candidate; hash: string },
  why: string,
): Promise<UpdatePlanItem> {
  const item = baseItem(e, 'updated', CHANGE_NOTES[why]);
  const from = versionLabel(e);
  const to = versionLabel(r.found.source);
  if (from && to && from !== to) Object.assign(item, { from, to });
  else if (why === 'content')
    Object.assign(item, {
      from: `content ${shortHash(e.contentHash)}`,
      to: `content ${shortHash(r.hash)}`,
    });
  item.atRisk = await Lock.modifiedFiles(e, p.paths, (abs) => hashPath(abs));
  return item;
}

/** The plan item of an entry that did not resolve; a failure or warning is recorded. */
function unresolvedItem(p: Planner, e: LockEntry, r: Exclude<Resolution, { found: Candidate }>) {
  if ('failed' in r) {
    p.plan.failures.push(r.failed);
    return baseItem(e, 'failed', r.why);
  }
  if ('current' in r) return baseItem(e, 'unchanged', r.current);
  if ('skipped' in r) {
    p.plan.warnings.push(`${e.kind} ${e.name}: ${r.skipped}`);
    return baseItem(e, 'skipped', r.skipped);
  }
  if (e.via) {
    // a dependency the origin dropped: the reinstall of its parent reports it; keep this copy
    p.plan.warnings.push(`${e.kind} ${e.name}: ${r.missing}; kept the installed copy`);
    return baseItem(e, 'unchanged', `${r.missing}; kept`);
  }
  const hint = `see what it offers: palm get ${e.kind}s --available -o ${e.origin}`;
  const failed = { ...failureOf(e, new PalmError('E_NOT_FOUND', r.missing, hint), 'not found') };
  p.plan.failures.push(failed);
  return baseItem(e, 'failed', r.missing);
}

/** Plans one entry: its plan item, and the candidate when it resolved. */
async function planEntry(
  p: Planner,
  e: LockEntry,
  ref: string | undefined,
): Promise<{ changed: boolean; found?: Candidate }> {
  const r = await resolveEntry(p, e, ref);
  if (!('found' in r)) {
    const item = unresolvedItem(p, e, r);
    p.plan.items.push(item);
    if (item.mark === 'unchanged') p.plan.unchanged.push(e);
    return { changed: false };
  }
  const why = changeOf(p, e, r.hash);
  if (why) {
    p.plan.items.push(await updatedItem(p, e, r, why));
    return { changed: true, found: r.found };
  }
  const from = versionLabel(e) || `content ${shortHash(e.contentHash)}`;
  p.plan.items.push({ ...baseItem(e, 'unchanged'), from });
  p.plan.unchanged.push(e);
  return { changed: false, found: r.found };
}

/**
 * `+ added` for what the new version declares and the installed one did not (and is not
 * installed otherwise), `- removed` for dependencies it no longer declares that nothing else
 * uses. Returns the lock ids of the removed ones.
 */
function membershipChanges(p: Planner, root: LockEntry, declared: EntityRef[]): Set<string> {
  const recorded = new Set((root.deps ?? []).map(entityId));
  const now = new Set(declared.map(entityId));
  const via = Via.of(root).toString();
  for (const d of declared) {
    if (recorded.has(entityId(d)) || p.lock.find(d)) continue;
    const item: UpdatePlanItem = { mark: 'added', ...d, origin: root.origin, via, atRisk: [] };
    p.plan.items.push(item);
  }
  const removed = new Set<string>();
  const leaving = new Set([lockId(root)]);
  for (const c of p.lock.childrenOf(root)) {
    if (now.has(entityId(c)) || p.lock.usersOf(c, leaving).length) continue;
    p.plan.items.push(baseItem(c, 'removed'));
    removed.add(lockId(c));
  }
  return removed;
}

/** Plans what a plugin/agent pulled in (transitively); true when something changes. */
async function planDependents(
  p: Planner,
  root: LockEntry,
  ref: string | undefined,
  removed: ReadonlySet<string>,
): Promise<boolean> {
  let changed = false;
  for (const c of p.lock.dependentsOf([root], removed).slice(1)) {
    const r = await planEntry(p, c, c.origin === root.origin ? ref : undefined);
    changed ||= r.changed;
  }
  return changed;
}

function addRequest(p: Planner, root: LockEntry, ref: string | undefined): void {
  const request: InstallRequest =
    root.origin === 'registry'
      ? { kind: 'mcp', spec: DepRef.of(root.path, undefined, ref), registry: root.path }
      : { kind: root.kind, spec: DepRef.of(root.name, root.origin, ref) };
  const targets = TARGET_IDS.filter((t) => root.targets.includes(t));
  const group = p.plan.apply.find((g) => g.targets.join() === targets.join());
  if (group) group.requests.push(request);
  else p.plan.apply.push({ targets, requests: [request] });
}

async function planRoot(p: Planner, root: LockEntry): Promise<void> {
  const ref = pinnedRef(p, root);
  const r = await planEntry(p, root, ref);
  if (!r.found) return;
  let changed = r.changed;
  if (isViaKind(root.kind)) {
    const before = p.plan.items.length;
    const removed = membershipChanges(p, root, entityDeps(r.found.entity));
    changed ||= p.plan.items.length > before;
    changed = (await planDependents(p, root, ref, removed)) || changed;
  }
  if (changed) addRequest(p, root, ref);
}

/**
 * What `palm update` would do: every selected root (and what it pulled in) compared with its
 * origin's refreshed index. Writes nothing in the scope; E_NOT_FOUND for names not installed.
 */
export async function planUpdate(
  ctx: PalmContext,
  refs: EntityQuery[],
  opts: { scope: Scope },
  depsIn?: Partial<EngineDeps>,
): Promise<UpdatePlan> {
  const paths = ScopePaths.of(ctx, opts.scope);
  const lock = await Lock.load(paths.lockFile);
  const roots = selectRoots(lock, refs, opts.scope);
  const plan: UpdatePlan = {
    scope: opts.scope,
    items: [],
    apply: [],
    unchanged: [],
    failures: [],
    warnings: [],
  };
  const p: Planner = {
    ctx,
    deps: await resolveEngineDeps(depsIn),
    paths,
    lock,
    manifest: await Manifest.load(paths.manifestFile),
    indexes: new Map(),
    plan,
  };
  for (const root of roots) await planRoot(p, root);
  return plan;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** Reinstalls the plan's roots (installEntities writes the lock); unchanged entries become `unchanged` outcomes. */
export async function applyUpdate(
  ctx: PalmContext,
  plan: UpdatePlan,
  depsIn?: Partial<EngineDeps>,
): Promise<UpdateResult> {
  const deps = await resolveEngineDeps(depsIn, { targets: true });
  const outcomes: InstallOutcome[] = plan.unchanged.map((entry) => ({
    entry,
    status: 'unchanged',
    notes: [],
  }));
  const warnings = [...plan.warnings];
  const failures = [...plan.failures];
  for (const g of plan.apply) {
    const opts = { scope: plan.scope, targets: g.targets, noSave: true };
    const r = await installEntities(ctx, g.requests, opts, deps);
    outcomes.push(...r.outcomes);
    warnings.push(...r.warnings);
    failures.push(...(r.failures ?? []));
  }
  return {
    outcomes: dedupeOutcomes(outcomes),
    warnings: [...new Set(warnings)],
    failures,
    plan: plan.items,
  };
}

/** Plan and apply without asking (the CLI asks in between). */
export async function updateEntities(
  ctx: PalmContext,
  refs: EntityQuery[],
  opts: { scope: Scope },
  deps?: Partial<EngineDeps>,
): Promise<UpdateResult> {
  const plan = await planUpdate(ctx, refs, opts, deps);
  return applyUpdate(ctx, plan, deps);
}
