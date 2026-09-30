/**
 * Writing one prepared entity (DESIGN §6 steps 8 and 9): `Target.apply` per target that needs
 * it (a transaction per target), the lock entry built from the renders, then what the previous
 * entry listed and the new one does not is undeployed. Failures are recorded, never thrown: a
 * target that fails leaves the others (`partial`), and the lock keeps what succeeded.
 */
import { isPalmError } from '../core/errors.js';
import {
  type InstallOutcome,
  type LockEntry,
  type LockMerged,
  type OutcomeStatus,
  type Rendered,
  TARGET_IDS,
  type TargetId,
} from '../core/types.js';
import { withDeclined, withTrust } from '../exec/trust.js';
import { deepEqual } from '../lib/object.js';
import { fragmentKey } from './diff.js';
import type { Prepared, Run } from './jobs.js';
import { protectedPaths, sourceRoots, undeploy } from './remove.js';
import { failure, failureOf, installCommand, type Subject } from './report.js';
import { literalsBefore, rotationWarnings } from './rotate.js';
import { noteWritten, persistTargets } from './scope.js';

function subjectOf(p: Prepared): Subject {
  return { kind: p.job.entity.kind, name: p.job.entity.name, source: p.job.source.name };
}

function baseEntry(p: Prepared): LockEntry {
  const { job, out } = p;
  const e: LockEntry = {
    kind: job.entity.kind,
    name: job.entity.name,
    source: job.source.name,
    path: job.entity.path,
    content: out.content,
    render: {},
    files: [],
  };
  if (job.via) e.via = job.via;
  if (job.narrowed) e.targets = job.narrowed;
  if (job.at) e.at = job.at;
  if (job.members?.length) e.deps = job.members;
  if (p.previous?.trust?.length) e.trust = [...p.previous.trust];
  return e;
}

function lockMerged(f: LockMerged): LockMerged {
  return { file: f.file, at: f.at, id: f.id, key: f.key };
}

/** Keeps what the previous entry had on targets that failed this time. */
function carry(
  entry: LockEntry,
  previous: LockEntry,
  failed: Set<TargetId>,
  merged: Map<string, LockMerged>,
) {
  for (const id of failed) {
    const hash = previous.render[id];
    if (hash) entry.render[id] = hash;
  }
  const files = new Set(entry.files);
  for (const f of previous.files) if (!files.has(f)) entry.files.push(f);
  for (const m of previous.merged ?? [])
    if (!merged.has(fragmentKey(m))) merged.set(fragmentKey(m), m);
}

interface Collected {
  files: Set<string>;
  merged: Map<string, LockMerged>;
  notes: Set<string>;
}

/** Render hashes, files, fragments and notes of every target that holds the entity. */
function collect(p: Prepared, failed: Set<TargetId>, entry: LockEntry): Collected {
  const out: Collected = {
    files: new Set(),
    merged: new Map(),
    notes: new Set(p.job.entity.notes ?? []),
  };
  for (const id of TARGET_IDS) {
    const r = p.out.renders[id];
    if (!r || failed.has(id)) continue;
    for (const n of r.notes) out.notes.add(n);
    if (r.skipped) {
      out.notes.add(`${id}: skipped`);
      continue;
    }
    entry.render[id] = r.hash;
    for (const f of r.files) out.files.add(f.path);
    for (const f of r.fragments) out.merged.set(fragmentKey(f), lockMerged(f));
  }
  return out;
}

/** The lock entry after this run: render hashes, files and fragments of every target that holds it. */
function entryFor(p: Prepared, failed: Set<TargetId>): LockEntry {
  const entry = baseEntry(p);
  const { files, merged, notes } = collect(p, failed, entry);
  entry.files = [...files];
  if (failed.size && p.previous) carry(entry, p.previous, failed, merged);
  entry.files.sort();
  if (merged.size) entry.merged = [...merged.values()];
  if (notes.size) entry.notes = [...notes];
  const { unit } = p.out;
  return unit && (p.consent === 'trusted' || p.consent === 'allowed')
    ? withTrust(entry, unit)
    : entry;
}

