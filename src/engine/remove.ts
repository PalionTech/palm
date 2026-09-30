/**
 * `palm remove` (DESIGN §6 "Remove"): select installed entries by name, undeploy exactly the
 * lock's files and fragments, update the lock and palm.yaml. Removal is exact and symmetric
 * (PLAN.md invariant 8): only what the lock lists, matched by identity; removing something
 * absent is an info line. A file the person changed keeps its entity installed (exit 1).
 */
import { PalmError } from '../core/errors.js';
import {
  type EngineDeps,
  type EntityRefSpec,
  type InstallFailure,
  type InstallOptions,
  type KeptFile,
  type LockEntry,
  type PalmContext,
  type RemoveResult,
  TARGET_IDS,
  type TargetId,
} from '../core/types.js';
import { lockId, Via } from '../domain/entity-key.js';
import type { Lock } from '../domain/lock.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { type DeleteGuard, type DeleteVerdict, deleteGuard, judgeDelete } from './delete-guard.js';
import { resolveEngineDeps } from './deps.js';
import { fragmentKey } from './diff.js';
import { type Run, runOf } from './jobs.js';
import { notePreloadsLeaving } from './preloads.js';
import {
  failure,
  failureOf,
  label,
  logMark,
  palmCommand,
  type Subject,
  throwIfCancelled,
} from './report.js';
import { settle, withLockedScope } from './runner.js';
import { type ScopeState, shownPath } from './scope.js';
import { MANIFEST_SOURCE } from './sources.js';
import { editedPaths } from './verify.js';

// ---------------------------------------------------------------------------
// undeploy (also used by install, bare install and update)
// ---------------------------------------------------------------------------

export interface UndeployJob {
  paths: ScopePaths;
  entries: LockEntry[];
  /** Lock paths and `file#at#key` fragments that stay, with the entry that owns each one. */
  protect: ReadonlyMap<string, string>;
  dryRun: boolean;
  /** Absolute real paths of local sources: palm never deletes inside them. */
  sources?: string[];
}

/** What an undeploy did (`removed`) and did not do: failures, warnings, the files it left. */
export interface UndeployReport {
  failures: InstallFailure[];
  warnings: string[];
  kept: KeptFile[];
  /** Lock paths and `file#at#key` fragments it removed, or would remove in a dry run. */
  removed: string[];
}

/**
 * Every lock path and fragment key owned by entries other than `leaving`, with the owner
 * (`kind name from source`) for the "kept, owned by …" line.
 */
export function protectedPaths(lock: Lock, leaving: readonly LockEntry[]): Map<string, string> {
  const gone = new Set(leaving.map(lockId));
  const out = new Map<string, string>();
  for (const e of lock.entries) {
    if (gone.has(lockId(e))) continue;
    const owner = `${label(e)} from ${e.source}`;
    for (const f of e.files) if (!out.has(f)) out.set(f, owner);
    for (const m of e.merged ?? []) if (!out.has(fragmentKey(m))) out.set(fragmentKey(m), owner);
  }
  return out;
}

function subjectOf(e: LockEntry): Subject {
  return { kind: e.kind, name: e.name, source: e.source };
}

/** Each lock path of `entry` with its verdict; a path another entry lists is kept as it is. */
async function verdicts(g: DeleteGuard, job: UndeployJob, entry: LockEntry) {
  const out: Array<{ file: string; v: DeleteVerdict }> = [];
  for (const file of entry.files) {
    const owner = job.protect.get(file);
    const v: DeleteVerdict =
      owner === undefined
        ? await judgeDelete(g, file)
        : { action: 'keep', reason: 'owned', owner, real: '' };
    out.push({ file, v });
  }
  return out;
}

/**
 * The entry's files palm may delete: inside the scope, outside every source, not owned by
 * another entry, not reached through a link into another target's output (T1). The others are
 * reported as kept (C3, K18, R5); a linked path whose real file this entry deletes directly
 * anyway is left out without a word.
 */
