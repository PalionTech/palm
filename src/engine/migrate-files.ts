/**
 * What `palm migrate` deletes, writes and notes, for the report (X8 B7 J5' Y4', N15 M11): every
 * file 0.1 wrote that the install replaced, every copy 0.1 made where 0.2 writes nothing, every
 * `.palm/hooks` script that moved, and the notes palm keeps on the migrated entries. A dry run
 * reports what the install would do from the prepared jobs; nothing is read beyond the disk.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sameContent } from '../core/hash.js';
import type { LockEntry, MigrateRemoval, TargetId } from '../core/types.js';
import { TARGET_IDS } from '../core/types.js';
import type { Lock } from '../domain/lock.js';
import { fileStates, fragmentStates, ownedFragments } from './diff.js';
import { mergeEnvNotes } from './env-notes.js';
import type { Prepared } from './jobs.js';
import type { LegacyItem } from './migrate-legacy.js';
import type { Plan } from './migrate-plan.js';
import { display } from './migrate-report.js';
import { orphansOf } from './orphans.js';
import type { ScopeState } from './scope.js';

// ---------------------------------------------------------------------------
// Why a file goes
// ---------------------------------------------------------------------------

/** A copy 0.1 made into a folder 0.2 owns but does not write there. */
export function copyReason(file: string): string {
  if (file.endsWith('/agents/openai.yaml'))
    return 'palm 0.1 copied it; palm 0.2 writes agents/openai.yaml only into .agents/skills';
  return 'palm 0.1 copied it; palm 0.2 does not write it there';
}

/** A file 0.1 rendered for an entry that 0.2 renders without it. */
function replacedReason(e: LockEntry, legacy: readonly LegacyItem[]): string {
  const item = legacy.find(
    (i) => i.kind === e.kind && i.source === e.source && i.entry.name === e.name,
  );
  if (item?.entry.kind === 'command')
    return `palm 0.1 wrote it for command ${e.name}; palm 0.2 installs ${e.name} as a skill`;
  return `palm 0.1 wrote it for ${e.kind} ${e.name}; palm 0.2 does not write it`;
}

/** A migrated hook: its name, source and the lock-form root its scripts are copied to. */
export interface MovedHook {
  name: string;
  source: string;
  root?: string;
}

/** A script of 0.1's `.palm/hooks/<name>` copy: where the hook runs it from now. */
export function hookCopyReason(state: ScopeState, h: MovedHook): string {
  const inPlace = state.sources.byName(h.source)?.isLocal;
  const where =
    h.root && !inPlace
      ? `the hook now runs it from ${display(state.paths, state.paths.abs(h.root))}`
      : `the hook now runs in place from ${h.source}`;
  return `palm 0.1's copy for hook ${h.name}; ${where}`;
}

function byFile(a: MigrateRemoval, b: MigrateRemoval): number {
  return a.file < b.file ? -1 : Number(a.file > b.file);
}

/** One line per file, in path order (the first reason wins). */
export function sortedRemovals(list: readonly MigrateRemoval[]): MigrateRemoval[] {
  const seen = new Map<string, MigrateRemoval>();
  for (const r of list) if (!seen.has(r.file)) seen.set(r.file, r);
  return [...seen.values()].sort(byFile);
}

// ---------------------------------------------------------------------------
// After the install: what 0.1 wrote that is gone
// ---------------------------------------------------------------------------

/** Every lock path (files and the files fragments sit in) the provisional entries hold. */
export function heldBefore(lock: Lock): Map<string, LockEntry> {
  const out = new Map<string, LockEntry>();
  for (const e of lock.entries)
    for (const f of [...e.files, ...(e.merged ?? []).map((m) => m.file)])
      if (!out.has(f)) out.set(f, e);
  return out;
}

/** The files 0.1 wrote that the install removed: listed before, neither in the lock nor on disk now. */
export function replacedFiles(
  state: ScopeState,
  before: ReadonlyMap<string, LockEntry>,
  legacy: readonly LegacyItem[],
): MigrateRemoval[] {
  const after = heldBefore(state.lock);
  const out: MigrateRemoval[] = [];
  for (const [file, e] of before)
    if (!after.has(file) && !existsSync(state.paths.abs(file)))
      out.push({
        file: display(state.paths, state.paths.abs(file)),
        reason: replacedReason(e, legacy),
      });
  return out;
}

