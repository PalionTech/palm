/**
 * Bare `palm install`: make the scope match palm.yaml + palm.lock.yaml. Entries the lock
 * already realises stay untouched (no network); others are replayed from the commit the lock
 * names, or resolved fresh when palm.yaml asks for something the lock does not have. Every
 * entry is deployed to at least the persisted targets (palm.yaml / config.yaml); an entry on a
 * target that left the persisted set since the last sync (`Lock.targets`) loses it, while a
 * target one install added with `--target` stays.
 * `--frozen` first checks that palm.yaml, the lock and the files agree, and writes nothing.
 */
import { existsSync } from 'node:fs';
import { PalmError } from '../core/errors.js';
import { refSatisfies } from '../core/git.js';
import { hashValue } from '../core/hash.js';
import {
  type DepRef as DepRefData,
  type InstallFailure,
  type InstallOutcome,
  type InstallResult,
  KINDS,
  type Kind,
  type LockEntry,
  type Manifest as ManifestData,
  type McpManifestEntry,
  type McpServerConfig,
  type PalmContext,
  type Scope,
  type SecretPolicy,
  type TargetId,
  TRANSFORM_VERSION,
} from '../core/types.js';
import { DepRef, sameName } from '../domain/dep-ref.js';
import { entityId } from '../domain/entity-key.js';
import { filePaths, Lock } from '../domain/lock.js';
import { depMatches, isMcpManifestEntry, Manifest } from '../domain/manifest.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { mergedRecordState } from '../targets/merged-state.js';
import { failureOf, modifiedFiles } from './deploy.js';
import type { EngineDeps } from './deps.js';
import { dedupeOutcomes, type EngineRequest, installEntities, scopedContext } from './install.js';
import { resolveTargets } from './resolve-targets.js';
import { uninstallEntities } from './uninstall.js';

/** Canonical MCP config for an ad hoc manifest entry (`command` or `url`). */
function adhocConfig(dep: McpManifestEntry): McpServerConfig {
  const cfg: McpServerConfig = {
    name: dep.name,
    transport: dep.transport ?? (dep.url ? 'http' : 'stdio'),
  };
  if (dep.command) cfg.command = dep.command;
  if (dep.args) cfg.args = dep.args;
  if (dep.env) cfg.env = dep.env;
  if (dep.url) cfg.url = dep.url;
  if (dep.headers) cfg.headers = dep.headers;
  cfg.source = { type: 'adhoc' };
  return cfg;
}

export type ManifestDep = { kind: Kind; dep: DepRefData | McpManifestEntry };

/** Every dependency the manifest lists, kind by kind. */
export function manifestDeps(m: ManifestData | Manifest): ManifestDep[] {
  const doc = m instanceof Manifest ? m : Manifest.of(m);
  return KINDS.flatMap((kind) => doc.deps(kind).map((dep) => ({ kind, dep })));
}

/**
 * Does lock entry `e` satisfy manifest dependency `d` (ignoring refs)? Registry MCP servers
 * are listed under their registry name (`io.github.upstash/context7`) but locked under their
 * config key (`context7`); the lock entry's `path` holds the registry name.
 */
export function satisfies(e: LockEntry, d: ManifestDep): boolean {
  return depMatches(d.kind, d.dep, e);
}

/** The lock entry realising `d`, a direct one first. */
function realising(lock: Lock, d: ManifestDep): LockEntry | undefined {
  const all = lock.entries.filter((e) => satisfies(e, d));
  return all.find((e) => !e.via) ?? all[0];
}

/** Targets of `want` the entry is not on, and targets it is on that must go. */
function targetGaps(e: LockEntry, at: { targets: TargetId[]; drop: TargetId[] }) {
  return {
    missing: at.targets.filter((t) => !e.targets.includes(t)),
    stale: e.targets.filter((t) => at.drop.includes(t)),
  };
}

function onTargets(e: LockEntry, at: { targets: TargetId[]; drop: TargetId[] }): boolean {
  const { missing, stale } = targetGaps(e, at);
  return missing.length === 0 && stale.length === 0;
}

function mcpMismatch(e: LockEntry, dep: McpManifestEntry): string | undefined {
  if (dep.registry) {
    if (!dep.version || e.ref === dep.version) return undefined;
    return `pins ${dep.version}, the lock has ${e.ref ?? 'none'}`;
  }
  if (!dep.command && !dep.url) return undefined;
  const { source: _s, ...cfg } = adhocConfig(dep);
  return e.contentHash === hashValue(cfg) ? undefined : 'its definition in palm.yaml changed';
}