async function deletable(
  g: DeleteGuard,
  job: UndeployJob,
  entry: LockEntry,
  report: UndeployReport,
) {
  const all = await verdicts(g, job, entry);
  const going = new Set(all.flatMap(({ v }) => (v.action === 'delete' ? [v.real] : [])));
  const files: string[] = [];
  for (const { file, v } of all) {
    if (v.action === 'delete') files.push(file);
    else if (v.action === 'outside') {
      const message = `refusing to delete ${file}: it resolves to ${v.real}, outside the scope`;
      report.failures.push(failure(subjectOf(entry), 'E_IO', { message }));
    } else if (!going.has(v.real))
      report.kept.push({
        kind: entry.kind,
        name: entry.name,
        source: entry.source,
        file,
        reason: v.reason,
        ...(v.owner ? { owner: v.owner } : {}),
      });
  }
  return files;
}

function targetsOf(entry: LockEntry): TargetId[] {
  const ids = Object.keys(entry.render) as TargetId[];
  return ids.length ? ids : [...TARGET_IDS];
}

/**
 * Removes exactly the entries' files and fragments through each target that holds them
 * (`Target.undeploy`: prunes emptied directories and containers). Failures are collected.
 */
export async function undeploy(
  ctx: PalmContext,
  deps: EngineDeps,
  job: UndeployJob,
): Promise<UndeployReport> {
  const report: UndeployReport = { failures: [], warnings: [], kept: [], removed: [] };
  const g = await deleteGuard(ctx, deps, job.paths, {
    staying: job.protect,
    sources: job.sources ?? [],
  });
  for (const entry of job.entries) {
    const files = await deletable(g, job, entry, report);
    const merged = (entry.merged ?? []).filter((m) => !job.protect.has(fragmentKey(m)));
    if (!files.length && !merged.length) continue;
    const view: LockEntry = { ...entry, files, merged };
    report.removed.push(...files, ...merged.map(fragmentKey));
    for (const id of targetsOf(entry)) {
      try {
        await deps
          .getTarget(id)
          .undeploy(view, job.paths.scope, job.paths.root, job.dryRun, ctx.env);
      } catch (e) {
        throwIfCancelled(e);
        report.failures.push(failureOf(subjectOf(entry), e, id));
      }
    }
  }
  return report;
}

/** A lock path or `file#at#key` fragment as people read it (`~/…` under -g). */
function shownRemoval(state: ScopeState, removed: string): string {
  const [file = removed, ...rest] = removed.split('#');
  return [shownPath(state, file), ...rest].join('#');
}

/**
 * Adds what an undeploy removed (or would remove) to the run's `removals` (J10', B2); with
 * `list` a dry run also names each one (`- would remove .agents/skills/x/SKILL.md`).
 */
export function noteRemovals(run: Run, removed: readonly string[], list = false): void {
  if (!removed.length) return;
  const shown = removed.map((r) => shownRemoval(run.state, r));
  run.result.removals = [...(run.result.removals ?? []), ...shown];
  if (list && run.ctx.flags.dryRun)
    for (const s of shown) logMark(run.ctx, '-', `would remove ${s}`);
}

/** The entry without what the person changed (or what palm cannot check): those stay on disk. */
export async function withoutEdits(run: Run, e: LockEntry): Promise<LockEntry> {
  const edited = run.ctx.flags.force ? [] : await editedPaths(run, e);
  const keep = new Set(edited ?? [...e.files, ...(e.merged ?? []).map(fragmentKey)]);
  const cmd = palmCommand('remove', [e.source, e.name], run.state.paths.scope, '--force');
  for (const p of keep)
    run.result.warnings.push(
      edited
        ? `kept ${p}: you changed it since palm wrote it (${cmd})`
        : `kept ${p}: palm cannot check it against source ${e.source}`,
    );
  const merged = (e.merged ?? []).filter((m) => !keep.has(fragmentKey(m)));
  return { ...e, files: e.files.filter((f) => !keep.has(f)), merged };
}