/** The notes the lock keeps on its entries, `<kind> <name>: <note>`. */
export function lockNotes(lock: Lock): string[] {
  return lock.entries.flatMap((e) => (e.notes ?? []).map((n) => `${e.kind} ${e.name}: ${n}`));
}

// ---------------------------------------------------------------------------
// A dry run: what the install would do
// ---------------------------------------------------------------------------

/** The targets a prepared job renders, with their renders. */
function rendersOf(p: Prepared, only?: readonly TargetId[]) {
  return TARGET_IDS.flatMap((id) => {
    const r = p.out.renders[id];
    return r && !r.skipped && (!only || only.includes(id)) ? [r] : [];
  });
}

/** The files a job would write or change: rendered files not already the same, shared files whose fragment moves. */
async function wouldWrite(state: ScopeState, p: Prepared): Promise<string[]> {
  const out: string[] = [];
  for (const r of rendersOf(p, p.decision.toWrite)) {
    for (const [file, s] of await fileStates(state.paths, r)) if (s !== 'same') out.push(file);
    const frags = await fragmentStates(state.paths, r, ownedFragments(p.previous));
    for (const g of r.fragments)
      if (frags.get(`${g.file}#${g.at}#${g.key}`) !== 'held') out.push(g.file);
  }
  return out;
}

/** True when both files exist with the same content (LF line ends, O1). */
export async function sameBytes(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    readFile(a).catch(() => undefined),
    readFile(b).catch(() => undefined),
  ]);
  return x !== undefined && y !== undefined && sameContent(x, y);
}

/** The copies 0.1 made that the job's folders hold and its render does not list, still as the source has them. */
async function staleCopies(state: ScopeState, p: Prepared, rendered: Set<string>) {
  const base = p.previous ?? { kind: p.job.entity.kind, name: p.job.entity.name, files: [] };
  const entry = { ...base, files: [...rendered] } as LockEntry;
  const out: string[] = [];
  for (const { dir, file } of await orphansOf(state, entry)) {
    if (rendered.has(file)) continue;
    const source = join(p.job.checkout.root, p.job.entity.path, file.slice(dir.length + 1));
    if (await sameBytes(state.paths.abs(file), source)) out.push(file);
  }
  return out;
}

/** What one prepared job would delete: the 0.1 files its render drops, and 0.1's stray copies. */
async function wouldRemove(state: ScopeState, p: Prepared, legacy: readonly LegacyItem[]) {
  const rendered = new Set(rendersOf(p).flatMap((r) => r.files.map((f) => f.path)));
  const out: MigrateRemoval[] = [];
  const shown = (f: string) => display(state.paths, state.paths.abs(f));
  if (p.previous && p.decision.toWrite.length)
    for (const f of p.previous.files.filter((x) => !rendered.has(x)))
      out.push({ file: shown(f), reason: replacedReason(p.previous, legacy) });
  for (const f of await staleCopies(state, p, rendered))
    out.push({ file: shown(f), reason: copyReason(f) });
  return out;
}

/** The notes a prepared job would leave on its entry (as the install collects them). */
function plannedNotes(p: Prepared): string[] {
  const notes = new Set(p.job.entity.notes ?? []);
  for (const id of TARGET_IDS) {
    const r = p.out.renders[id];
    for (const n of r?.notes ?? []) notes.add(n);
    if (r?.skipped) notes.add(`${id}: skipped`);
  }
  const { kind, name } = p.job.entity;
  return mergeEnvNotes(notes).map((n) => `${kind} ${name}: ${n}`);
}

/** N15 M11 X8: a dry run's files to write, files to delete and notes. */
export async function planned(plan: Plan, legacy: readonly LegacyItem[]) {
  const { state } = plan.run;
  const written = new Set<string>();
  const removed: MigrateRemoval[] = [];
  for (const p of plan.prepared) {
    for (const f of await wouldWrite(state, p))
      written.add(display(state.paths, state.paths.abs(f)));
    removed.push(...(await wouldRemove(state, p, legacy)));
  }
  const notes = plan.prepared.flatMap(plannedNotes);
  return { written: [...written].sort(), removed, notes };
}
