/**
 * The three-way diff (DESIGN §6 "Bare install"): the render (what palm would write now), the
 * lock (what palm wrote, as render hashes) and the disk. `fileStates` and `fragmentStates`
 * read the disk; `outcomeStatus` is pure and decides, per target, what to write and what to
 * keep. Edits are detected against the lock's render hash (PLAN.md invariant 7): a render that
 * differs from the lock is an upgrade, never "your edits".
 */
import { readFile, stat } from 'node:fs/promises';
import { sha256 } from '../core/hash.js';
import {
  type EngineDeps,
  type LockEntry,
  type OutcomeStatus,
  type Rendered,
  type RenderedFragment,
  TARGET_IDS,
  type TargetId,
} from '../core/types.js';
import type { Applied } from '../domain/applied.js';
import { parseMergedRecord, type RecordState } from '../domain/merged-record.js';
import type { ScopePaths } from '../domain/scope-paths.js';

/**
 * A rendered file on disk: `same` as the render, `missing`, `modified` (differs; palm wrote it,
 * or at project scope cannot tell), `foreign` (differs and palm has no record of writing it
 * here) or `stale` (differs, but is exactly what palm last wrote here: global scope only).
 */
export type FileState = 'same' | 'missing' | 'modified' | 'foreign' | 'stale';

const EXEC_BITS = 0o111;

async function readDisk(abs: string): Promise<{ data: Buffer; mode: number } | undefined> {
  try {
    const data = await readFile(abs);
    return { data, mode: (await stat(abs)).mode & 0o777 };
  } catch {
    return undefined;
  }
}

function sameMode(diskMode: number, mode: number | undefined): boolean {
  return mode === undefined || (diskMode & EXEC_BITS) === (mode & EXEC_BITS);
}

/** Disk against the render, per lock path; under -g the applied record tells edits from stale files. */
export async function fileStates(
  paths: ScopePaths,
  rendered: Rendered,
  opts: { applied?: Applied } = {},
): Promise<Map<string, FileState>> {
  const out = new Map<string, FileState>();
  for (const f of rendered.files) {
    const abs = paths.abs(f.path);
    const disk = await readDisk(abs);
    if (!disk) out.set(f.path, 'missing');
    else if (Buffer.from(f.data).equals(disk.data) && sameMode(disk.mode, f.mode))
      out.set(f.path, 'same');
    else out.set(f.path, differing(opts.applied?.fileHash(abs), disk.data, !!opts.applied));
  }
  return out;
}

function differing(appliedHash: string | undefined, data: Buffer, global: boolean): FileState {
  if (!global) return 'modified';
  if (appliedHash === undefined) return 'foreign';
  return sha256(data) === appliedHash ? 'stale' : 'modified';
}

/** `file#at#key`: how a fragment is keyed in states, `owned` lists and the lock (`ownedPaths`). */
export function fragmentKey(f: { file: string; at: string; key: string }): string {
  return `${f.file}#${f.at}#${f.key}`;
}

async function recordState(paths: ScopePaths, f: RenderedFragment): Promise<RecordState> {
  const { mergedRecordState } = await import('../targets/merged-state.js');
  return mergedRecordState(parseMergedRecord({ ...f, file: paths.abs(f.file) }));
}

/** Each fragment of the render on disk: `held` (found by key, same value), `changed` or `missing`. */
export async function fragmentStates(
  paths: ScopePaths,
  rendered: Rendered,
  _deps?: EngineDeps,
): Promise<Map<string, RecordState>> {
  const out = new Map<string, RecordState>();
  for (const f of rendered.fragments) out.set(fragmentKey(f), await recordState(paths, f));
  return out;
}

// ---------------------------------------------------------------------------
// outcomeStatus (pure)
// ---------------------------------------------------------------------------

export interface OutcomeInput {
  previous?: LockEntry;
  renders: Partial<Record<TargetId, Rendered>>;
  files: Map<string, FileState>;
  fragments: Map<string, RecordState>;
  force: boolean;
  /** The entity's content hash now: a different one is `updated`, the same `re-rendered`. */
  content?: string;
  /**
   * Lock paths and fragment keys known to be edited even though the render changed (found
   * against the render at the locked sha, or the applied record under -g): kept, not replaced.
   */
  edited?: Set<string>;
}

