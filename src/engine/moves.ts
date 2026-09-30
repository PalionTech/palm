/**
 * Sources whose commit moves in a run: a new `#ref` on install, a `ref:` edited in palm.yaml
 * (bare install, V8), `palm update`. The person sees one line per entry first, `same content`
 * where the bytes do not change (C12), and confirms (or passes `--yes`). The entries of a
 * source then move together or not at all (V4): when one is refused, or the person declines
 * the new version of a program already installed, the source stays at its locked commit and
 * nothing of it is written, so the lock never points at a commit the disk does not hold.
 */
import { PalmError } from '../core/errors.js';
import type { InstallOutcome, LockEntry, LockSource, SourceCheckout } from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import type { SourceRef } from '../domain/source.js';
import { previousStaysActive } from '../exec/trust.js';
import type { Job, Prepared, Run } from './jobs.js';
import { failure, label, palmCommand } from './report.js';
import { lockedSource, type ScopeState } from './scope.js';

export interface Move {
  /** The source's name. */
  source: string;
  /** The declared source before the run, restored when the move is held back. */
  before?: SourceRef;
  /** The lock's record before the run, restored when the move is held back. */
  locked?: LockSource;
  /** What the lock records now and what the run moves to: `^1.2 v1.2.0 (3f2a1c9)`. */
  from: string;
  to: string;
}

/** `v1.2.3 (6acc160)`, `main (5af1cb3)`, or the ref alone. */
export function versionLabel(ref: string | undefined, sha: string | undefined): string {
  if (!sha) return ref ?? '';
  const s = sha.slice(0, 7);
  return ref && ref !== sha ? `${ref} (${s})` : s;
}

/**
 * The move of a source this run fetched at `checkout`: set when the lock holds another commit
 * for it (a new `#ref`, a `ref:` edited in palm.yaml). `before` is the declared source before
 * this run changed it, restored when the move is held back.
 */
export function moveOf(
  state: ScopeState,
  ref: SourceRef,
  checkout: SourceCheckout,
  before?: SourceRef,
): Move | undefined {
  const locked = lockedSource(state, ref.name);
  if (ref.isLocal || !locked?.sha || !checkout.sha || checkout.sha === locked.sha) return undefined;
  const from = intentLabel(locked.ref, locked.resolved, locked.sha);
  const to = intentLabel(ref.source.ref, checkout.ref, checkout.sha);
  return { source: ref.name, locked, from, to, ...(before ? { before } : {}) };
}

/** `v1.2.3 (6acc160)`, or `^1.2 v1.2.3 (6acc160)` when the intent is a range. */
function intentLabel(intent: string | undefined, tag: string | undefined, sha: string): string {
  const version = versionLabel(tag ?? intent, sha);
  return intent && intent !== (tag ?? intent) ? `${intent} ${version}` : version;
}

/** One plan line per entry of a moving source (C12). */
function entryLine(p: Prepared): string {
  const what = `${p.job.entity.kind} ${p.job.entity.name}`;
  if (!p.previous) return `  + ${what} (new)`;
  if (p.previous.content === p.out.content) return `  = ${what} (same content)`;
  return `  ~ ${what} (changes)`;
}

function jobKey(j: Job): string {
  return lockId({ kind: j.entity.kind, name: j.entity.name, source: j.source.name });
}

/**
 * R7': the lock entries of a moving source that the commit it moves to no longer has (no job
 * was made for them) and that the run does not remove anyway (`leaving`). They go with the move.
 */
export function missingAtMoves(
  run: Run,
  moves: readonly Move[],
  jobs: readonly Job[],
  leaving: ReadonlySet<string> = new Set(),
): LockEntry[] {
  const made = new Set(jobs.map(jobKey));
  return moves.flatMap((m) =>
    run.state.lock
      .entriesOf(m.source)
      .filter((e) => !made.has(lockId(e)) && !leaving.has(lockId(e))),
  );
}

function printMoves(run: Run, moves: Move[], prepared: Prepared[], missing: LockEntry[]): void {
  for (const m of moves) {
    run.ctx.log.info(`source ${m.source}: ${m.from} → ${m.to}`);
    for (const p of prepared) if (p.job.source.name === m.source) run.ctx.log.info(entryLine(p));
    for (const e of missing)
      if (e.source === m.source) run.ctx.log.info(`  - ${label(e)} (not in ${m.to}; would remove)`);
  }
}

/**
 * Shows the moves with a line per entry (R7': `- would remove` for an entry the new commit no
 * longer has) and asks to apply them: `--yes` applies, a terminal asks (No keeps everything as
 * it is), no terminal is E_NON_INTERACTIVE naming `--yes`. A dry run only shows them.
 */
