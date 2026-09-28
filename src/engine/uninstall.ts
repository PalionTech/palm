/**
 * `palm uninstall`: selection (what the refs name) → plan (reference-counted removal, pure) →
 * apply (undeploy from each target, delete the files palm wrote) → persist (lock, palm.yaml).
 *
 * Edit-safe: a file palm wrote that the user changed since (its hash no longer matches the lock)
 * is left on disk and reported as skipped, unless `--force`. Failures (a target that cannot
 * undeploy, a file that cannot be removed) are collected, never thrown: the entry stays in the
 * lock with what is still on disk, and the CLI exits 1.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { isPalmError, messageOf, PalmError } from '../core/errors.js';
import { hashPath } from '../core/hash.js';
import {
  type InstallFailure,
  KINDS,
  type Kind,
  type LockEntry,
  type PalmContext,
  type Scope,
  type TargetId,
} from '../core/types.js';
import { lockId, Via } from '../domain/entity-key.js';
import { filePaths, Lock, type RemovalPlan } from '../domain/lock.js';
import { Manifest } from '../domain/manifest.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { isWithin, removeEmptyParents } from '../lib/fs.js';
import { type EngineDeps, resolveEngineDeps } from './deps.js';
import { type EntityQuery, notInstalled } from './query.js';

// ---------------------------------------------------------------------------
// Removing what palm wrote (also used by install when it replaces an entry)
// ---------------------------------------------------------------------------

/** The directory `depth` levels below `base` on the way to `file`, or undefined outside `base`. */
function levelBelow(base: string, file: string, depth: number): string | undefined {
  if (!isWithin(file, base)) return undefined;
  return join(base, ...relative(base, file).split(sep).slice(0, depth));
}

/**
 * Remove the now-empty directories above `file`, never touching the harness container dirs:
 * pruning stops two levels below the scope root (`.claude/skills`) and one level below palm's
 * home (`~/.palm/hooks`), whichever lets more go.
 */
async function pruneEmptyDirs(paths: ScopePaths, file: string): Promise<void> {
  const stops = [levelBelow(paths.root, file, 2), levelBelow(paths.palmHome, file, 1)];
  const stop = stops
    .filter((d): d is string => d !== undefined)
    .sort((a, b) => a.length - b.length)[0];
  if (stop) await removeEmptyParents(file, stop);
}

/**
 * Containers palm itself creates and may remove once empty: the shared `.agents/skills`
 * (and `.agents`), and the project `.palm/hooks` (and `.palm`) / global `<palmHome>/hooks`.
 * Harness config dirs (`.claude`, `.codex`, `.cursor`, `.github`, `.vscode`) are never removed.
 * Each is `{ dir, top }`: `dir` and its parents up to and including `top`.
 */
function palmContainers(paths: ScopePaths): Array<{ dir: string; top: string }> {
  const agents = join(paths.root, '.agents');
  const hooksTop = paths.scope === 'project' ? paths.palmDir : paths.hooksDir;
  return [
    { dir: join(agents, 'skills'), top: agents },
    { dir: paths.hooksDir, top: hooksTop },
  ];
}

async function pruneContainers(paths: ScopePaths, touched: string[]): Promise<void> {
  for (const { dir, top } of palmContainers(paths)) {
    // removeEmptyParents starts at the parent of its first argument, i.e. at `dir`.
    if (touched.some((f) => isWithin(f, top)))
      await removeEmptyParents(join(dir, '_'), dirname(top));
  }
}

/** What to take off disk: the entries, the absolute paths that must survive, the user's edits. */
export interface UndeployJob {
  scope: Scope;
  entries: readonly LockEntry[];
  /** Absolute paths never deleted: shared merge targets and files of entries that stay. */
  protect: ReadonlySet<string>;
  /** Per entry (`lockId`), lock paths the user modified: left on disk and out of the undeploy. */
  keep?: ReadonlyMap<string, readonly string[]>;
}

