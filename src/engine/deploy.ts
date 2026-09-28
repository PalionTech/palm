/**
 * Deploying one planned entity (DESIGN §6 steps 7–8), in four steps: the pure `planDeployment`
 * decides what to do from the lock; `resolveMcpSecrets` asks for secrets; `deployToTargets`
 * writes to each target; `finishDeploy` builds the lock entry (with file hashes) and only then
 * removes what the previous install left that the new one no longer writes. Failures are
 * recorded, never thrown: the lock lists only what succeeded.
 */
import { join } from 'node:path';
import { isPalmError, messageOf, PalmError } from '../core/errors.js';
import { hashPath } from '../core/hash.js';
import {
  type DeployInput,
  type Entity,
  type InstallFailure,
  type InstallOptions,
  type InstallOutcome,
  type LockEntry,
  type LockedFile,
  type MergedRecord,
  type PalmContext,
  type SecretPolicy,
  TARGET_IDS,
  type TargetId,
  TRANSFORM_VERSION,
} from '../core/types.js';
import { Lock, type LockPaths } from '../domain/lock.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { optionalSecretNames } from '../domain/secrets.js';
import { deepEqual } from '../lib/object.js';
import type { EngineDeps } from './deps.js';
import { itemHash, type PlanItem } from './plan.js';
import { entityDeps } from './query.js';
import { undeploy } from './uninstall.js';

/** Engine-internal install options on top of the public `InstallOptions`. */
export interface EngineInstallOptions extends InstallOptions {
  /** Bare `palm install`: `targets` is the full set; an entry on other targets loses them. */
  exactTargets?: boolean;
  /** `--frozen`: content must match the lock; no lock, manifest or config is written. */
  frozen?: boolean;
  /** Manifest sync: a request that cannot be resolved is a failure, not an error. */
  recordRequestErrors?: boolean;
  /** Executable consent was already given by the caller. */
  consented?: boolean;
}

