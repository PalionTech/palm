/**
 * `palm uninstall`: selection (what the refs name) → plan (reference-counted removal, pure) →
 * apply (undeploy from each target, delete the files palm wrote) → persist (lock, palm.yaml).
 *
 * Reference counting: a named entity another installed plugin/agent still declares stays,
 * re-parented to it (`via`), and leaves palm.yaml. Edit-safe: an entity with a file the user
 * changed since palm wrote it (its hash no longer matches the lock) is not removed at all,
 * unless `--force`: it stays installed and in the lock, with what it pulled in, and is a
 * failure whose hint is the `--force` command. Failures (that refusal, a target that cannot
 * undeploy, a file that cannot be removed) are collected, never thrown; the CLI exits 1.
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
import { isWithin, removeEmptyParents, removeEmptyTree } from '../lib/fs.js';
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
  /** The scope's lock: harness directories it says palm created are removed once empty. */
  lock?: Lock;
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
  const outside = filePaths(entry).filter((f) => !run.paths.safeAbs(f));
  if (outside.length)
    run.report.warnings.push(
      `${entry.kind} ${entry.name}: ignored lock paths outside the ${job.scope} scope: ${outside.join(', ')}`,
    );
  await undeployTargets(run, entry, entry.files);
  if (run.ctx.flags.dryRun) return;
  for (const file of filePaths(entry)) {
    const abs = run.paths.safeAbs(file);
    if (abs && !job.protect.has(abs)) await removeOwned(run, entry, file);
  }
}

/**
 * Undeploy lock entries from every target they were installed to, then remove any listed file
 * a target left behind (palm owns everything in `files`), except protected paths. Nothing is
 * thrown: failures are reported.
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
  if (!ctx.flags.dryRun && job.lock) await pruneCreatedDirs(paths, job.lock);
  return report;
}

/**
 * Harness directories palm created that hold no file any more go (with the empty directories
 * left inside them); the lock forgets any that are gone.
 */
async function pruneCreatedDirs(paths: ScopePaths, lock: Lock): Promise<void> {
  const dirs = lock.createdDirs ?? [];
  for (const d of dirs) {
    const abs = paths.safeAbs(d);
    if (abs && abs !== paths.root) await removeEmptyTree(abs);
  }
  const left = dirs.filter((d) => existsSync(paths.abs(d)));
  if (left.length) lock.createdDirs = left;
  else delete lock.createdDirs;
}

// ---------------------------------------------------------------------------
// palm uninstall
// ---------------------------------------------------------------------------

type RemovalRef = EntityQuery;

export interface UninstallResult {
  /** Entries undeployed (in a dry run: that would be). */
  removed: LockEntry[];
  /** Failures: an entity kept because the user changed its files (`--force` removes it), a target or file that could not go. */
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

/** Why a dependency stays; for one the user named, the command that removes it with its user. */
function keptWarning(k: RemovalPlan['kept'][number], named: boolean, scope: Scope): string {
  const via = k.via ? Via.parse(k.via) : undefined;
  const head = `kept ${k.entry.kind} ${k.entry.name}`;
  if (!via) return `${head}: listed in the manifest`;
  const why = `${head}: still needed by ${via.kind} ${via.name}`;
  const g = scope === 'global' ? ' -g' : '';
  return named ? `${why} (to remove both: palm uninstall ${via.kind} ${via.name}${g})` : why;
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

/**
 * What an uninstall of `refs` removes and keeps (pure over the loaded lock and manifest). A
 * named entity that a plugin/agent staying installed still declares is kept and re-parented
 * to it; a dependency stays when the manifest lists it (and it was not named) or another
 * entry still declares it.
 */
function planUninstall(state: ScopeState, refs: readonly RemovalRef[]): UninstallPlan {
  const { lock, manifest, paths } = state;
  const selection = selectForRemoval(lock, manifest, refs, paths.scope);
  const named = new Set(selection.selected.map(lockId));
  const { removed, kept } = lock.planRemoval(selection.selected, {
    listed: (e) => !named.has(lockId(e)) && manifest.lists(e),
    checkRoots: true,
  });
  const warnings = [
    ...selection.warnings,
    ...kept.map((k) => keptWarning(k, named.has(lockId(k.entry)), paths.scope)),
  ];
  const protect = lock.protectedFiles(paths, removed);
  return { ...selection, removed, kept, protect, warnings };
}

/** The command that removes `e` despite the user's edits. */
function forceCommand(e: LockEntry, scope: Scope, lock: Lock): string {
  const origin = lock.findAll(e).length > 1 ? `@${e.origin}` : '';
  return `palm uninstall ${e.kind} ${e.name}${origin}${scope === 'global' ? ' -g' : ''} --force`;
}

function editRefusal(e: LockEntry, files: string[], state: ScopeState): InstallFailure {
  const them = files.length === 1 ? `${files[0]} was` : `${files.join(', ')} were`;
  const err = new PalmError(
    'E_CONFLICT',
    `${them} modified since install; rerun with --force to remove`,
    `palm kept this ${e.kind} installed; to remove it and your edits: ${forceCommand(e, state.paths.scope, state.lock)}`,
  );
  return failure(e, err);
}

/**
 * Without `--force`, entries with files the user changed since palm wrote them stay installed
 * (and so does everything they pulled in): the plan loses them, a kept dependency whose parent
 * goes becomes direct, and each refusal is a failure.
 */
async function holdEdited(
  ctx: PalmContext,
  state: ScopeState,
  plan: UninstallPlan,
): Promise<InstallFailure[]> {
  if (ctx.flags.force) return [];
  const { lock, paths } = state;
  const refused: LockEntry[] = [];
  const failures: InstallFailure[] = [];
  for (const e of plan.removed) {
    const files = await Lock.modifiedFiles(e, paths, (abs) => hashPath(abs));
    if (!files.length) continue;
    refused.push(e);
    failures.push(editRefusal(e, files, state));
  }
  if (!refused.length) return failures;
  const held = new Set(lock.dependentsOf(refused).map(lockId));
  plan.removed = plan.removed.filter((e) => !held.has(lockId(e)));
  const leaving = new Set(plan.removed.map(lockId));
  for (const e of lock.entries.filter((x) => held.has(lockId(x)))) {
    const parent = lock.parentOf(e);
    if (parent && leaving.has(lockId(parent))) plan.kept.push({ entry: e }); // now direct
  }
  plan.protect = lock.protectedFiles(paths, plan.removed);
  return failures;
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
  // A named entity kept for another entry leaves palm.yaml: it is that entry's dependency now.
  const named = new Set(plan.selected.map(lockId));
  forgetRemoved(
    manifest,
    plan.kept.filter((k) => k.via && named.has(lockId(k.entry))).map((k) => k.entry),
  );
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
  const refused = await holdEdited(ctx, state, plan);
  const job = { scope: opts.scope, entries: plan.removed, protect: plan.protect, lock: state.lock };
  const report = await undeploy(ctx, deps, job);
  if (!ctx.flags.dryRun) await persist(state, plan, report);
  return {
    removed: plan.removed,
    failures: [...refused, ...report.failures],
    warnings: [...plan.warnings, ...report.warnings],
  };
}