export interface UndeployReport {
  failures: InstallFailure[];
  warnings: string[];
  /** Per entry (`lockId`) that failed: whether a target failed, and the lock paths still on disk. */
  failed: Map<string, { targets: boolean; files: string[] }>;
}

function failure(e: LockEntry, err: unknown, target?: TargetId): InstallFailure {
  const f: InstallFailure = {
    kind: e.kind,
    name: e.name,
    origin: e.origin,
    code: isPalmError(err) ? err.code : 'E_IO',
    message: messageOf(err),
  };
  if (target) f.target = target;
  if (isPalmError(err) && err.hint) f.hint = err.hint;
  return f;
}

/** One undeploy run: the report it fills and the paths it touched (for container pruning). */
interface Run {
  ctx: PalmContext;
  deps: EngineDeps;
  paths: ScopePaths;
  report: UndeployReport;
  touched: string[];
}

function markFailed(run: Run, e: LockEntry, change: { target?: boolean; file?: string }): void {
  const id = lockId(e);
  const f = run.report.failed.get(id) ?? { targets: false, files: [] };
  if (change.target) f.targets = true;
  if (change.file) f.files.push(change.file);
  run.report.failed.set(id, f);
}

/** Every target the entry went to removes its part; the entry passed on lists only `files`. */
async function undeployTargets(run: Run, entry: LockEntry, files: LockEntry['files']) {
  const { ctx, paths } = run;
  const job = { ...entry, files };
  for (const id of entry.targets) {
    try {
      await run.deps
        .getTarget(id)
        .undeploy(job, paths.scope, paths.root, ctx.flags.dryRun, ctx.env);
    } catch (err) {
      run.report.failures.push(failure(entry, err, id));
      markFailed(run, entry, { target: true });
    }
  }
}

/** Deletes one lock path palm owns (and the empty directories above it); a failure is recorded. */
async function removeOwned(run: Run, entry: LockEntry, file: string): Promise<void> {
  const abs = run.paths.safeAbs(file);
  if (!abs) return; // never delete outside the scope, whatever the lockfile says
  run.touched.push(abs);
  try {
    if (existsSync(abs)) await rm(abs, { recursive: true, force: true });
    await pruneEmptyDirs(run.paths, abs);
  } catch (err) {
    run.report.failures.push(
      failure(entry, new PalmError('E_IO', `could not remove ${abs}: ${messageOf(err)}`)),
    );
    markFailed(run, entry, { file });
  }
}

async function undeployOne(run: Run, entry: LockEntry, job: UndeployJob): Promise<void> {
  const keep = new Set(job.keep?.get(lockId(entry)) ?? []);
  const outside = filePaths(entry).filter((f) => !run.paths.safeAbs(f));
  if (outside.length)
    run.report.warnings.push(
      `${entry.kind} ${entry.name}: ignored lock paths outside the ${job.scope} scope: ${outside.join(', ')}`,
    );
  await undeployTargets(
    run,
    entry,
    entry.files.filter((f) => !keep.has(f.path)),
  );
  if (run.ctx.flags.dryRun) return;
  for (const file of filePaths(entry)) {
    const abs = run.paths.safeAbs(file);
    if (!keep.has(file) && abs && !job.protect.has(abs)) await removeOwned(run, entry, file);
  }
}

/**
 * Undeploy lock entries from every target they were installed to, then remove any listed file
 * a target left behind (palm owns everything in `files`), except protected paths and the
 * files `keep` names. Nothing is thrown: failures are reported.
 */
export async function undeploy(
  ctx: PalmContext,
  deps: EngineDeps,
  job: UndeployJob,
): Promise<UndeployReport> {
  const paths = ScopePaths.of(ctx, job.scope);
  const report: UndeployReport = { failures: [], warnings: [], failed: new Map() };
  const run: Run = { ctx, deps, paths, report, touched: [] };
  for (const entry of job.entries) await undeployOne(run, entry, job);
  if (!ctx.flags.dryRun) await pruneContainers(paths, run.touched);
  return report;
}

