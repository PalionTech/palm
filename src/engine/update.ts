/**
 * `palm update` (DESIGN §6 "Update"): re-resolve each git source's ref intent (the range, or
 * `--to` for the named sources), fetch and index the new sha, and plan per entry without
 * writing anything; then apply the plan like an install. Local sources are skipped: a bare
 * install re-renders them. `--yes` never covers executables: changed and new units go through
 * consent with the trusted version for the diff. Files the person edited stay unless `--force`.
 */
import { PalmError } from '../core/errors.js';
import { short } from '../core/hash.js';
import type {
  EngineDeps,
  ExecUnit,
  InstallResult,
  LockEntry,
  LockSource,
  PalmContext,
  Scope,
  UpdatePlan,
  UpdatePlanItem,
} from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import { sameName } from '../domain/entity-ref.js';
import { SourceRef } from '../domain/source.js';
import { resolveEngineDeps } from './deps.js';
import { manifestJobs } from './entries.js';
import { askForConsent, type Job, type Prepared, prepareJob, type Run, runOf } from './jobs.js';
import { protectedPaths, sourceRoots, undeploy } from './remove.js';
import { failureOf, palmCommand } from './report.js';
import { lockSourceOf, type Resolved, resolveSource } from './resolve.js';
import { applyAll, lockScope, prepareAll } from './runner.js';
import { openScope, type ScopeState, saveScope } from './scope.js';

type Scripts = { before: Map<string, Uint8Array>; after: Map<string, Uint8Array> };

/** What a plan knows beyond its public shape: the new sha per source and the scripts to diff. */
interface PlanMemo {
  shas: Map<string, string>;
  scripts: Map<string, Scripts>;
  /** Sources whose sha or ref intent the plan moves. */
  moved: Set<string>;
}

const memos = new WeakMap<UpdatePlan, PlanMemo>();

function versionLabel(ref: string | undefined, sha: string | undefined): string | undefined {
  if (!sha) return ref;
  const s = sha.slice(0, 7);
  return ref && ref !== sha ? `${ref} (${s})` : s;
}

function selectSources(state: ScopeState, names: string[], to?: string): SourceRef[] {
  if (to && !names.length) {
    const example = state.sources.all().find((s) => !s.isLocal)?.name ?? 'owner/repo';
    const hint = palmCommand('update', [example, '--to', to], state.paths.scope);
    throw new PalmError('E_USAGE', '--to moves the ref of the sources you name', hint);
  }
  return names.length ? names.map((n) => state.sources.resolveQuery(n)) : state.sources.all();
}

/** The source with its intent moved to `to` (in memory; applyUpdate writes palm.yaml). */
function intentOf(ref: SourceRef, to?: string): SourceRef {
  return to ? SourceRef.of({ ...ref.source, ref: to }) : ref;
}

function markOf(p: Prepared): UpdatePlanItem['mark'] {
  if (p.out.refusals.some((f) => !f.target)) return 'failed';
  if (!p.previous) return 'added';
  return p.previous.content !== p.out.content ? 'updated' : 'unchanged';
}

function itemOf(p: Prepared, range: { from?: string; to?: string }): UpdatePlanItem {
  const { entity } = p.job;
  const mark = markOf(p);
  const item: UpdatePlanItem = {
    mark,
    kind: entity.kind,
    name: entity.name,
    source: p.job.source.name,
    atRisk: [],
  };
  if (p.job.via) item.via = p.job.via;
  if (mark !== 'unchanged' && range.from) item.from = range.from;
  if (mark !== 'unchanged' && range.to) item.to = range.to;
  if (mark === 'failed') item.note = p.out.refusals[0]?.message;
  if (p.decision.kept.length) item.atRisk = [...p.decision.kept];
  return item;
}

/** The same entity rendered at the locked sha: the trusted version of its unit and scripts. */
async function renderedBefore(run: Run, job: Job, lockSha: string): Promise<Prepared | undefined> {
  try {
    const r = await resolveSource({
      ctx: run.ctx,
      deps: run.deps,
      state: run.state,
      ref: job.source,
      sha: lockSha,
    });
    const entity = r.index.entities.find(
      (e) => e.kind === job.entity.kind && sameName(e.name, job.entity.name),
    );
    return entity ? await prepareJob(run, { ...job, entity, checkout: r.checkout }) : undefined;
  } catch {
    return undefined;
  }
}

function scriptsOf(p?: Prepared): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const root = p?.out.closure.root;
  if (!p || !root) return out;
  for (const r of Object.values(p.out.renders))
    for (const f of r?.files ?? [])
      if (f.path.startsWith(`${root}/`)) out.set(f.path.slice(root.length + 1), f.data);
  return out;
}

/** A unit that is new or whose hash moved, with the trusted version and both script sets. */
async function execChange(
  run: Run,
  memo: PlanMemo,
  p: Prepared,
  lockSha?: string,
): Promise<UpdatePlanItem['exec']> {
  const unit = p.out.unit;
  if (!unit || p.previous?.exec?.hash === unit.hash) return undefined;
  // A program declined earlier stays out; its unit is news only when asked for by name.
  if (p.previous?.declined) return undefined;
  const before = lockSha && p.previous ? await renderedBefore(run, p.job, lockSha) : undefined;
  memo.scripts.set(unit.key, { before: scriptsOf(before), after: scriptsOf(p) });
  return before?.out.unit ? { unit, previous: before.out.unit } : { unit };
}