export interface OutcomeDecision {
  status: OutcomeStatus;
  toWrite: TargetId[];
  /** Lock paths (and `file#at#key` fragments) the user changed: left as they are. */
  kept: string[];
}

type TargetVerdict = 'unchanged' | 'restore' | 'render' | 'kept' | 'skipped';

/** Files the render writes that differ on disk; edited ones (owned, render unchanged) listed. */
function inspectFiles(
  input: OutcomeInput,
  rendered: Rendered,
  renderChanged: boolean,
  edited: string[],
): boolean {
  const owned = new Set(input.previous?.files ?? []);
  let write = false;
  for (const f of rendered.files) {
    const s = input.files.get(f.path) ?? 'missing';
    if (s === 'same') continue;
    write = true;
    const edit = !renderChanged || input.edited?.has(f.path);
    if (s === 'modified' && owned.has(f.path) && edit) edited.push(f.path);
  }
  return write;
}

/** Fragments that are not held; changed ones the lock owns (render unchanged) listed as edited. */
function inspectFragments(
  input: OutcomeInput,
  rendered: Rendered,
  renderChanged: boolean,
  edited: string[],
): boolean {
  const owned = new Set((input.previous?.merged ?? []).map(fragmentKey));
  let write = false;
  for (const f of rendered.fragments) {
    const key = fragmentKey(f);
    const s = input.fragments.get(key) ?? 'missing';
    if (s === 'held') continue;
    write = true;
    const edit = !renderChanged || input.edited?.has(key);
    if (s === 'changed' && owned.has(key) && edit) edited.push(key);
  }
  return write;
}

/** What the disk says for one target's render. */
function inspect(input: OutcomeInput, rendered: Rendered, renderChanged: boolean) {
  const edited: string[] = [];
  const files = inspectFiles(input, rendered, renderChanged, edited);
  const fragments = inspectFragments(input, rendered, renderChanged, edited);
  return { edited, write: files || fragments };
}

function verdictFor(
  input: OutcomeInput,
  id: TargetId,
  rendered: Rendered,
  kept: string[],
): TargetVerdict {
  if (rendered.skipped) return 'skipped';
  const previousHash = input.previous?.render[id];
  const renderChanged = previousHash !== rendered.hash;
  const { edited, write } = inspect(input, rendered, renderChanged);
  if (edited.length && !input.force) {
    kept.push(...edited);
    return 'kept';
  }
  if (renderChanged) return 'render';
  return write ? 'restore' : 'unchanged';
}

function overall(input: OutcomeInput, verdicts: TargetVerdict[], dropped: boolean): OutcomeStatus {
  if (verdicts.includes('kept')) return 'modified';
  const rendering = verdicts.includes('render') || dropped;
  if (!input.previous) return verdicts.every((v) => v === 'skipped') ? 'skipped' : 'installed';
  if (rendering && input.content && input.content !== input.previous.content) return 'updated';
  if (rendering) return 're-rendered';
  return verdicts.includes('restore') ? 'restored' : 'unchanged';
}

/**
 * The outcome of one entity (DESIGN §6): per target, a render equal to the lock's with the disk
 * equal to the render is unchanged; missing files or fragments are restored; a file or fragment
 * the user changed is kept (`modified`, unless `force`); a render that differs from the lock is
 * applied (`updated` with new content, else `re-rendered`). Targets the lock has and the render
 * lacks count as a change.
 */
export function outcomeStatus(input: OutcomeInput): OutcomeDecision {
  const kept: string[] = [];
  const toWrite: TargetId[] = [];
  const verdicts: TargetVerdict[] = [];
  for (const id of TARGET_IDS) {
    const rendered = input.renders[id];
    if (!rendered) continue;
    const v = verdictFor(input, id, rendered, kept);
    verdicts.push(v);
    if (v === 'render' || v === 'restore') toWrite.push(id);
  }
  const rendered = new Set(Object.keys(input.renders));
  const dropped = Object.keys(input.previous?.render ?? {}).some((t) => !rendered.has(t));
  return { status: overall(input, verdicts, dropped), toWrite, kept };
}
