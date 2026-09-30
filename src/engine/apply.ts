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
import { isWithin } from '../lib/fs.js';
import { deepEqual } from '../lib/object.js';
import { fragmentKey, type TargetVerdict } from './diff.js';
import { uncheckedNote } from './edits.js';
import { mergeEnvNotes } from './env-notes.js';
import type { Prepared, Run } from './jobs.js';
import { keptProgram } from './moves.js';
import { removeOrphans } from './orphans.js';
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

/** The lock's record of a fragment; `created` while palm created its shared file (J14). */
function lockMerged(f: LockMerged, created: boolean): LockMerged {
  const m: LockMerged = { file: f.file, at: f.at, id: f.id, key: f.key };
  if (created) m.created = true;
  return m;
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

/**
 * Render hashes, files, fragments and notes of every target that holds the entity. A fragment
 * whose shared file this apply created (`created`, from `ApplyResult.merged`) or the previous
 * entry's apply created keeps `created` in the lock.
 */
function collect(
  p: Prepared,
  failed: Set<TargetId>,
  entry: LockEntry,
  created: ReadonlySet<string>,
): Collected {
  const out: Collected = {
    files: new Set(),
    merged: new Map(),
    notes: new Set(p.job.entity.notes ?? []),
  };
  const before = new Set((p.previous?.merged ?? []).filter((m) => m.created).map(fragmentKey));
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
    for (const f of r.fragments) {
      const key = fragmentKey(f);
      out.merged.set(key, lockMerged(f, created.has(key) || before.has(key)));
    }
  }
  return out;
}

