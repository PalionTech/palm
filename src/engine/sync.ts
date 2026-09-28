/**
 * Bare `palm install`: make the scope match palm.yaml + palm.lock.yaml. Entries the lock
 * already realises stay untouched (no network); others are replayed from the commit the lock
 * names, or resolved fresh when palm.yaml asks for something the lock does not have. The
 * manifest's targets are the full set: an entry on a target palm.yaml dropped loses it.
 * `--frozen` first checks that palm.yaml, the lock and the files agree, and writes nothing.
 */
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

function sameTargets(a: readonly TargetId[], b: readonly TargetId[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
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
function upToDate(e: LockEntry, d: ManifestDep, targets: TargetId[]): boolean {
  if (e.via) return false; // promote to a direct install
  if (e.transform !== TRANSFORM_VERSION) return false; // rendered by an older palm
  if (!sameTargets(e.targets, targets)) return false;
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
  targets: TargetId[];
}

/** Per manifest dependency: unchanged (lock realises it, files intact), a replay, or fresh. */
function planSync(ctx: PalmContext, state: SyncState): SyncPlan {
  const { lock, targets } = state;
  const paths = ScopePaths.of(ctx, state.scope);
  const plan: SyncPlan = { unchanged: [], requests: [] };
  for (const d of manifestDeps(state.manifest)) {
    const present = realising(lock, d);
    const current = !!present && !ctx.flags.force && upToDate(present, d, targets);
    if (present && current && lock.intact(present, paths)) {
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
function manifestDifferences(wanted: ManifestDep[], lock: Lock, targets: TargetId[]): string[] {
  const out: string[] = [];
  for (const d of wanted) {
    const e = lock.entries.find((x) => !x.via && satisfies(x, d));
    const why = e ? depMismatch(e, d) : undefined;
    if (!e) out.push(`${depLabel(d)}: in palm.yaml, not in palm.lock.yaml`);
    else if (why) out.push(`${depLabel(d)}: palm.yaml ${why}`);
  }
  for (const e of lock.entries) out.push(...entryDifferences(e, { wanted, lock, targets }));
  return out;
}

/** What is wrong with one lock entry under --frozen: extraneous, orphaned, stale, other targets. */
function entryDifferences(
  e: LockEntry,
  at: { wanted: ManifestDep[]; lock: Lock; targets: TargetId[] },
): string[] {
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
  if (!sameTargets(e.targets, at.targets))
    out.push(
      `${label}: locked for ${e.targets.join(', ') || 'no target'}, palm.yaml targets ${at.targets.join(', ')}`,
    );
  return out;
}

/**
 * `--frozen`: palm.yaml and palm.lock.yaml must agree (every dependency locked as written,
 * nothing extra, same targets, current transform) and no locked file may have been edited.
 * Missing files are fine: they are restored from the locked commits. E_CONFLICT lists every
 * difference; nothing has been written.
 */
async function assertFrozen(ctx: PalmContext, state: SyncState): Promise<void> {
  const { manifest, lock, targets } = state;
  const diffs = manifestDifferences(manifestDeps(manifest), lock, targets);
  const paths = ScopePaths.of(ctx, state.scope);
  for (const e of lock.entries)
    for (const f of await modifiedFiles(paths, [e]))
      diffs.push(`${f} (${e.kind} ${e.name}): changed since palm wrote it`);
  if (!diffs.length) return;
  throw new PalmError(
    'E_CONFLICT',
    `palm.yaml, palm.lock.yaml and the installed files do not match (--frozen):\n${diffs.map((x) => `  - ${x}`).join('\n')}`,
    'run palm install without --frozen, review the result and commit palm.yaml and palm.lock.yaml',
  );
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
  targets?: TargetId[];
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
  const plan = planSync(ctx, state);
  const empty: InstallResult = { outcomes: [], warnings: [], failures: [] };
  const result = plan.requests.length
    ? await installEntities(
        ctx,
        plan.requests,
        {
          scope: opts.scope,
          targets: state.targets,
          noSave: true,
          exactTargets: true,
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
  const targets = opts.targets?.length
    ? opts.targets
    : await resolveTargets(ctx, { scope: opts.scope }, deps);
  const state: SyncState = { scope: opts.scope, manifest, lock, targets };
  if (opts.frozen) await assertFrozen(ctx, state);
  const result = await runSync(ctx, opts, state, deps);
  const after =
    ctx.flags.dryRun || opts.frozen
      ? dryRunEntries(lock, result.outcomes)
      : (await Lock.load(paths.lockFile)).entries;
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