// ---------------------------------------------------------------------------
// palm uninstall
// ---------------------------------------------------------------------------

type RemovalRef = EntityQuery;

/** Files palm kept because the user changed them since palm wrote them. */
interface SkippedFiles {
  kind: Kind;
  name: string;
  origin: string;
  /** Lock paths (scope-relative at project scope, absolute at global). */
  files: string[];
}

export interface UninstallResult {
  /** Entries undeployed (in a dry run: that would be). */
  removed: LockEntry[];
  /** Modified files left on disk (`--force` removes them). */
  skipped: SkippedFiles[];
  failures: InstallFailure[];
  warnings: string[];
}

interface Selection {
  selected: LockEntry[];
  /** Named in palm.yaml but not installed: dropped from the manifest only. */
  manifestOnly: Array<{ kind: Kind; name: string }>;
  warnings: string[];
}

/** One ref's lock entries; E_AMBIGUOUS when the name is installed as several kinds. */
function matchesOf(lock: Lock, ref: RemovalRef): LockEntry[] {
  const matches = lock.select(ref);
  const kinds = [...new Set(matches.map((m) => m.kind))];
  if (kinds.length > 1) {
    throw new PalmError(
      'E_AMBIGUOUS',
      `"${ref.name}" is installed as ${kinds.join(' and ')}`,
      `Name the kind: ${kinds.map((k) => `palm uninstall ${k} ${ref.name}`).join(' | ')}`,
    );
  }
  return matches;
}

/**
 * The lock entries the refs name; a ref that names nothing installed but a manifest entry goes
 * to `manifestOnly` (one item per kind, one warning per ref). Throws E_NOT_FOUND / E_AMBIGUOUS.
 */
function selectForRemoval(
  lock: Lock,
  manifest: Manifest,
  refs: readonly RemovalRef[],
  scope: Scope,
): Selection {
  const out: Selection = { selected: [], manifestOnly: [], warnings: [] };
  for (const ref of refs) {
    const matches = matchesOf(lock, ref);
    if (matches.length) {
      out.selected.push(...matches);
      continue;
    }
    const kinds = (ref.kind ? [ref.kind] : KINDS).filter((k) => manifest.hasDep(k, ref.name));
    if (!kinds.length) throw notInstalled(ref, scope);
    for (const k of kinds) out.manifestOnly.push({ kind: k, name: ref.name });
    out.warnings.push(`${ref.name} was not installed; removed it from the manifest`);
  }
  return out;
}

/** Warnings for selected entries that entries which stay still list in `deps`. */
function stillUsedWarnings(lock: Lock, selected: LockEntry[], removed: LockEntry[]): string[] {
  const leaving = new Set(removed.map(lockId));
  return selected.flatMap((s) => {
    const users = lock.usersOf(s, leaving);
    if (!users.length) return [];
    const who = users.map((u) => `${u.kind} ${u.name}`).join(', ');
    return [`${who} still reference${users.length === 1 ? 's' : ''} ${s.kind} ${s.name}`];
  });
}

function keptWarning(k: RemovalPlan['kept'][number]): string {
  const via = k.via ? Via.parse(k.via) : undefined;
  const why = via ? `still needed by ${via.kind} ${via.name}` : 'listed in the manifest';
  return `kept ${k.entry.kind} ${k.entry.name}: ${why}`;
}

/** The loaded scope an uninstall works on. */
interface ScopeState {
  paths: ScopePaths;
  lock: Lock;
  manifest: Manifest;
  manifestBefore: string;
}

async function loadScope(ctx: PalmContext, scope: Scope): Promise<ScopeState> {
  const paths = ScopePaths.of(ctx, scope);
  const lock = await Lock.load(paths.lockFile);
  const manifest = await Manifest.load(paths.manifestFile);
  return { paths, lock, manifest, manifestBefore: JSON.stringify(manifest) };
}