/** Withdraws the "no longer in source" failures of `entries`: they were removed instead. */
function withdrawNotFound(run: Run, entries: readonly LockEntry[]): void {
  const ids = new Set(entries.map((e) => lockId(e).toLowerCase()));
  const stays = run.result.failures.filter(
    (f) =>
      f.code !== 'E_NOT_FOUND' ||
      f.kind === 'source' ||
      !ids.has(`${f.kind}:${f.name}@${f.source}`.toLowerCase()),
  );
  run.result.failures.splice(0, run.result.failures.length, ...stays);
}

/**
 * R7': the entries a moving source's new commit no longer has go with the move (the person saw
 * them as `- would remove` and confirmed): undeployed with edited files kept, dropped from the
 * lock and palm.yaml, reported as removed.
 */
export async function dropWithMove(run: Run, entries: readonly LockEntry[]): Promise<void> {
  if (!entries.length) return;
  const { state, ctx, deps } = run;
  const protect = protectedPaths(state.lock, entries);
  const sources = await sourceRoots(state);
  const views: LockEntry[] = [];
  for (const e of entries) views.push(await withoutEdits(run, e));
  const job = { paths: state.paths, entries: views, protect, dryRun: ctx.flags.dryRun, sources };
  const report = await undeploy(ctx, deps, job);
  if (!ctx.flags.dryRun) run.touched = true;
  run.result.failures.push(...report.failures);
  noteRemovals(run, report.removed);
  withdrawNotFound(run, entries);
  for (const e of entries) {
    state.lock.remove(e);
    if (!e.via) state.manifest.removeEntry(e.source, e.kind, e.name);
    run.result.outcomes.push({ entry: e, status: 'removed', notes: [] });
  }
}

// ---------------------------------------------------------------------------
// removeEntities
// ---------------------------------------------------------------------------

type RemoveRef = EntityRefSpec & { source?: string };

function sourceName(state: ScopeState, query?: string): string | undefined {
  if (!query) return undefined;
  return state.sources.byName(query)?.name ?? query;
}

/** A typed name and the installed entries it answers to. */
interface Hits {
  ref: RemoveRef;
  hits: LockEntry[];
}

function kindsOf(hits: readonly LockEntry[]): number {
  return new Set(hits.map((e) => e.kind)).size;
}

/** One ambiguous name in words: two sources, or two kinds. */
function ambiguousPart({ ref, hits }: Hits): string {
  const sources = [...new Set(hits.map((e) => e.source))];
  if (sources.length > 1)
    return `"${ref.name}" is installed from ${sources.length} sources: ${sources.join(', ')}`;
  return `"${ref.name}" names ${hits.length} kinds: ${hits.map((e) => `${e.kind}:${e.name}`).join(', ')}`;
}

/**
 * O3, O7: one E_AMBIGUOUS for every ambiguous name, with one command that removes them: the
 * source of the first one, and each name with its kind where it names two kinds.
 */
function ambiguity(all: Hits[], ambiguous: Hits[], scope: ScopeState['paths']['scope']): PalmError {
  const source = (ambiguous[0] as Hits).hits[0]?.source as string;
  const words = all.map(({ ref, hits }) => {
    const here = hits.filter((e) => e.source === source);
    const pick = here[0] ?? hits[0];
    if (!pick || !ambiguous.some((a) => a.ref === ref))
      return ref.kind ? `${ref.kind}:${ref.name}` : ref.name;
    return kindsOf(here.length ? here : hits) > 1 ? `${pick.kind}:${pick.name}` : pick.name;
  });
  return new PalmError(
    'E_AMBIGUOUS',
    ambiguous.map(ambiguousPart).join('; '),
    palmCommand('remove', [source, ...words], scope),
  );
}