/** Why the lock entry does not realise the manifest dependency as written (undefined: it does). */
function depMismatch(e: LockEntry, d: ManifestDep): string | undefined {
  const dep = d.dep;
  if (isMcpManifestEntry(dep)) return mcpMismatch(e, dep);
  if (dep.origin && !sameName(e.origin, dep.origin))
    return `wants origin ${dep.origin}, the lock has ${e.origin}`;
  if (dep.ref && !refSatisfies(dep.ref, e))
    return `pins #${dep.ref}, the lock has ${e.ref ?? e.sha?.slice(0, 12) ?? 'no ref'}`;
  return undefined;
}

/** True when the lock entry is an exact, up-to-date realisation of the manifest dependency. */
function upToDate(e: LockEntry, d: ManifestDep, state: SyncState): boolean {
  if (e.via) return false; // promote to a direct install
  if (e.transform !== TRANSFORM_VERSION) return false; // rendered by an older palm
  if (!onTargets(e, state)) return false;
  return depMismatch(e, d) === undefined;
}

/** The request that installs `d` fresh: registry servers keep the locked version and key. */
function toRequest(d: ManifestDep, present?: LockEntry): EngineRequest {
  const dep = d.dep;
  if (d.kind === 'mcp' && isMcpManifestEntry(dep)) {
    if (dep.registry) {
      const locked = present?.origin === 'registry' ? present : undefined;
      const version = dep.version ?? locked?.ref;
      const req: EngineRequest = {
        kind: 'mcp',
        spec: DepRef.of(dep.registry, undefined, version),
        registry: dep.registry,
      };
      req.mcpName = locked?.name ?? dep.name;
      return req;
    }
    if (dep.command || dep.url) return { kind: 'mcp', spec: dep.name, adhocMcp: adhocConfig(dep) };
    return { kind: 'mcp', spec: dep.name };
  }
  return { kind: d.kind, spec: dep as DepRefData };
}

/** A lock entry from an origin index that palm.yaml still asks for as locked: replay it. */
function replayable(e: LockEntry, d: ManifestDep): boolean {
  if (e.origin === 'registry' || e.origin === 'adhoc' || isMcpManifestEntry(d.dep)) return false;
  return depMismatch(e, d) === undefined;
}

interface SyncPlan {
  unchanged: InstallOutcome[];
  requests: EngineRequest[];
}

interface SyncState {
  scope: Scope;
  manifest: Manifest;
  lock: Lock;
  /** Every entry's minimum target set: the persisted set plus any `--target`. */
  targets: TargetId[];
  /** Targets that left the persisted set since the last sync (`Lock.targets`). */
  drop: TargetId[];
  /** The persisted set, recorded in the lock after a sync without failures. */
  persisted?: TargetId[];
}