interface UninstallPlan extends Selection, RemovalPlan {
  /** Absolute paths that must survive (shared merge targets, files of entries that stay). */
  protect: Set<string>;
}

/** What an uninstall of `refs` removes and keeps (pure over the loaded lock and manifest). */
function planUninstall(state: ScopeState, refs: readonly RemovalRef[]): UninstallPlan {
  const { lock, manifest, paths } = state;
  const selection = selectForRemoval(lock, manifest, refs, paths.scope);
  const { removed, kept } = lock.planRemoval(selection.selected, {
    listed: (e) => manifest.lists(e),
  });
  const warnings = [
    ...selection.warnings,
    ...stillUsedWarnings(lock, selection.selected, removed),
    ...kept.map(keptWarning),
  ];
  const protect = lock.protectedFiles(paths, removed);
  return { ...selection, removed, kept, protect, warnings };
}

/** Per removed entry, the files the user changed since palm wrote them (none with `--force`). */
async function userEdits(ctx: PalmContext, paths: ScopePaths, removed: LockEntry[]) {
  const edits = new Map<string, string[]>();
  if (ctx.flags.force) return edits;
  for (const e of removed) {
    const files = await Lock.modifiedFiles(e, paths, (abs) => hashPath(abs));
    if (files.length) edits.set(lockId(e), files);
  }
  return edits;
}

function skippedOf(removed: LockEntry[], edits: Map<string, string[]>): SkippedFiles[] {
  return removed.flatMap((e) => {
    const files = edits.get(lockId(e));
    return files ? [{ kind: e.kind, name: e.name, origin: e.origin, files }] : [];
  });
}

/** Drops removed direct installs (registry MCP servers also by registry name) from the manifest. */
function forgetRemoved(manifest: Manifest, removed: LockEntry[]): void {
  for (const e of removed) {
    if (e.via) continue;
    manifest.removeDep(e.kind, e.name);
    if (e.kind === 'mcp' && e.origin === 'registry') manifest.removeDep(e.kind, e.path);
  }
}

/** An entry that failed to go stays in the lock with what is still on disk (a retry finds it). */
function partialEntry(e: LockEntry, failed: { targets: boolean; files: string[] }): LockEntry {
  const left = new Set(failed.files);
  const next: LockEntry = { ...e, files: e.files.filter((f) => left.has(f.path)) };
  if (!failed.targets) delete next.merged;
  return next;
}

/** Writes the lock and palm.yaml after the removal (nothing in a dry run). */
async function persist(state: ScopeState, plan: UninstallPlan, report: UndeployReport) {
  const { lock, manifest, paths } = state;
  lock.reparent(plan.kept);
  for (const e of plan.removed) {
    const failed = report.failed.get(lockId(e));
    if (failed) lock.upsert(partialEntry(e, failed));
    else lock.remove(e);
  }
  forgetRemoved(manifest, plan.removed);
  for (const m of plan.manifestOnly) manifest.removeDep(m.kind, m.name);
  if (plan.removed.length || plan.kept.length) await lock.save(paths.lockFile);
  if (JSON.stringify(manifest) !== state.manifestBefore) await manifest.save(paths.manifestFile);
}

export async function uninstallEntities(
  ctx: PalmContext,
  refs: RemovalRef[],
  opts: { scope: Scope },
  depsIn?: Partial<EngineDeps>,
): Promise<UninstallResult> {
  const deps = await resolveEngineDeps(depsIn, { targets: true });
  const state = await loadScope(ctx, opts.scope);
  const plan = planUninstall(state, refs);
  const keep = await userEdits(ctx, state.paths, plan.removed);
  const job = { scope: opts.scope, entries: plan.removed, protect: plan.protect, keep };
  const report = await undeploy(ctx, deps, job);
  if (!ctx.flags.dryRun) await persist(state, plan, report);
  return {
    removed: plan.removed,
    skipped: skippedOf(plan.removed, keep),
    failures: report.failures,
    warnings: [...plan.warnings, ...report.warnings],
  };
}