/** O3: on a terminal, which installed entry an ambiguous name means. */
async function pickEntry(ctx: PalmContext, { ref, hits }: Hits): Promise<LockEntry> {
  const options = hits.map((e) => ({ value: e, label: `${e.kind}:${e.name} from ${e.source}` }));
  return ctx.ui.pick(
    `"${ref.name}" names ${hits.length} installed entries; remove which?`,
    options,
  );
}

function hitsOf(state: ScopeState, ref: RemoveRef): Hits {
  const source = sourceName(state, ref.source);
  const hits = state.lock.select({
    name: ref.name,
    ...(ref.kind ? { kind: ref.kind } : {}),
    ...(source ? { source } : {}),
  });
  return { ref, hits };
}

/**
 * The lock entries the refs name. An absent one is no error: the CLI says `i <name> is not
 * installed` once (K24), from what `removed` lacks. A name that answers to two entries is asked
 * about on a terminal; without one, every such name is in one error (O3), before anything goes.
 */
async function select(
  ctx: PalmContext,
  state: ScopeState,
  refs: RemoveRef[],
): Promise<LockEntry[]> {
  const all = refs.map((ref) => hitsOf(state, ref));
  const ambiguous = all.filter((h) => h.hits.length > 1);
  if (ambiguous.length && !ctx.ui.isInteractive) throw ambiguity(all, ambiguous, state.paths.scope);
  const out: LockEntry[] = [];
  for (const h of all) {
    const one = h.hits.length > 1 ? await pickEntry(ctx, h) : h.hits[0];
    if (one && !out.some((e) => lockId(e) === lockId(one))) out.push(one);
  }
  return out;
}

async function memberDecision(run: Run, entry: LockEntry, exclude: boolean): Promise<boolean> {
  if (exclude) return true;
  const plugin = Via.parse(entry.via as string).name;
  const { ctx } = run;
  const question = `${entry.name} belongs to plugin ${plugin}; exclude it for the team in palm.yaml?`;
  if (ctx.ui.isInteractive && !ctx.flags.yes && (await ctx.ui.confirm(question, false)))
    return true;
  const scope = run.state.paths.scope;
  run.result.failures.push(
    failure(subjectOf(entry), 'E_USAGE', {
      message: `${entry.name} belongs to plugin ${plugin}: exclude it for the team, or remove the plugin`,
      hint: palmCommand('remove', [entry.source, entry.name], scope, '--exclude'),
    }),
  );
  return false;
}

/** Plugin members leave only with `--exclude` (recorded in the plugin's `exclude:`). */
async function roots(run: Run, picked: LockEntry[], exclude: boolean): Promise<LockEntry[]> {
  const out: LockEntry[] = [];
  for (const e of picked) {
    if (!e.via) {
      out.push(e);
      continue;
    }
    if (!(await memberDecision(run, e, exclude))) continue;
    run.state.manifest.excludeMember(e.source, Via.parse(e.via).name, {
      kind: e.kind,
      name: e.name,
    });
    out.push(e);
  }
  return out;
}

/** A failure for each entry whose files the person changed (or palm cannot check). */
async function editFailures(run: Run, entries: LockEntry[]): Promise<number> {
  if (run.ctx.flags.force) return 0;
  let n = 0;
  for (const e of entries) {
    const edited = await editedPaths(run, e);
    if (edited && !edited.length) continue;
    n++;
    const message = edited
      ? `${edited.join(', ')} ${edited.length === 1 ? 'was' : 'were'} modified since install`
      : `palm cannot check its files against source ${e.source}`;
    const hint = palmCommand('remove', [e.source, e.name], run.state.paths.scope, '--force');
    run.result.failures.push(failure(subjectOf(e), 'E_CONFLICT', { message, hint }));
  }
  return n;
}

