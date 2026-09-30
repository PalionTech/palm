/**
 * `palm update` (DESIGN §6 "Update"): re-resolve each git source's ref intent (the range, or
 * `--to` for the named sources), fetch and index the new sha, and plan per entry without
 * writing anything; then apply the plan like an install. Local sources are skipped: a bare
 * install re-renders them. `--yes` never covers executables: changed and new units go through
 * consent with the trusted version for the diff. Files the person edited stay unless `--force`.
 * A source moves as a unit (V4): an entry refused at the new commit, or a changed program the
 * person declines, keeps the whole source at its locked commit, and nothing of it is written.
 */
import { PalmError } from '../core/errors.js';
import { short } from '../core/hash.js';
import type {
  EngineDeps,
  ExecUnit,
  InstallResult,
  LockEntry,
  PalmContext,
  Scope,
  SourceIndex,
  UpdatePlan,
  UpdatePlanItem,
  UpdatePlanSource,
} from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import { sameName } from '../domain/entity-ref.js';
import { SourceRef } from '../domain/source.js';
import { baseDirOf } from './declare.js';
import { resolveEngineDeps } from './deps.js';
import { manifestJobs } from './entries.js';
import { type Job, type Prepared, prepareJob, type Run, runOf } from './jobs.js';
import { type Move, moveOf, versionLabel } from './moves.js';
import { noteRemovals, protectedPaths, sourceRoots, undeploy } from './remove.js';
import { failureOf, palmCommand, throwIfCancelled } from './report.js';
import { lockSourceOf, type Resolved, resolveSource } from './resolve.js';
import { applyRun, prepareRun, settle, withLockedScope } from './runner.js';
import { openScope, type ScopeState } from './scope.js';
import { describePin, newPreloads, newPrograms, refOnlyReason } from './update-notes.js';

type Scripts = { before: Map<string, Uint8Array>; after: Map<string, Uint8Array> };

/** What a plan knows beyond its public shape: the new sha per source and the scripts to diff. */
interface PlanMemo {
  shas: Map<string, string>;
  scripts: Map<string, Scripts>;
  /** Sources whose sha or ref intent the plan moves. */
  moved: Set<string>;
}

const memos = new WeakMap<UpdatePlan, PlanMemo>();

function label(ref: string | undefined, sha: string | undefined): string | undefined {
  return versionLabel(ref, sha) || undefined;
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

/**
 * One plan line per entry; when the source's commit moves, an entry whose bytes do not change
 * says so (`same content`, C12) and every entry carries the move.
 */
function itemOf(
  p: Prepared,
  range: { from?: string; to?: string },
  moved: boolean,
): UpdatePlanItem {
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
  const shown = mark !== 'unchanged' || moved;
  if (shown && range.from) item.from = range.from;
  if (shown && range.to) item.to = range.to;
  if (mark === 'unchanged' && moved) item.note = 'same content';
  if (mark === 'failed') item.note = p.out.refusals[0]?.message;
  if (p.decision.kept.length) item.atRisk = [...p.decision.kept];
  return item;
}

/** The source's index at a commit (the locked one), or undefined when unavailable. */
async function indexAt(run: Run, ref: SourceRef, sha: string): Promise<Resolved | undefined> {
  try {
    const { ctx, deps, state } = run;
    return await resolveSource({ ctx, deps, state, ref, sha });
  } catch (e) {
    throwIfCancelled(e);
    return undefined;
  }
}

/** The same entity rendered at the locked sha: the trusted version of its unit and scripts. */
async function renderedBefore(run: Run, job: Job, lockSha: string): Promise<Prepared | undefined> {
  const r = await indexAt(run, job.source, lockSha);
  const entity = r?.index.entities.find(
    (e) => e.kind === job.entity.kind && sameName(e.name, job.entity.name),
  );
  if (!r || !entity) return undefined;
  return prepareJob(run, { ...job, entity, checkout: r.checkout }).catch(() => undefined);
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
  const before = lockSha && p.previous ? await renderedBefore(run, p.job, lockSha) : undefined;
  memo.scripts.set(unit.key, { before: scriptsOf(before), after: scriptsOf(p) });
  return before?.out.unit ? { unit, previous: before.out.unit } : { unit };
}

/**
 * V3' S8: a program whose command or scripts changed is a change of its own, never
 * `unchanged … same content` (its content hash covers only the hook's own files).
 */
function programItem(item: UpdatePlanItem, exec: NonNullable<UpdatePlanItem['exec']>): void {
  item.exec = exec;
  if (item.mark !== 'unchanged') return;
  item.mark = 'updated';
  delete item.note;
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
    const { ctx, deps, state } = run;
    return await resolveSource({ ctx, deps, state, ref: target, refresh: true });
  } catch (e) {
    throwIfCancelled(e);
    plan.failures.push(failureOf({ kind: 'source', name: target.name, source: target.name }, e));
    return undefined;
  }
}