export async function confirmMoves(
  run: Run,
  moves: Move[],
  prepared: Prepared[],
  missing: LockEntry[] = [],
): Promise<void> {
  if (!moves.length) return;
  printMoves(run, moves, prepared, missing);
  const { ctx } = run;
  if (ctx.flags.dryRun || ctx.flags.yes) return;
  const what = moves.map((m) => `source ${m.source} to ${m.to}`).join(', ');
  if (!ctx.ui.isInteractive)
    throw new PalmError(
      'E_NON_INTERACTIVE',
      `moving ${what} needs confirmation`,
      'confirm it by running',
      {
        retryWith: '--yes',
      },
    );
  if (!(await ctx.ui.confirm(`Move ${what}?`, false)))
    throw new PalmError('E_CANCELLED', 'cancelled; nothing was written');
}

/** Why a prepared entity keeps its source from moving, if it does. */
function blocker(p: Prepared, refused: ReadonlySet<Prepared>): 'refused' | 'declined' | undefined {
  if (refused.has(p) || p.out.refusals.some((f) => !f.target)) return 'refused';
  if (p.consent === 'declined' && p.previous) return 'declined';
  return undefined;
}

function restore(run: Run, m: Move): void {
  const { state } = run;
  if (m.locked) state.lock.setSource(m.source, m.locked);
  else state.lock.removeSource(m.source);
  if (!m.before) return;
  const base = state.paths.scope === 'global' ? state.paths.palmHome : state.paths.root;
  state.manifest.addSource(m.before.source, base);
  state.sources = state.sources.add(m.before.source);
}

/** The outcome of a program whose new version the person declined: the trusted one stays (V5). */
export function keptProgram(run: Run, p: Prepared): InstallOutcome {
  const entry = p.previous as NonNullable<Prepared['previous']>;
  const line = previousStaysActive(entry, run.state.paths.scope, p.out.unit);
  const notes = line ? [line.replace(`${entry.kind} ${entry.name}: `, '')] : [];
  return { entry, status: 'skipped', notes };
}

/** What keeps a source from moving: an entity refused (or not renderable) or a program declined. */
interface Blocker {
  job: Job;
  kind: 'refused' | 'declined';
  p?: Prepared;
}

function holdOne(run: Run, m: Move, b: Blocker): void {
  restore(run, m);
  const subject = { kind: 'source' as const, name: m.source, source: m.source };
  const { entity } = b.job;
  if (b.kind === 'declined' && b.p) {
    run.result.outcomes.push(keptProgram(run, b.p));
    run.result.warnings.push(
      `source ${m.source} stays at ${m.from}: you declined the new version of ${label(entity)}`,
    );
    return;
  }
  run.result.failures.push(...(b.p?.out.refusals ?? []).filter((f) => !f.target));
  const message = `source ${m.source} stays at ${m.from}: ${label(entity)} cannot move to ${m.to}`;
  const words = [m.source, `${entity.kind}:${entity.name}`];
  const hint = palmCommand('install', words, run.state.paths.scope, '--dry-run');
  run.result.failures.push(failure(subject, 'E_SOURCE', { message, hint }));
}

/** The first entity that keeps `m` from moving: prepared ones first, then installed ones that failed to render. */
function blockerOf(run: Run, m: Move, seen: Seen): Blocker | undefined {
  const refused = new Set(seen.refused);
  for (const p of [...seen.prepared, ...seen.refused]) {
    if (p.job.source.name !== m.source) continue;
    const kind = blocker(p, refused);
    if (kind) return { job: p.job, kind, p };
  }
  const job = seen.failed.find(
    (j) => j.source.name === m.source && run.state.lock.find(j.entity, j.source.name),
  );
  return job ? { job, kind: 'refused' } : undefined;
}

/** What the steps before the writes made of a run's jobs. */
export interface Seen {
  prepared: Prepared[];
  /** Entities an earlier step refused (another owner). */
  refused: readonly Prepared[];
  /** Jobs that could not be rendered (their failure is recorded). */
  failed: readonly Job[];
}

/**
 * The prepared entities that may be applied: every entity of a moving source when none of
 * them blocks, none of them otherwise (the source's lock record and palm.yaml ref are put
 * back). Returns what stays and the names of the sources held back.
 */
export function holdBack(
  run: Run,
  moves: Move[],
  seen: Seen,
): { prepared: Prepared[]; held: Set<string> } {
  const held = new Set<string>();
  for (const m of moves) {
    const b = blockerOf(run, m, seen);
    if (!b) continue;
    held.add(m.source);
    holdOne(run, m, b);
  }
  return { prepared: seen.prepared.filter((p) => !held.has(p.job.source.name)), held };
}