function forget(state: ScopeState, removed: LockEntry[]): void {
  const { lock, manifest } = state;
  for (const e of removed) {
    lock.remove(e);
    if (e.source === MANIFEST_SOURCE) manifest.removeMcp(e.name);
    else if (!e.via) manifest.removeEntry(e.source, e.kind, e.name);
  }
  for (const name of Object.keys(lock.sources))
    if (!lock.entriesOf(name).length && !manifest.hasSource(name)) lock.removeSource(name);
}

/** Real paths of the scope's local sources: palm never deletes inside them. */
export async function sourceRoots(state: ScopeState): Promise<string[]> {
  const out: string[] = [];
  for (const ref of state.sources.all())
    if (ref.isLocal && ref.source.path)
      out.push((await state.paths.realInside(ref.source.path)).real);
  return out;
}

function keptWarning(
  root: LockEntry,
  kept: { entry: LockEntry; via?: string },
  scope: ScopeState['paths']['scope'],
): string {
  const other = kept.via ? Via.parse(kept.via).name : undefined;
  const both = other
    ? `; remove both with: ${palmCommand('remove', [root.source, root.name, other], scope)}`
    : '';
  return `${label(kept.entry)} stays: ${kept.via ?? 'palm.yaml'} still declares it${both}`;
}

/**
 * One named entry and what goes with it (a plugin's members that no other plugin declares). A
 * file the person changed in any of them keeps the whole group installed (unless --force).
 */
async function removeGroup(run: Run, root: LockEntry, kept: KeptFile[]): Promise<LockEntry[]> {
  const { state, ctx, deps } = run;
  const plan = state.lock.planRemoval([root], {
    listed: (e) => !e.via && state.manifest.hasEntry(e.source, e.kind, e.name),
  });
  if (await editFailures(run, plan.removed)) return [];
  for (const k of plan.kept) run.result.warnings.push(keptWarning(root, k, state.paths.scope));
  const protect = protectedPaths(state.lock, plan.removed);
  const sources = await sourceRoots(state);
  const job = {
    paths: state.paths,
    entries: plan.removed,
    protect,
    dryRun: ctx.flags.dryRun,
    sources,
  };
  const report = await undeploy(ctx, deps, job);
  if (!ctx.flags.dryRun) run.touched = true;
  run.result.failures.push(...report.failures);
  kept.push(...report.kept);
  const failed = new Set(
    report.failures.map((f) => `${f.kind}:${f.name}@${f.source}`.toLowerCase()),
  );
  const gone = plan.removed.filter((e) => !failed.has(lockId(e).toLowerCase()));
  forget(state, gone);
  state.lock.reparent(plan.kept);
  return gone;
}

async function removeRoots(
  run: Run,
  rootEntries: LockEntry[],
  kept: KeptFile[],
): Promise<LockEntry[]> {
  const gone: LockEntry[] = [];
  for (const root of rootEntries) {
    if (!run.state.lock.find(root, root.source)) continue;
    gone.push(...(await removeGroup(run, root, kept)));
  }
  return gone;
}

/**
 * DESIGN §6 "Remove". Files another entry owns or that lie inside a declared source stay and
 * come back as `kept`; a skill an installed agent preloads prints the preload line (K3).
 * palm.yaml and the lock are written only when something was removed or nothing failed.
 */
export async function removeEntities(
  ctx: PalmContext,
  refs: RemoveRef[],
  opts: InstallOptions & { exclude?: boolean },
  depsIn?: Partial<EngineDeps>,
): Promise<RemoveResult> {
  const deps = await resolveEngineDeps(depsIn);
  return withLockedScope(ctx, opts.scope, { deps, readOnly: true }, async (state) => {
    const run = runOf(ctx, deps, state);
    const picked = await select(ctx, state, refs);
    const kept: KeptFile[] = [];
    const removed = await removeRoots(run, await roots(run, picked, !!opts.exclude), kept);
    await notePreloadsLeaving(run, removed);
    await settle(run, false);
    const out: RemoveResult = {
      removed,
      failures: run.result.failures,
      warnings: run.result.warnings,
    };
    if (kept.length) out.kept = kept;
    return out;
  });
}