/** What the previous entry owns, as `Target.apply` takes it; under -g only what this machine holds. */
function ownedFor(run: Run, previous?: LockEntry): string[] {
  if (!previous) return [];
  const { paths, applied } = run.state;
  const held = new Set(
    (applied?.merged() ?? []).map((m) => `${paths.lockForm(m.file)}#${m.at}#${m.key}`),
  );
  const files = applied
    ? previous.files.filter((f) => applied.fileHash(paths.abs(f)))
    : previous.files;
  const merged = (previous.merged ?? []).map(fragmentKey).filter((k) => !applied || held.has(k));
  return [...files, ...merged];
}

/** The render without what the person edited (those stay as they are on disk). */
function withoutKept(rendered: Rendered, kept: string[]): Rendered {
  if (!kept.length) return rendered;
  const skip = new Set(kept);
  return {
    ...rendered,
    files: rendered.files.filter((f) => !skip.has(f.path)),
    fragments: rendered.fragments.filter((f) => !skip.has(fragmentKey(f))),
  };
}

async function writeTargets(run: Run, p: Prepared, failed: Set<TargetId>): Promise<void> {
  const { ctx, state } = run;
  const owned = ownedFor(run, p.previous);
  for (const id of p.decision.toWrite) {
    const full = p.out.renders[id];
    if (!full || failed.has(id)) continue;
    const rendered = withoutKept(full, p.decision.kept);
    try {
      await run.deps.getTarget(id).apply({
        rendered,
        scopeRoot: state.paths.root,
        owned,
        force: ctx.flags.force,
        dryRun: ctx.flags.dryRun,
        env: ctx.env,
      });
      if (!ctx.flags.dryRun) noteWritten(state, rendered);
    } catch (e) {
      failed.add(id);
      const f = failureOf(subjectOf(p), e, id);
      if (isPalmError(e) && e.code === 'E_CONFLICT')
        f.hint = installCommand(subjectOf(p), state.paths.scope, '--force');
      run.result.failures.push(f);
    }
  }
}

/** Undeploys what `previous` listed and `entry` no longer does (files by path, fragments by key). */
async function replacePrevious(
  run: Run,
  previous: LockEntry | undefined,
  entry: LockEntry,
): Promise<void> {
  if (!previous) return;
  const files = new Set(entry.files);
  const fragments = new Set((entry.merged ?? []).map(fragmentKey));
  const stale: LockEntry = {
    ...previous,
    files: previous.files.filter((f) => !files.has(f)),
    merged: (previous.merged ?? []).filter((m) => !fragments.has(fragmentKey(m))),
  };
  if (!stale.files.length && !stale.merged?.length) return;
  const { state, ctx } = run;
  const protect = protectedPaths(state.lock, [previous]);
  const sources = await sourceRoots(state);
  const job = { paths: state.paths, entries: [stale], protect, dryRun: ctx.flags.dryRun, sources };
  const report = await undeploy(ctx, run.deps, job);
  run.result.failures.push(...report.failures);
  run.result.warnings.push(...report.warnings);
}

function modifiedFailure(run: Run, p: Prepared): void {
  const kept = p.decision.kept;
  const them = kept.length === 1 ? 'it' : 'them';
  run.result.failures.push(
    failure(subjectOf(p), 'E_CONFLICT', {
      message: `${kept.join(', ')} changed since palm wrote ${them}; kept`,
      hint: installCommand(subjectOf(p), run.state.paths.scope, '--force'),
    }),
  );
}

function statusOf(p: Prepared, failed: Set<TargetId>): OutcomeStatus {
  if (!failed.size) return p.decision.status;
  const held = Object.keys(p.out.renders).filter((t) => !failed.has(t as TargetId));
  return held.length || p.previous ? 'partial' : 'failed';
}