/** Per manifest dependency: unchanged (lock realises it, files and merged records intact), a replay, or fresh. */
async function planSync(ctx: PalmContext, state: SyncState): Promise<SyncPlan> {
  const { lock } = state;
  const paths = ScopePaths.of(ctx, state.scope);
  const plan: SyncPlan = { unchanged: [], requests: [] };
  for (const d of manifestDeps(state.manifest)) {
    const present = realising(lock, d);
    const current = !!present && !ctx.flags.force && upToDate(present, d, state);
    if (present && current && (await lock.intact(present, paths, mergedRecordState))) {
      plan.unchanged.push({ entry: present, status: 'unchanged', notes: [] });
    } else if (present && replayable(present, d)) {
      plan.requests.push({ kind: d.kind, spec: present.name, locked: present });
    } else {
      plan.requests.push(toRequest(d, present));
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// --frozen
// ---------------------------------------------------------------------------

function depLabel(d: ManifestDep): string {
  const dep = d.dep;
  if (isMcpManifestEntry(dep)) return `${d.kind} ${dep.registry ?? dep.name}`;
  return `${d.kind} ${DepRef.from(dep).toString()}`;
}

/** Differences between palm.yaml and the lock, entry by entry. */
function manifestDifferences(wanted: ManifestDep[], state: SyncState): string[] {
  const out: string[] = [];
  const { lock } = state;
  for (const d of wanted) {
    const e = lock.entries.find((x) => !x.via && satisfies(x, d));
    const why = e ? depMismatch(e, d) : undefined;
    if (!e) out.push(`${depLabel(d)}: in palm.yaml, not in palm.lock.yaml`);
    else if (why) out.push(`${depLabel(d)}: palm.yaml ${why}`);
  }
  for (const e of lock.entries) out.push(...entryDifferences(e, { ...state, wanted }));
  return out;
}

/** An entry that lacks a persisted target, or is on one palm.yaml dropped. */
function targetDifferences(e: LockEntry, label: string, at: SyncState): string[] {
  const { missing, stale } = targetGaps(e, at);
  const on = e.targets.join(', ') || 'no target';
  const out: string[] = [];
  if (missing.length)
    out.push(`${label}: locked for ${on}, palm.yaml targets ${at.targets.join(', ')}`);
  if (stale.length) out.push(`${label}: locked for ${on}, palm.yaml dropped ${stale.join(', ')}`);
  return out;
}

/** What is wrong with one lock entry under --frozen: extraneous, orphaned, stale, other targets. */
function entryDifferences(e: LockEntry, at: SyncState & { wanted: ManifestDep[] }): string[] {
  const label = `${e.kind} ${e.name}@${e.origin}`;
  const out: string[] = [];
  if (!e.via && !at.wanted.some((d) => satisfies(e, d)))
    out.push(`${label}: in palm.lock.yaml, not in palm.yaml`);
  if (e.via && !at.lock.parentOf(e))
    out.push(`${label}: installed via ${e.via}, which is not locked`);
  if (e.transform !== TRANSFORM_VERSION)
    out.push(
      `${label}: locked by an older palm (transform ${e.transform}, now ${TRANSFORM_VERSION})`,
    );
  out.push(...targetDifferences(e, label, at));
  return out;
}

/**
 * `--frozen`: palm.yaml and palm.lock.yaml must agree (every dependency locked as written,
 * nothing extra, same targets, current transform), no locked file may have been edited, and
 * every merged fragment (MCP keys, hook entries, instruction blocks) must still be in its file
 * as recorded. Missing files are fine: they are restored from the locked commits. E_CONFLICT
 * lists every difference; nothing has been written.
 */
async function assertFrozen(ctx: PalmContext, state: SyncState): Promise<void> {
  const { manifest, lock } = state;
  const diffs = manifestDifferences(manifestDeps(manifest), state);
  const paths = ScopePaths.of(ctx, state.scope);
  for (const e of lock.entries) {
    for (const f of await modifiedFiles(paths, [e]))
      diffs.push(`${f} (${e.kind} ${e.name}): changed since palm wrote it`);
    for (const d of await Lock.mergedDrift(e, paths, mergedRecordState))
      diffs.push(`${mergedLabel(d.record)} (${e.kind} ${e.name}): ${driftWords(d.state)}`);
  }
  if (!diffs.length) return;
  throw new PalmError(
    'E_CONFLICT',
    `palm.yaml, palm.lock.yaml and the installed files do not match (--frozen):\n${diffs.map((x) => `  - ${x}`).join('\n')}`,
    `bring them in line: palm install${state.scope === 'global' ? ' -g' : ''}, then review and commit palm.yaml and palm.lock.yaml`,
  );
}

/** `file#pointer` of a merged record (`.mcp.json#/mcpServers/docs`, `AGENTS.md#block:…`). */
export function mergedLabel(rec: { file: string; pointer: string }): string {
  return `${rec.file}#${rec.pointer}`;
}

/** How a merged record drifted, in words. */
export function driftWords(state: 'missing' | 'changed'): string {
  return state === 'missing' ? 'missing (palm merged it)' : 'changed since palm merged it';
}

/** After a frozen restore: every restored file must hash to what the lock says. */
function frozenMismatches(before: Lock, outcomes: InstallOutcome[]): InstallFailure[] {
  const out: InstallFailure[] = [];
  for (const o of outcomes) {
    if (o.status === 'unchanged' || o.status === 'failed') continue;
    const locked = before.find(o.entry, o.entry.origin);
    const want = new Map(locked?.files.map((f) => [f.path, f.hash]) ?? []);
    const differ = o.entry.files.filter((f) => want.get(f.path) && want.get(f.path) !== f.hash);
    if (differ.length)
      out.push(
        failureOf(
          o.entry,
          new Error(
            `restored ${filePaths({ files: differ }).join(', ')} differently from the lock`,
          ),
        ),
      );
  }
  return out;
}

// ---------------------------------------------------------------------------
// syncManifest
// ---------------------------------------------------------------------------

/** What a dry run would leave in the lock: outcomes replace the entries of the same entity. */
function dryRunEntries(before: Lock, outcomes: InstallOutcome[]): LockEntry[] {
  const replaced = new Set(outcomes.map((o) => entityId(o.entry)));
  return [
    ...before.entries.filter((e) => !replaced.has(entityId(e))),
    ...outcomes.map((o) => o.entry),
  ];
}

export interface SyncOptions {
  scope: Scope;
  prune: boolean;
  /**
   * Every entry's minimum target set (the persisted set plus any `--target`); resolved like
   * `palm get targets` when absent, and then also the persisted set.
   */
  targets?: TargetId[];
  /**
   * The persisted target set (`persistedTargets`): recorded in the lock, and what the lock's
   * previous record lost is contracted. Absent: nothing is contracted.
   */
  persisted?: TargetId[];
  secretPolicy?: SecretPolicy;
  /** `--frozen`: fail on any manifest/lock/file mismatch; restore only; write no lock or manifest. */
  frozen?: boolean;
}

async function runSync(
  ctx: PalmContext,
  opts: SyncOptions,
  state: SyncState,
  deps?: Partial<EngineDeps>,
): Promise<InstallResult> {
  const plan = await planSync(ctx, state);
  const empty: InstallResult = { outcomes: [], warnings: [], failures: [] };
  const result = plan.requests.length
    ? await installEntities(
        ctx,
        plan.requests,
        {
          scope: opts.scope,
          targets: state.targets,
          noSave: true,
          dropTargets: state.drop,
          ...(state.persisted ? { lockTargets: state.persisted } : {}),
          recordRequestErrors: true,
          ...(opts.frozen ? { frozen: true } : {}),
          ...(opts.secretPolicy ? { secretPolicy: opts.secretPolicy } : {}),
        },
        deps,
      )
    : empty;
  if (opts.frozen) result.failures.push(...frozenMismatches(state.lock, result.outcomes));
  return { ...result, outcomes: dedupeOutcomes([...plan.unchanged, ...result.outcomes]) };
}

async function pruneExtraneous(
  ctx: PalmContext,
  opts: SyncOptions,
  run: { extraneous: LockEntry[]; into: InstallResult },
  deps: Partial<EngineDeps> | undefined,
): Promise<void> {
  const { extraneous, into } = run;
  if (!opts.prune || opts.frozen || !extraneous.length) return;
  const r = await uninstallEntities(
    ctx,
    extraneous.map((e) => ({ kind: e.kind, name: e.name, origin: e.origin })),
    { scope: opts.scope },
    deps,
  );
  into.warnings.push(...r.warnings);
  into.failures.push(...(r.failures ?? []));
}

/** The sync's targets: the minimum set, the persisted set and what left it since the last sync. */
async function syncTargets(
  ctx: PalmContext,
  opts: SyncOptions,
  lock: Lock,
  deps?: Partial<EngineDeps>,
): Promise<Pick<SyncState, 'targets' | 'drop' | 'persisted'>> {
  const given = opts.targets?.length ? opts.targets : undefined;
  const targets = given ?? (await resolveTargets(ctx, { scope: opts.scope }, deps));
  const persisted = given ? opts.persisted : targets;
  const drop = persisted && lock.targets ? lock.targets.filter((t) => !persisted.includes(t)) : [];
  return { targets, drop, ...(persisted ? { persisted } : {}) };
}

/**
 * After a sync without failures, the lock records the persisted set it realises (so the next
 * contraction removes only what leaves it after this); never in dry run or --frozen.
 */
async function recordSyncedTargets(
  ctx: PalmContext,
  file: string,
  run: { state: SyncState; result: InstallResult; frozen: boolean },
): Promise<Lock> {
  const lock = await Lock.load(file);
  const { persisted } = run.state;
  if (ctx.flags.dryRun || run.frozen || !persisted || run.result.failures.length) return lock;
  if (lock.targets && lock.targets.join() === persisted.join()) return lock;
  lock.targets = [...persisted];
  if (lock.size || existsSync(file)) await lock.save(file);
  return lock;
}

/** `palm install` with no arguments: install what the manifest lists, report (or prune) the rest. */
export async function syncManifest(
  ctxIn: PalmContext,
  opts: SyncOptions,
  deps?: Partial<EngineDeps>,
): Promise<InstallResult & { extraneous: LockEntry[] }> {
  const ctx = scopedContext(ctxIn, opts.scope);
  const paths = ScopePaths.of(ctx, opts.scope);
  const manifest = await Manifest.load(paths.manifestFile);
  const lock = await Lock.load(paths.lockFile);
  const at = await syncTargets(ctx, opts, lock, deps);
  const state: SyncState = { scope: opts.scope, manifest, lock, ...at };
  if (opts.frozen) await assertFrozen(ctx, state);
  const result = await runSync(ctx, opts, state, deps);
  const frozen = !!opts.frozen;
  const after =
    ctx.flags.dryRun || frozen
      ? dryRunEntries(lock, result.outcomes)
      : (await recordSyncedTargets(ctx, paths.lockFile, { state, result, frozen })).entries;
  const wanted = manifestDeps(manifest);
  const extraneous = after.filter((e) => !e.via && !wanted.some((d) => satisfies(e, d)));
  await pruneExtraneous(ctx, opts, { extraneous, into: result }, deps);
  return { ...result, extraneous, failures: dedupeFailures(result.failures) };
}

function dedupeFailures(failures: InstallFailure[]): InstallFailure[] {
  const seen = new Set<string>();
  return failures.filter((f) => {
    const key = `${f.kind}:${f.name}@${f.origin}|${f.target ?? ''}|${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