function removedItems(state: ScopeState, source: string, kept: Set<string>): UpdatePlanItem[] {
  return state.lock
    .entriesOf(source)
    .filter((e) => !kept.has(lockId(e)))
    .map((e) => ({
      mark: 'removed' as const,
      kind: e.kind,
      name: e.name,
      source,
      ...(e.via ? { via: e.via } : {}),
      atRisk: [],
    }));
}

async function resolveIntent(
  run: Run,
  plan: UpdatePlan,
  target: SourceRef,
): Promise<Resolved | undefined> {
  try {
    return await resolveSource({
      ctx: run.ctx,
      deps: run.deps,
      state: run.state,
      ref: target,
      refresh: true,
    });
  } catch (e) {
    plan.failures.push(failureOf({ kind: 'source', name: target.name, source: target.name }, e));
    return undefined;
  }
}

function withDefined(o: { from?: string | undefined; to?: string | undefined }): {
  from?: string;
  to?: string;
} {
  return { ...(o.from ? { from: o.from } : {}), ...(o.to ? { to: o.to } : {}) };
}

async function planGitSource(
  run: Run,
  plan: UpdatePlan,
  memo: PlanMemo,
  target: SourceRef,
): Promise<void> {
  const { state } = run;
  const ls: LockSource | undefined = state.lock.source(target.name);
  const r = await resolveIntent(run, plan, target);
  if (!r) return;
  const range = withDefined({
    from: versionLabel(ls?.resolved ?? ls?.ref, ls?.sha),
    to: versionLabel(r.checkout.ref, r.checkout.sha),
  });
  plan.sources.push({ name: target.name, ref: target.source.ref ?? '', ...range });
  if (r.checkout.sha) memo.shas.set(target.name, r.checkout.sha);
  const moved = r.checkout.sha !== ls?.sha || (target.source.ref ?? '') !== (ls?.ref ?? '');
  if (moved) memo.moved.add(target.name);
  const m = manifestJobs(state, target, r);
  plan.failures.push(...m.failures);
  const kept = new Set(m.missing);
  for (const job of m.jobs) {
    kept.add(lockId({ kind: job.entity.kind, name: job.entity.name, source: target.name }));
    const p = await prepareJob(run, job);
    const item = itemOf(p, range);
    const exec = await execChange(run, memo, p, ls?.sha);
    if (exec) item.exec = exec;
    plan.items.push(item);
  }
  plan.items.push(...removedItems(state, target.name, kept));
}

function skippedItems(state: ScopeState, ref: SourceRef): UpdatePlanItem[] {
  return state.lock.entriesOf(ref.name).map((e: LockEntry) => ({
    mark: 'skipped' as const,
    kind: e.kind,
    name: e.name,
    source: ref.name,
    atRisk: [],
    note: 'a directory source; palm install re-renders it',
  }));
}

/** DESIGN §6 "Update" step 1: nothing in the scope is written; local sources are skipped. */
export async function planUpdate(
  ctx: PalmContext,
  sources: string[],
  opts: { scope: Scope; to?: string },
  depsIn?: Partial<EngineDeps>,
): Promise<UpdatePlan> {
  const deps = await resolveEngineDeps(depsIn);
  const dry: PalmContext = { ...ctx, flags: { ...ctx.flags, dryRun: true } };
  const state = await openScope(dry, opts.scope, { deps, readOnly: true });
  const run = runOf(dry, deps, state, 'update');
  const plan: UpdatePlan = {
    scope: opts.scope,
    sources: [],
    items: [],
    failures: [],
    warnings: [],
  };
  const memo: PlanMemo = { shas: new Map(), scripts: new Map(), moved: new Set() };
  for (const ref of selectSources(state, sources, opts.to)) {
    if (ref.isLocal) plan.items.push(...skippedItems(state, ref));
    else await planGitSource(run, plan, memo, intentOf(ref, opts.to));
  }
  plan.warnings.push(...run.result.warnings);
  memos.set(plan, memo);
  return plan;
}

/**
 * How many changes the plan would apply (the `Apply N changes?` count): changed, added and
 * removed entries, plus each source whose sha or ref intent moves with no entry changing (a
 * re-pin still moves the lock, so `--dry-run` goes quiet after an update).
 */
export function planChanges(plan: UpdatePlan): number {
  const changed = plan.items.filter(
    (i) => i.mark === 'updated' || i.mark === 'added' || i.mark === 'removed',
  );
  const withItems = new Set(changed.map((i) => i.source));
  const repins = [...(memos.get(plan)?.moved ?? [])].filter((name) => !withItems.has(name));
  return changed.length + repins.length;
}

// ---------------------------------------------------------------------------
// applyUpdate
// ---------------------------------------------------------------------------

