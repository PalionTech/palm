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
  type LockEntry,
  type PalmContext,
  type RemoveResult,
  TARGET_IDS,
  type TargetId,
} from '../core/types.js';
import { lockId, Via } from '../domain/entity-key.js';
import type { Lock } from '../domain/lock.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { isWithin } from '../lib/fs.js';
import { resolveEngineDeps } from './deps.js';
import { fragmentKey } from './diff.js';
import { type Run, runOf } from './jobs.js';
import { failure, failureOf, label, palmCommand, type Subject } from './report.js';
import { lockScope } from './runner.js';
import { openScope, type ScopeState, saveScope } from './scope.js';
import { MANIFEST_SOURCE } from './sources.js';
import { editedPaths } from './verify.js';

// ---------------------------------------------------------------------------
// undeploy (also used by install, bare install and update)
// ---------------------------------------------------------------------------

export interface UndeployJob {
  paths: ScopePaths;
  entries: LockEntry[];
  /** Lock paths and `file#at#key` fragments that stay (other entries own them). */
  protect: Set<string>;
  dryRun: boolean;
  /** Absolute real paths of local sources: palm never deletes inside them. */
  sources?: string[];
}

/** Every lock path and fragment key owned by entries other than `leaving`. */
export function protectedPaths(lock: Lock, leaving: readonly LockEntry[]): Set<string> {
  const gone = new Set(leaving.map(lockId));
  const out = new Set<string>();
  for (const e of lock.entries) {
    if (gone.has(lockId(e))) continue;
    for (const f of e.files) out.add(f);
    for (const m of e.merged ?? []) out.add(fragmentKey(m));
  }
  return out;
}

function subjectOf(e: LockEntry): Subject {
  return { kind: e.kind, name: e.name, source: e.source };
}

/** The entry's files palm may delete: inside the scope, outside every source, not protected. */
async function deletable(job: UndeployJob, entry: LockEntry, failures: InstallFailure[]) {
  const files: string[] = [];
  for (const f of entry.files) {
    if (job.protect.has(f)) continue;
    const { real, inside } = await job.paths.realInside(job.paths.abs(f));
    if (!inside) {
      const message = `refusing to delete ${f}: it resolves to ${real}, outside the scope`;
      failures.push(failure(subjectOf(entry), 'E_IO', { message }));
    } else if (!(job.sources ?? []).some((s) => isWithin(real, s))) files.push(f);
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
): Promise<{ failures: InstallFailure[]; warnings: string[] }> {
  const failures: InstallFailure[] = [];
  const warnings: string[] = [];
  for (const entry of job.entries) {
    const files = await deletable(job, entry, failures);
    const merged = (entry.merged ?? []).filter((m) => !job.protect.has(fragmentKey(m)));
    if (!files.length && !merged.length) continue;
    const view: LockEntry = { ...entry, files, merged };
    for (const id of targetsOf(entry)) {
      try {
        await deps
          .getTarget(id)
          .undeploy(view, job.paths.scope, job.paths.root, job.dryRun, ctx.env);
      } catch (e) {
        failures.push(failureOf(subjectOf(entry), e, id));
      }
    }
  }
  return { failures, warnings };
}

// ---------------------------------------------------------------------------
// removeEntities
// ---------------------------------------------------------------------------

type RemoveRef = EntityRefSpec & { source?: string };

function sourceName(state: ScopeState, query?: string): string | undefined {
  if (!query) return undefined;
  return state.sources.byName(query)?.name ?? query;
}

function ambiguity(
  ref: RemoveRef,
  hits: LockEntry[],
  scope: ScopeState['paths']['scope'],
): PalmError {
  const sources = [...new Set(hits.map((e) => e.source))];
  if (sources.length > 1)
    return new PalmError(
      'E_AMBIGUOUS',
      `"${ref.name}" is installed from ${sources.length} sources: ${sources.join(', ')}`,
      palmCommand('remove', [sources[0] as string, ref.name], scope),
    );
  const forms = hits.map((e) => `${e.kind}:${e.name}`);
  return new PalmError(
    'E_AMBIGUOUS',
    `"${ref.name}" names ${forms.length} kinds: ${forms.join(', ')}`,
    palmCommand('remove', [sources[0] as string, forms[0] as string], scope),
  );
}

/** The lock entries the refs name; absent ones print an info line (not an error). */
function select(ctx: PalmContext, state: ScopeState, refs: RemoveRef[]): LockEntry[] {
  const out: LockEntry[] = [];
  for (const ref of refs) {
    const source = sourceName(state, ref.source);
    const hits = state.lock.select({
      name: ref.name,
      ...(ref.kind ? { kind: ref.kind } : {}),
      ...(source ? { source } : {}),
    });
    if (!hits.length) ctx.log.info(`${ref.name} is not installed`);
    else if (hits.length > 1) throw ambiguity(ref, hits, state.paths.scope);
    else if (!out.some((e) => lockId(e) === lockId(hits[0] as LockEntry)))
      out.push(hits[0] as LockEntry);
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
async function removeGroup(run: Run, root: LockEntry): Promise<LockEntry[]> {
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
  run.result.failures.push(...report.failures);
  const failed = new Set(
    report.failures.map((f) => `${f.kind}:${f.name}@${f.source}`.toLowerCase()),
  );
  const gone = plan.removed.filter((e) => !failed.has(lockId(e).toLowerCase()));
  forget(state, gone);
  state.lock.reparent(plan.kept);
  return gone;
}

async function removeRoots(run: Run, rootEntries: LockEntry[]): Promise<LockEntry[]> {
  const gone: LockEntry[] = [];
  for (const root of rootEntries) {
    if (!run.state.lock.find(root, root.source)) continue;
    gone.push(...(await removeGroup(run, root)));
  }
  return gone;
}

/** DESIGN §6 "Remove". */
export async function removeEntities(
  ctx: PalmContext,
  refs: RemoveRef[],
  opts: InstallOptions & { exclude?: boolean },
  depsIn?: Partial<EngineDeps>,
): Promise<RemoveResult> {
  const deps = await resolveEngineDeps(depsIn);
  const state = await openScope(ctx, opts.scope, { deps, readOnly: true });
  const run = runOf(ctx, deps, state);
  return lockScope(ctx, state, async () => {
    const picked = select(ctx, state, refs);
    const removed = await removeRoots(run, await roots(run, picked, !!opts.exclude));
    await saveScope(state);
    return { removed, failures: run.result.failures, warnings: run.result.warnings };
  });
}