/** Entries equal up to the order of files, fragments, notes and trust. */
function sameEntry(a: LockEntry | undefined, b: LockEntry): boolean {
  if (!a) return false;
  const norm = (e: LockEntry) => ({
    ...e,
    files: [...e.files].sort(),
    merged: (e.merged ?? []).map(fragmentKey).sort(),
    notes: [...(e.notes ?? [])].sort(),
    trust: [...(e.trust ?? [])].sort(),
  });
  return deepEqual(norm(a), norm(b));
}

const WROTE: ReadonlySet<OutcomeStatus> = new Set([
  'installed',
  'updated',
  're-rendered',
  'restored',
  'partial',
]);

async function record(
  run: Run,
  p: Prepared,
  entry: LockEntry,
  status: OutcomeStatus,
): Promise<void> {
  const { state, ctx } = run;
  await replacePrevious(run, p.previous, entry);
  if (!sameEntry(p.previous, entry)) state.lock.upsert(entry);
  const rec = p.job.record;
  if (rec && 'mcp' in rec) state.manifest.setMcp(p.job.entity.name, rec.mcp);
  else if (rec) state.manifest.addEntry(p.job.source.name, rec.kind, rec.entry);
  if (WROTE.has(status) && (await persistTargets(state)))
    ctx.log.info(`targets: ${state.targets.join(', ')} (detected; change targets: in palm.yaml)`);
}

function perTarget(p: Prepared, failed: Set<TargetId>): Partial<Record<TargetId, OutcomeStatus>> {
  const out: Partial<Record<TargetId, OutcomeStatus>> = {};
  for (const id of Object.keys(p.out.renders) as TargetId[])
    out[id] = failed.has(id) ? 'failed' : p.decision.status;
  for (const f of p.out.refusals) if (f.target) out[f.target] = 'failed';
  return out;
}

/** Writes one prepared entity whose consent (if any) is settled; returns its outcome. */
export async function applyPrepared(run: Run, p: Prepared): Promise<InstallOutcome> {
  run.result.warnings.push(...p.out.warnings);
  if (p.out.refusals.some((f) => !f.target)) return refused(run, p);
  if (p.consent === 'quiet' && p.previous)
    return { entry: p.previous, status: 'unchanged', notes: [] };
  const unsettled = p.consent === 'ask' && !run.ctx.flags.dryRun;
  if (p.consent === 'declined' || unsettled) return declined(run, p);
  run.result.failures.push(...p.out.refusals);
  const failed = new Set(p.out.refusals.flatMap((f) => (f.target ? [f.target] : [])));
  const literals = await literalsBefore(run, p);
  await writeTargets(run, p, failed);
  await rotationWarnings(run, p, literals);
  const status = statusOf(p, failed);
  const entry = entryFor(p, failed);
  if (status === 'failed') return { entry: p.previous ?? entry, status, notes: entry.notes ?? [] };
  if (status === 'modified') modifiedFailure(run, p);
  await record(run, p, entry, status);
  const outcome: InstallOutcome = { entry, status, notes: entry.notes ?? [] };
  if (status === 'partial') outcome.perTarget = perTarget(p, failed);
  return outcome;
}

function refused(run: Run, p: Prepared): InstallOutcome {
  run.result.failures.push(...p.out.refusals);
  return { entry: p.previous ?? entryFor(p, new Set()), status: 'failed', notes: [] };
}

/** A unit the person declined: nothing of it is written; a plugin's hook is recorded as declined. */
function declined(run: Run, p: Prepared): InstallOutcome {
  const s = subjectOf(p);
  const scope = run.state.paths.scope;
  const notes = [
    'runs a program on your machine; not installed',
    `see it: ${installCommand(s, scope, '--dry-run --review')}`,
    `install it: ${installCommand({ ...s, name: `${s.kind}:${s.name}` }, scope)}`,
  ];
  if (p.previous && !p.previous.declined) return { entry: p.previous, status: 'skipped', notes };
  const entry = withDeclined({ ...baseEntry(p), render: {}, files: [] });
  if (p.job.via) run.state.lock.upsert(entry);
  return { entry, status: 'skipped', notes };
}