interface SourceUpdate {
  jobs: Job[];
  /** Lock entries the new version no longer declares. */
  gone: LockEntry[];
}

/** Moves one source to its planned sha (and `--to` intent): its jobs and the entries it dropped. */
async function sourceUpdate(
  run: Run,
  plan: UpdatePlan,
  name: string,
  to?: string,
): Promise<SourceUpdate> {
  const { state } = run;
  const declared = state.sources.byName(name);
  if (!declared || declared.isLocal) return { jobs: [], gone: [] };
  const ref = intentOf(declared, to);
  if (to) {
    state.manifest.addSource(
      ref.source,
      state.paths.scope === 'global' ? state.paths.palmHome : state.paths.root,
    );
    state.sources = state.sources.add(ref.source);
  }
  const sha = memos.get(plan)?.shas.get(name);
  const r = await resolveSource({
    ctx: run.ctx,
    deps: run.deps,
    state,
    ref,
    ...(sha ? { sha } : { refresh: true }),
  });
  state.lock.setSource(name, lockSourceOf(state, ref, r));
  const m = manifestJobs(state, ref, r);
  run.result.failures.push(...m.failures);
  const ids = m.jobs.map((j) => lockId({ kind: j.entity.kind, name: j.entity.name, source: name }));
  const kept = new Set([...m.missing, ...ids]);
  return { jobs: m.jobs, gone: state.lock.entriesOf(name).filter((e) => !kept.has(lockId(e))) };
}

/** Undeploys the entries a new version no longer declares and drops them from the lock. */
async function dropGone(run: Run, gone: LockEntry[]): Promise<void> {
  if (!gone.length) return;
  const { state, ctx, deps } = run;
  const protect = protectedPaths(state.lock, gone);
  const report = await undeploy(ctx, deps, {
    paths: state.paths,
    entries: gone,
    protect,
    dryRun: ctx.flags.dryRun,
    sources: await sourceRoots(state),
  });
  run.result.failures.push(...report.failures);
  for (const e of gone) {
    state.lock.remove(e);
    run.result.outcomes.push({ entry: e, status: 'removed', notes: [] });
  }
}

function previousUnits(plan: UpdatePlan): Record<string, ExecUnit> {
  const out: Record<string, ExecUnit> = {};
  for (const i of plan.items) if (i.exec?.previous) out[i.exec.unit.key] = i.exec.previous;
  return out;
}

/** DESIGN §6 "Update" step 4: install the planned sources at their new sha; consent for changed units. */
export async function applyUpdate(
  ctx: PalmContext,
  plan: UpdatePlan,
  opts: { scope: Scope; to?: string },
  depsIn?: Partial<EngineDeps>,
): Promise<InstallResult> {
  const deps = await resolveEngineDeps(depsIn);
  const state = await openScope(ctx, opts.scope, { deps });
  const run = runOf(ctx, deps, state, 'update');
  return lockScope(ctx, state, async () => {
    try {
      const updates: SourceUpdate[] = [];
      for (const s of plan.sources) updates.push(await sourceUpdate(run, plan, s.name, opts.to));
      const prepared = await prepareAll(
        run,
        updates.flatMap((u) => u.jobs),
      );
      await askForConsent(run, prepared, previousUnits(plan));
      await dropGone(
        run,
        updates.flatMap((u) => u.gone),
      );
      await applyAll(run, prepared);
    } finally {
      await saveScope(state);
    }
    run.result.failures.push(...plan.failures.filter((f) => f.kind === 'source'));
    return run.result;
  });
}

// ---------------------------------------------------------------------------
// reviewText
// ---------------------------------------------------------------------------

function text(data: Uint8Array | undefined): string {
  return data ? Buffer.from(data).toString('utf8') : '';
}

async function unitDiff(unit: ExecUnit, scripts: Scripts): Promise<string> {
  const { unifiedDiff } = await import('../exec/consent.js');
  const out: string[] = [`${unit.key}  ${short(unit.hash)}`];
  const paths = [...new Set([...scripts.before.keys(), ...scripts.after.keys()])].sort();
  for (const p of paths) {
    const a = text(scripts.before.get(p));
    const b = text(scripts.after.get(p));
    if (a !== b) out.push(unifiedDiff(a, b, p));
  }
  return out.join('\n');
}

/** `update --review` (0.2): each changed executable's scripts as a unified diff against the trusted version. */
export async function reviewText(
  ctx: PalmContext,
  plan: UpdatePlan,
  _deps: EngineDeps,
): Promise<string> {
  const memo = memos.get(plan);
  const blocks: string[] = [];
  for (const item of plan.items) {
    if (!item.exec) continue;
    const scripts = memo?.scripts.get(item.exec.unit.key);
    const head = `${item.exec.unit.key}  ${short(item.exec.unit.hash)}`;
    blocks.push(
      scripts ? await unitDiff(item.exec.unit, scripts) : `${head} (scripts not available)`,
    );
  }
  if (!blocks.length) ctx.log.debug('update --review: no executable changed');
  return blocks.join('\n\n');
}