/** The source row: versions, how far a pin is behind (D4, C19), why it counts (D11). */
async function sourceRow(run: Run, target: SourceRef, r: Resolved): Promise<UpdatePlanSource> {
  const ls = run.state.lock.source(target.name);
  const from = label(ls?.resolved ?? ls?.ref, ls?.sha);
  const to = label(r.checkout.ref, r.checkout.sha);
  const row: UpdatePlanSource = {
    name: target.name,
    ref: target.source.ref ?? '',
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
  await describePin(run, target, r, row);
  const reason = r.checkout.sha === ls?.sha ? refOnlyReason(target, ls) : undefined;
  if (reason) row.reason = reason;
  return row;
}

/** One source's planning facts: the new resolution, the row, and the index at the locked commit. */
interface SourcePlan {
  target: SourceRef;
  r: Resolved;
  row: UpdatePlanSource;
  lockSha?: string;
  /** The commit moves (not only the ref intent). */
  moved: boolean;
  old?: SourceIndex;
}

/** The plan items of one source's entries; returns the lock ids they keep. */
async function planEntries(
  run: Run,
  plan: UpdatePlan,
  memo: PlanMemo,
  s: SourcePlan,
): Promise<Job[]> {
  const m = manifestJobs(run.state, s.target, s.r);
  // R7': on a move, an entry the new commit no longer has goes with it (a `removed` item).
  plan.failures.push(
    ...(s.moved ? m.failures.filter((f) => f.code !== 'E_NOT_FOUND') : m.failures),
  );
  const kept = new Set(s.moved ? [] : m.missing);
  for (const job of m.jobs) {
    kept.add(lockId({ kind: job.entity.kind, name: job.entity.name, source: s.target.name }));
    const p = await prepareJob(run, job);
    const item = itemOf(p, s.row, s.moved);
    const exec = await execChange(run, memo, p, s.lockSha);
    if (exec) programItem(item, exec);
    plan.items.push(item);
    if (s.moved) newPreloads(run, p, { index: s.r.index, ...(s.old ? { old: s.old } : {}) });
  }
  plan.items.push(...removedItems(run.state, s.target.name, kept));
  return m.jobs;
}

async function planGitSource(
  run: Run,
  plan: UpdatePlan,
  memo: PlanMemo,
  target: SourceRef,
): Promise<void> {
  const ls = run.state.lock.source(target.name);
  const r = await resolveIntent(run, plan, target);
  if (!r) return;
  const row = await sourceRow(run, target, r);
  plan.sources.push(row);
  if (r.checkout.sha) memo.shas.set(target.name, r.checkout.sha);
  const moved = r.checkout.sha !== ls?.sha;
  if (moved || (target.source.ref ?? '') !== (ls?.ref ?? '')) memo.moved.add(target.name);
  const old = ls?.sha && moved ? (await indexAt(run, target, ls.sha))?.index : undefined;
  const s: SourcePlan = { target, r, row, moved, ...(ls?.sha ? { lockSha: ls.sha } : {}) };
  if (old) s.old = old;
  const jobs = await planEntries(run, plan, memo, s);
  if (moved) newPrograms(run, plan, { target, index: r.index, jobs, ...(old ? { old } : {}) });
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
  /** The move of the source's commit, held back as a unit when an entry cannot follow (V4). */
  move?: Move;
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
    state.manifest.addSource(ref.source, baseDirOf(state));
    state.sources = state.sources.add(ref.source);
  }
  const sha = memos.get(plan)?.shas.get(name);
  const { ctx, deps } = run;
  const r = await resolveSource({ ctx, deps, state, ref, ...(sha ? { sha } : { refresh: true }) });
  const move = moveOf(state, ref, r.checkout, to ? declared : undefined);
  state.lock.setSource(name, lockSourceOf(state, ref, r));
  const m = manifestJobs(state, ref, r);
  run.result.failures.push(...m.failures);
  const ids = m.jobs.map((j) => lockId({ kind: j.entity.kind, name: j.entity.name, source: name }));
  const kept = new Set([...m.missing, ...ids]);
  const gone = state.lock.entriesOf(name).filter((e) => !kept.has(lockId(e)));
  return { jobs: m.jobs, gone, ...(move ? { move } : {}) };
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
  if (!ctx.flags.dryRun) run.touched = true;
  run.result.failures.push(...report.failures);
  noteRemovals(run, report.removed);
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

/**
 * DESIGN §6 "Update" step 4: install the planned sources at their new sha; consent for changed
 * units. The plan was confirmed already; a source that cannot move as a unit stays (V4).
 */
export async function applyUpdate(
  ctx: PalmContext,
  plan: UpdatePlan,
  opts: { scope: Scope; to?: string },
  depsIn?: Partial<EngineDeps>,
): Promise<InstallResult> {
  const deps = await resolveEngineDeps(depsIn);
  return withLockedScope(ctx, opts.scope, { deps }, async (state) => {
    const run = runOf(ctx, deps, state, 'update');
    let failed = true;
    try {
      const updates: SourceUpdate[] = [];
      for (const s of plan.sources) updates.push(await sourceUpdate(run, plan, s.name, opts.to));
      const moves = updates.flatMap((u) => (u.move ? [u.move] : []));
      const gone = updates.flatMap((u) => u.gone);
      const jobs = updates.flatMap((u) => u.jobs);
      const leaving = new Set(gone.map(lockId));
      const previous = previousUnits(plan);
      const ready = await prepareRun(run, jobs, { moves, leaving, previous, confirmed: true });
      await dropGone(
        run,
        gone.filter((e) => !ready.held.has(e.source)),
      );
      await applyRun(run, ready);
      failed = false;
    } finally {
      await settle(run, failed);
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