/** The lock entry after this run: render hashes, files and fragments of every target that holds it. */
function entryFor(
  p: Prepared,
  failed: Set<TargetId>,
  created: ReadonlySet<string> = new Set(),
): LockEntry {
  const entry = baseEntry(p);
  const { files, merged, notes } = collect(p, failed, entry, created);
  entry.files = [...files];
  if (failed.size && p.previous) carry(entry, p.previous, failed, merged);
  entry.files.sort();
  if (merged.size) entry.merged = [...merged.values()];
  if (notes.size) entry.notes = mergeEnvNotes(notes);
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

/**
 * The first path of `rendered` whose real path lies inside a declared local source (a source
 * at the scope root excepted: it is scanned with the output directories left out). palm never
 * writes inside a source, `--force` included (DESIGN §2).
 */
async function insideSource(run: Run, rendered: Rendered): Promise<string | undefined> {
  const { paths } = run.state;
  const root = (await paths.realInside(paths.root)).real;
  const roots = (await sourceRoots(run.state)).filter((r) => r !== root);
  if (!roots.length) return undefined;
  const written = [...rendered.files.map((f) => f.path), ...rendered.fragments.map((f) => f.file)];
  for (const lockPath of written) {
    const { real } = await paths.realInside(paths.abs(lockPath));
    if (roots.some((r) => isWithin(real, r))) return lockPath;
  }
  return undefined;
}

function insideSourceFailure(run: Run, p: Prepared, id: TargetId, lockPath: string) {
  const message = `${lockPath} is inside a declared source; palm never writes into a source`;
  const hint =
    'move the source to a directory of its own (for example ./agent-kit) and declare that';
  run.result.failures.push(failure(subjectOf(p), 'E_SOURCE', { message, hint }, id));
}

/** One target's write; the keys of the fragments whose shared file it created, or undefined when it failed. */
async function writeTarget(
  run: Run,
  p: Prepared,
  id: TargetId,
  rendered: Rendered,
): Promise<string[] | undefined> {
  const { ctx, state } = run;
  try {
    const applied = await run.deps.getTarget(id).apply({
      rendered,
      scopeRoot: state.paths.root,
      owned: ownedFor(run, p.previous),
      force: ctx.flags.force,
      dryRun: ctx.flags.dryRun,
      env: ctx.env,
    });
    if (!ctx.flags.dryRun) {
      noteWritten(state, rendered);
      run.touched = true;
    }
    return (applied.merged ?? []).filter((m) => m.created).map(fragmentKey);
  } catch (e) {
    const f = failureOf(subjectOf(p), e, id);
    if (isPalmError(e) && e.code === 'E_CONFLICT')
      f.hint = installCommand(subjectOf(p), state.paths.scope, '--force');
    run.result.failures.push(f);
    return undefined;
  }
}

/** Writes each target that needs it; returns the keys of the fragments whose shared file it created. */
async function writeTargets(run: Run, p: Prepared, failed: Set<TargetId>): Promise<Set<string>> {
  const created = new Set<string>();
  for (const id of p.decision.toWrite) {
    const full = p.out.renders[id];
    if (!full || failed.has(id)) continue;
    const rendered = withoutKept(full, p.decision.kept);
    const hit = await insideSource(run, rendered);
    if (hit) insideSourceFailure(run, p, id, hit);
    const keys = hit ? undefined : await writeTarget(run, p, id, rendered);
    if (!keys) failed.add(id);
    for (const k of keys ?? []) created.add(k);
  }
  return created;
}

/**
 * Undeploys what `previous` listed and `entry` no longer does (files by path, fragments by key),
 * except what the person edited (`kept`): that stays on disk, no longer palm's.
 */
async function replacePrevious(
  run: Run,
  previous: LockEntry | undefined,
  entry: LockEntry,
  kept: readonly string[],
): Promise<void> {
  if (!previous) return;
  const stays = new Set([...entry.files, ...kept]);
  const fragments = new Set([...(entry.merged ?? []).map(fragmentKey), ...kept]);
  const stale: LockEntry = {
    ...previous,
    files: previous.files.filter((f) => !stays.has(f)),
    merged: (previous.merged ?? []).filter((m) => !fragments.has(fragmentKey(m))),
  };
  if (!stale.files.length && !stale.merged?.length) return;
  const { state, ctx } = run;
  const protect = protectedPaths(state.lock, [previous]);
  const sources = await sourceRoots(state);
  const job = { paths: state.paths, entries: [stale], protect, dryRun: ctx.flags.dryRun, sources };
  const report = await undeploy(ctx, run.deps, job);
  if (!ctx.flags.dryRun) run.touched = true;
  run.result.failures.push(...report.failures);
  run.result.warnings.push(...report.warnings);
}

/** ` (codex moved on)` when other targets were written while these paths were kept (R8). */
function movedOn(p: Prepared): string {
  const moved = (Object.entries(p.decision.targets) as Array<[TargetId, TargetVerdict]>)
    .filter(([, v]) => v === 'render' || v === 'restore')
    .map(([t]) => t);
  return moved.length && p.decision.status === 'partial' ? `; ${moved.join(', ')} moved on` : '';
}

function modifiedFailure(run: Run, p: Prepared): void {
  const kept = p.decision.kept;
  const them = kept.length === 1 ? 'it' : 'them';
  const text = p.unchecked
    ? {
        message: `${kept.join(', ')} may have changed since palm wrote ${them}; kept (${p.unchecked.reason})${movedOn(p)}`,
        hint: p.unchecked.command,
      }
    : {
        message: `${kept.join(', ')} changed since palm wrote ${them}; kept${movedOn(p)}`,
        hint: installCommand(subjectOf(p), run.state.paths.scope, '--force'),
      };
  run.result.failures.push(failure(subjectOf(p), 'E_CONFLICT', text));
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
  const { state } = run;
  await replacePrevious(run, p.previous, entry, p.decision.kept);
  if (!sameEntry(p.previous, entry)) state.lock.upsert(entry);
  const rec = p.job.record;
  if (rec && 'mcp' in rec) state.manifest.setMcp(p.job.entity.name, rec.mcp);
  else if (rec) state.manifest.addEntry(p.job.source.name, rec.kind, rec.entry);
  if (WROTE.has(status)) await persistTargets(state);
}

/** A target's verdict as the status it shows in a `partial` breakdown. */
function targetStatus(p: Prepared, verdict: TargetVerdict | undefined): OutcomeStatus {
  if (verdict === 'kept') return 'modified';
  if (verdict === 'restore') return 'restored';
  if (verdict === 'unchanged') return 'unchanged';
  if (verdict === 'skipped') return 'skipped';
  if (!p.previous) return 'installed';
  return p.previous.content !== p.out.content && !p.job.source.isLocal ? 'updated' : 're-rendered';
}

function perTarget(p: Prepared, failed: Set<TargetId>): Partial<Record<TargetId, OutcomeStatus>> {
  const out: Partial<Record<TargetId, OutcomeStatus>> = {};
  for (const id of Object.keys(p.out.renders) as TargetId[])
    out[id] = failed.has(id) ? 'failed' : targetStatus(p, p.decision.targets[id]);
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
  const created = await writeTargets(run, p, failed);
  await rotationWarnings(run, p, literals);
  return settled(run, p, failed, created);
}

/** `install --force` deletes the files the entry's own folders hold and the lock does not list (C13). */
async function strayFiles(run: Run, entry: LockEntry): Promise<string | undefined> {
  if (!run.ctx.flags.force) return undefined;
  const note = await removeOrphans(run.state, entry, run.ctx.flags.dryRun);
  if (note && !run.ctx.flags.dryRun) run.touched = true;
  return note;
}

/** After the writes: the outcome, the failure for kept edits, and the lock and palm.yaml entries. */
async function settled(
  run: Run,
  p: Prepared,
  failed: Set<TargetId>,
  created: ReadonlySet<string>,
): Promise<InstallOutcome> {
  const status = statusOf(p, failed);
  const entry = entryFor(p, failed, created);
  if (status === 'failed') return { entry: p.previous ?? entry, status, notes: entry.notes ?? [] };
  const kept = p.decision.kept.length > 0;
  if (kept && (status === 'modified' || status === 'partial')) modifiedFailure(run, p);
  await record(run, p, entry, status);
  if (status !== 'unchanged') run.result.warnings.push(...(p.job.notices ?? []));
  const notes = [...(entry.notes ?? [])];
  if (kept && p.unchecked) notes.push(uncheckedNote(p.unchecked));
  const stray = await strayFiles(run, entry);
  if (stray) notes.push(stray);
  const outcome: InstallOutcome = { entry, status, notes };
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
  // The trusted version is still merged and runs (V5): say so, and how to remove it.
  if (p.previous && !p.previous.declined) return keptProgram(run, p);
  const entry = withDeclined({ ...baseEntry(p), render: {}, files: [] });
  if (p.job.via) run.state.lock.upsert(entry);
  return { entry, status: 'skipped', notes };
}