export interface DeployContext {
  ctx: PalmContext;
  deps: EngineDeps;
  opts: EngineInstallOptions;
  paths: ScopePaths;
  /** Updated as items deploy. */
  lock: Lock;
  warnings: string[];
  failures: InstallFailure[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function orderTargets(ids: Iterable<TargetId>): TargetId[] {
  const set = new Set(ids);
  return TARGET_IDS.filter((t) => set.has(t));
}

function defaultSecretPolicy(
  ctx: PalmContext,
  scope: InstallOptions['scope'],
  override?: SecretPolicy,
): SecretPolicy {
  return override ?? ctx.config.secrets?.[scope] ?? (scope === 'global' ? 'literal' : 'env-ref');
}

/** A failure for the entity (optionally one target) from an error or a message. */
export function failureOf(
  e: Pick<InstallFailure, 'kind' | 'name' | 'origin'>,
  error: unknown,
  target?: TargetId,
): InstallFailure {
  const f: InstallFailure = {
    kind: e.kind,
    name: e.name,
    origin: e.origin,
    code: isPalmError(error) ? error.code : 'E_INTERNAL',
    message: messageOf(error),
  };
  if (target) f.target = target;
  if (isPalmError(error) && error.hint) f.hint = error.hint;
  return f;
}

/** `file` and `file#pointer` keys of everything the entries own (DeployInput.ownedFiles). */
function ownedKeys(entries: readonly LockEntry[]): string[] {
  const keys = entries.flatMap((p) => [
    ...p.files.map((f) => f.path),
    ...(p.merged ?? []).map((m) => `${m.file}#${m.pointer}`),
  ]);
  return [...new Set(keys)];
}

/**
 * The lock paths of the entries' files changed on disk since palm wrote them (their hash
 * differs from the lock's). Uninstall and install refuse to delete or overwrite these without
 * `--force`.
 */
export async function modifiedFiles(
  paths: LockPaths,
  entries: readonly LockEntry[],
): Promise<string[]> {
  const out: string[] = [];
  for (const e of entries)
    out.push(...(await Lock.modifiedFiles(e, paths, (abs) => hashPath(abs))));
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// planDeployment (pure)
// ---------------------------------------------------------------------------

export interface DeploymentInput {
  item: PlanItem;
  hash: string;
  /** The entity's entry from the same origin. */
  existing?: LockEntry | undefined;
  /** The entity's entries from other origins (replaced by this install). */
  others: LockEntry[];
  /** Every file `existing` lists is on disk. */
  intact: boolean;
  targets: TargetId[];
  /** `targets` is the full set (bare `palm install`), not an addition. */
  exact: boolean;
  force: boolean;
}

export type Deployment =
  | { action: 'keep' | 'unchanged'; entry: LockEntry; notes: string[] }
  | {
      action: 'deploy';
      /** Targets to deploy to now. */
      to: TargetId[];
      /** Incremental: `existing` stays, the new targets add to it. */
      carry?: LockEntry;
      /** Entries this deploy replaces: undeployed (what is stale) only after it succeeded. */
      previous: LockEntry[];
      /** DeployInput.ownedFiles. */
      owned: string[];
      status: 'installed' | 'updated';
      notes: string[];
    };

/** `entry` with the plan item's `via` and the entity's declared `deps`. */
function relinked(entry: LockEntry, item: PlanItem): LockEntry {
  const out: LockEntry = { ...entry };
  const via = item.direct ? undefined : item.via;
  if (via) out.via = via;
  else delete out.via;
  const declared = isComposite(item.entity) ? entityDeps(item.entity) : [];
  if (declared.length) out.deps = declared;
  else delete out.deps;
  return out;
}

function isComposite(e: Entity): boolean {
  return e.kind === 'plugin' || e.kind === 'agent';
}

function deploymentNotes(d: DeploymentInput, dropped: TargetId[]): string[] {
  const notes: string[] = [];
  const { existing, others, item } = d;
  if (others.length)
    notes.push(
      `replaces ${item.entity.kind} ${item.entity.name} from ${others.map((o) => o.origin).join(', ')}`,
    );
  if (existing && !d.intact && existing.contentHash === d.hash)
    notes.push('restored missing files');
  if (existing && existing.transform !== TRANSFORM_VERSION && existing.contentHash === d.hash)
    notes.push('re-rendered for this palm version');
  if (dropped.length) notes.push(`removed from ${dropped.join(', ')}`);
  return notes;
}

/**
 * What to do with one planned item, from the lock alone: keep a dependency installed another
 * way, report it unchanged, add the targets it is missing (incremental), or deploy it in full
 * and replace the previous install (new content, other origin, older transform, missing files,
 * `--force`, or a smaller exact target set).
 */
export function planDeployment(d: DeploymentInput): Deployment {
  const { item, existing, others } = d;
  if (item.keep) {
    const notes = [`already installed${item.keep.via ? ` (${item.keep.via})` : ''}`];
    return { action: 'keep', entry: item.keep, notes };
  }
  const same =
    !!existing &&
    d.intact &&
    existing.contentHash === d.hash &&
    existing.transform === TRANSFORM_VERSION &&
    !d.force &&
    others.length === 0;
  const missing = d.targets.filter((t) => !existing?.targets.includes(t));
  const dropped = d.exact ? (existing?.targets ?? []).filter((t) => !d.targets.includes(t)) : [];
  if (same && existing && missing.length === 0 && dropped.length === 0)
    return { action: 'unchanged', entry: relinked(existing, item), notes: [] };
  const previous = [...(existing ? [existing] : []), ...others];
  const base = {
    action: 'deploy' as const,
    owned: ownedKeys(previous),
    status: previous.length ? ('updated' as const) : ('installed' as const),
    notes: deploymentNotes(d, dropped),
  };
  if (same && existing && dropped.length === 0)
    return { ...base, to: missing, carry: existing, previous: [] };
  const to = orderTargets(d.exact ? d.targets : [...(existing?.targets ?? []), ...d.targets]);
  return { ...base, to, previous };
}

// ---------------------------------------------------------------------------
// Refusals: hidden Unicode, edit-safe overwrite, --frozen content
// ---------------------------------------------------------------------------

/** The scanner's findings for the entity (`Entity.issues`: hidden Unicode), by severity. */
function unicodeIssues(entity: Entity): { critical: string[]; warning: string[] } {
  const out = { critical: [] as string[], warning: [] as string[] };
  for (const i of entity.issues ?? []) out[i.severity].push(i.message);
  return out;
}

function failedOutcome(
  dc: DeployContext,
  item: PlanItem,
  failure: InstallFailure,
  existing?: LockEntry,
): InstallOutcome {
  dc.failures.push(failure);
  const entry = existing ?? provisionalEntry(item, '');
  return { entry, status: 'failed', notes: [`failed: ${failure.message}`] };
}

function unicodeRefusal(dc: DeployContext, item: PlanItem): PalmError | undefined {
  const { critical, warning } = unicodeIssues(item.entity);
  const { kind, name } = item.entity;
  for (const w of warning) dc.warnings.push(`${kind} ${name}: invisible character: ${w}`);
  if (!critical.length) return undefined;
  if (dc.ctx.flags.force) {
    dc.warnings.push(`${kind} ${name}: installed despite hidden Unicode (--force): ${critical[0]}`);
    return undefined;
  }
  return new PalmError(
    'E_CONFLICT',
    `${kind} ${name} contains hidden Unicode that can smuggle instructions: ${critical.join('; ')}`,
    `inspect it with: palm audit; remove it with: palm audit --strip (in the origin), or install anyway with --force`,
  );
}

async function editRefusal(
  dc: DeployContext,
  item: PlanItem,
  d: Extract<Deployment, { action: 'deploy' }>,
): Promise<PalmError | undefined> {
  if (dc.ctx.flags.force) return undefined;
  const mine = [...(d.carry ? [d.carry] : []), ...d.previous];
  const changed = await modifiedFiles(dc.paths, mine);
  if (!changed.length) return undefined;
  const { kind, name } = item.entity;
  const them = changed.length === 1 ? 'it' : 'them';
  return new PalmError(
    'E_CONFLICT',
    `${kind} ${name}: ${changed.join(', ')} changed since palm installed ${them}; not overwriting`,
    `palm left this ${kind} as it was; keep your edits, or overwrite ${them} with: palm install ${kind} ${name}@${item.entity.origin} --force`,
  );
}

function frozenRefusal(dc: DeployContext, item: PlanItem, hash: string): PalmError | undefined {
  if (!dc.opts.frozen) return undefined;
  const { kind, name, origin } = item.entity;
  const locked = dc.lock.find(item.entity, origin);
  if (locked?.contentHash === hash) return undefined;
  return new PalmError(
    'E_CONFLICT',
    locked
      ? `${kind} ${name}: the content at ${item.source.sha?.slice(0, 12) ?? origin} differs from palm.lock.yaml`
      : `${kind} ${name}@${origin} is not in palm.lock.yaml`,
    'run palm install without --frozen, then commit palm.lock.yaml',
  );
}

/** Why this item must not be deployed now, if anything. */
async function refusal(
  dc: DeployContext,
  item: PlanItem,
  d: Extract<Deployment, { action: 'deploy' }>,
  hash: string,
): Promise<PalmError | undefined> {
  return (
    frozenRefusal(dc, item, hash) ?? unicodeRefusal(dc, item) ?? (await editRefusal(dc, item, d))
  );
}

// ---------------------------------------------------------------------------
// resolveMcpSecrets
// ---------------------------------------------------------------------------

interface McpSecrets {
  values?: Record<string, string>;
  /** Variables the engine already told the user to export (target notes repeating them are dropped). */
  exported: Set<string>;
  notes: string[];
}

function envRefNotes(cfg: Entity['def'] & { kind: 'mcp' }, envRefs: string[]): string[] {
  const optional = optionalSecretNames(cfg.mcp);
  const required = envRefs.filter((v) => !optional.has(v));
  const maybe = envRefs.filter((v) => optional.has(v));
  const notes: string[] = [];
  if (required.length) notes.push(`export ${required.join(', ')} before starting the harness`);
  if (maybe.length)
    notes.push(
      `optional: export ${maybe.join(', ')} to use ${maybe.length === 1 ? 'it' : 'them'} (left empty otherwise)`,
    );
  return notes;
}

function transportNotes(def: Entity['def'] & { kind: 'mcp' }): string[] {
  const cfg = def.mcp;
  const remote = cfg.transport === 'http' || cfg.transport === 'sse';
  if (!remote || cfg.secrets?.length || Object.keys(cfg.headers ?? {}).length) return [];
  return [
    'no credentials declared; the harness will start OAuth on first connect if the server needs it',
  ];
}

/**
 * Secret values (literal policy) and the notes about variables to export (env-ref policy).
 * Asked before anything is written, so a cancelled prompt leaves the old install in place.
 */
async function resolveMcpSecrets(dc: DeployContext, entity: Entity): Promise<McpSecrets> {
  const out: McpSecrets = { exported: new Set(), notes: [] };
  const def = entity.def;
  if (def.kind !== 'mcp') return out;
  const { ctx, deps, opts } = dc;
  const policy = defaultSecretPolicy(ctx, opts.scope, opts.secretPolicy);
  if (ctx.flags.dryRun) {
    if (def.mcp.secrets?.length)
      out.notes.push(`needs secrets: ${def.mcp.secrets.map((s) => s.name).join(', ')}`);
  } else {
    const r = await deps.resolveSecrets(ctx, def.mcp, policy);
    if (Object.keys(r.values).length) out.values = r.values;
    // Under literal, unresolved optional secrets are left out by the targets (they say so).
    if (r.envRefs.length && policy === 'env-ref') {
      out.notes.push(...envRefNotes(def, r.envRefs));
      for (const v of r.envRefs) out.exported.add(v);
    }
  }
  out.notes.push(...transportNotes(def));
  return out;
}

// ---------------------------------------------------------------------------
// deployToTargets
// ---------------------------------------------------------------------------

interface TargetRun {
  ok: TargetId[];
  skipped: number;
  files: string[];
  merged: MergedRecord[];
  notes: string[];
  failed: Array<{ id: TargetId; error: unknown }>;
}

/** A target's "MCP x: export A, B in the environment …" note whose variables the engine already listed. */
function coveredExportNote(note: string, exported: Set<string>): boolean {
  const m = /^MCP \S+: export (.+) in the environment /.exec(note);
  const vars = m?.[1];
  return !!vars && vars.split(', ').every((v) => exported.has(v));
}

function absPathOf(item: PlanItem, paths: ScopePaths): string {
  return item.source.root ? join(item.source.root, item.entity.path) : paths.root;
}

function deployInput(
  dc: DeployContext,
  item: PlanItem,
  owned: string[],
  secrets: McpSecrets,
): DeployInput {
  const { ctx, opts, paths } = dc;
  return {
    entity: item.entity,
    absPath: absPathOf(item, paths),
    originRoot: item.source.root ?? paths.root,
    scope: opts.scope,
    scopeRoot: paths.root,
    secretPolicy: defaultSecretPolicy(ctx, opts.scope, opts.secretPolicy),
    ...(secrets.values ? { secretValues: secrets.values } : {}),
    dryRun: ctx.flags.dryRun,
    force: ctx.flags.force,
    ownedFiles: owned,
    env: ctx.env,
  };
}

function collect(
  run: TargetRun,
  id: TargetId,
  res: Awaited<ReturnType<DeployTarget>>,
  exported: Set<string>,
): void {
  run.ok.push(id);
  if (res.skipped) {
    run.skipped++;
    run.notes.push(`${id}: skipped${res.notes.length ? ` (${res.notes.join('; ')})` : ''}`);
    return;
  }
  for (const f of res.files) if (!run.files.includes(f)) run.files.push(f);
  for (const m of res.merged ?? [])
    if (!run.merged.some((x) => deepEqual(x, m))) run.merged.push(m);
  for (const n of res.notes) {
    if (coveredExportNote(n, exported)) continue; // already said once for all targets
    if (!run.notes.includes(`${id}: ${n}`)) run.notes.push(`${id}: ${n}`);
  }
}

type DeployTarget = ReturnType<EngineDeps['getTarget']>['deploy'];

/** Deploy to each target of the plan; a target's error is collected, the others go on. */
async function deployToTargets(
  dc: DeployContext,
  item: PlanItem,
  d: Extract<Deployment, { action: 'deploy' }>,
  secrets: McpSecrets,
): Promise<TargetRun> {
  const notes = [...secrets.notes];
  const run: TargetRun = { ok: [], skipped: 0, files: [], merged: [], notes, failed: [] };
  if (item.entity.kind === 'plugin') {
    run.ok.push(...d.to); // members carry the content; the plugin itself is bookkeeping
    return run;
  }
  const input = deployInput(dc, item, d.owned, secrets);
  for (const id of d.to) {
    try {
      collect(run, id, await dc.deps.getTarget(id).deploy(input), secrets.exported);
    } catch (error) {
      run.failed.push({ id, error });
    }
  }
  return run;
}

// ---------------------------------------------------------------------------
// buildLockEntry, stale removal, outcome
// ---------------------------------------------------------------------------

/** The lock entry before its files are hashed (`hash` fills `files[].hash`). */
function provisionalEntry(item: PlanItem, hash: string): LockEntry {
  const { entity, source } = item;
  const entry: LockEntry = {
    kind: entity.kind,
    name: entity.name,
    origin: entity.origin,
    path: entity.path,
    contentHash: hash,
    transform: TRANSFORM_VERSION,
    targets: [],
    files: [],
  };
  if (source.url) entry.url = source.url;
  if (source.url && source.spec?.root) entry.root = source.spec.root;
  if (source.ref) entry.ref = source.ref;
  if (source.sha) entry.sha = source.sha;
  return relinked(entry, item);
}

async function hashed(dc: DeployContext, path: string): Promise<LockedFile> {
  if (dc.ctx.flags.dryRun) return { path, hash: '' };
  const hash = await hashPath(dc.paths.abs(path)).catch(() => '');
  return { path, hash };
}

/** The lock entry for a (partly) successful deploy: carried state plus what the targets wrote. */
async function buildLockEntry(
  dc: DeployContext,
  item: PlanItem,
  d: Extract<Deployment, { action: 'deploy' }>,
  run: TargetRun,
): Promise<LockEntry> {
  const entry = provisionalEntry(item, await itemHash(item));
  const carried = (d.carry?.files ?? []).filter((f) => !run.files.includes(f.path));
  entry.targets = orderTargets([...(d.carry?.targets ?? []), ...run.ok]);
  entry.files = [...carried];
  for (const f of run.files) entry.files.push(await hashed(dc, f));
  const merged = [...(d.carry?.merged ?? [])];
  for (const m of run.merged) if (!merged.some((x) => deepEqual(x, m))) merged.push(m);
  if (merged.length) entry.merged = merged;
  return entry;
}

/** Same slot of a shared file: same file and pointer (an appended item also the same value). */
function sameSlot(a: MergedRecord, b: MergedRecord): boolean {
  if (a.file !== b.file || a.pointer !== b.pointer) return false;
  return !a.pointer.startsWith('/hooks/') || deepEqual(a.value, b.value);
}

/**
 * What of `prev` the new install `next` no longer writes. For a hook replaced by a hook of the
 * same name the view is not a hook entry: `Target.undeploy` removes a hook's whole asset
 * directory, which the new install just wrote (TODO(targets): undeploy only listed files).
 */
function staleView(prev: LockEntry, next: LockEntry): LockEntry {
  const keep = new Set(next.files.map((f) => f.path));
  const files = prev.files.filter((f) => !keep.has(f.path));
  const merged = (prev.merged ?? []).filter(
    (m) => !(next.merged ?? []).some((n) => sameSlot(m, n)),
  );
  const view: LockEntry = { ...prev, files, merged };
  const sharedAssets = prev.kind === 'hook' && next.kind === 'hook';
  return sharedAssets && prev.name.toLowerCase() === next.name.toLowerCase()
    ? { ...view, kind: 'skill' }
    : view;
}

/** Undeploys what the replaced entries left that `next` does not write, then drops them. */
async function replacePrevious(dc: DeployContext, previous: LockEntry[], next: LockEntry) {
  const { ctx, deps, lock, paths } = dc;
  const views = previous
    .map((p) => staleView(p, next))
    .filter((v) => v.files.length || v.merged?.length);
  if (views.length && !ctx.flags.dryRun) {
    const protect = lock.protectedFiles(paths, previous);
    for (const f of next.files) protect.add(paths.abs(f.path));
    const report = await undeploy(ctx, deps, { scope: dc.opts.scope, entries: views, protect });
    dc.failures.push(...report.failures);
    dc.warnings.push(...report.warnings);
  }
  if (!ctx.flags.dryRun) for (const p of previous) lock.remove(p);
}

function outcomeStatus(
  item: PlanItem,
  d: Extract<Deployment, { action: 'deploy' }>,
  run: TargetRun,
): InstallOutcome['status'] {
  const skippedAll =
    item.entity.kind !== 'plugin' &&
    run.skipped > 0 &&
    run.skipped === run.ok.length &&
    !d.carry?.targets.length;
  return skippedAll ? 'skipped' : d.status;
}

/** Records the lock entry of a deploy that reached at least one target, then removes stale files. */
async function finishDeploy(
  dc: DeployContext,
  item: PlanItem,
  d: Extract<Deployment, { action: 'deploy' }>,
  run: TargetRun,
): Promise<InstallOutcome> {
  const failureNotes = run.failed.map((f) => `failed: ${f.id}: ${messageOf(f.error)}`);
  for (const f of run.failed) dc.failures.push(failureOf(item.entity, f.error, f.id));
  const notes = [...d.notes, ...run.notes, ...failureNotes];
  if (item.entity.kind === 'hook')
    notes.push(`hooks run shell commands on your machine; review ${absPathOf(item, dc.paths)}`);
  const existing = d.carry ?? dc.lock.find(item.entity, item.entity.origin);
  if (run.failed.length && run.ok.length === 0) {
    // Nothing deployed: the previous install stays installed and listed.
    return {
      entry: existing ?? provisionalEntry(item, await itemHash(item)),
      status: 'failed',
      notes,
    };
  }
  const entry = await buildLockEntry(dc, item, d, run);
  await replacePrevious(dc, d.previous, entry);
  dc.lock.upsert(entry);
  return { entry, status: outcomeStatus(item, d, run), notes };
}

// ---------------------------------------------------------------------------
// deployItem
// ---------------------------------------------------------------------------

/** What the lock says about the item's entity, and the pure deployment decision. */
export async function decide(dc: DeployContext, item: PlanItem): Promise<Deployment> {
  const { entity } = item;
  const existing = dc.lock.find(entity, entity.origin);
  return planDeployment({
    item,
    hash: await itemHash(item),
    existing,
    others: dc.lock.findAll(entity).filter((e) => e.origin !== entity.origin),
    intact: !!existing && Lock.filesPresent(existing, dc.paths),
    targets: dc.opts.targets,
    exact: !!dc.opts.exactTargets,
    force: dc.ctx.flags.force,
  });
}

/**
 * Deploy one planned entity to its targets and record it in the lock. Never throws for a
 * target's error, an edit-safe refusal or hidden Unicode: those are failures in `dc.failures`
 * and a `failed` outcome, and the lock keeps what was installed before.
 */
export async function deployItem(dc: DeployContext, item: PlanItem): Promise<InstallOutcome> {
  if (item.keep) {
    const notes = [`already installed${item.keep.via ? ` (${item.keep.via})` : ''}`];
    return { entry: item.keep, status: 'unchanged', notes };
  }
  const d = await decide(dc, item);
  if (d.action !== 'deploy') {
    dc.lock.upsert(d.entry);
    return { entry: d.entry, status: 'unchanged', notes: d.notes };
  }
  const existing = dc.lock.find(item.entity, item.entity.origin);
  const refused = await refusal(dc, item, d, await itemHash(item));
  if (refused) return failedOutcome(dc, item, failureOf(item.entity, refused), existing);
  const secrets = await resolveMcpSecrets(dc, item.entity);
  const run = await deployToTargets(dc, item, d, secrets);
  return finishDeploy(dc, item, d, run);
}
