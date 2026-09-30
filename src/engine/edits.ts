/**
 * What the person changed since palm wrote an entry, when the render moved away from the lock
 * (PLAN.md invariant 7; DESIGN §6 "Install with names" step 8 and "Bare install"). At risk is
 * only what palm owns and the new render would overwrite or drop: an owned file that differs
 * from the render, an owned fragment whose key holds another value, an owned file the render
 * no longer writes. Three checks decide, in order:
 *
 * 1. Offline, against the lock's render hash: per target the lock records, the entry's files
 *    on disk (lock path, mode, sha256 of the content) and its fragments (each value read by key
 *    from its shared file) are hashed as a render is (`renderHash`). Equal to
 *    `render.<target>`: the disk is exactly what palm wrote there, nothing on it is an edit.
 * 2. The render at the locked sha (from the cache, fetched when missing), compared per file.
 * 3. Neither decides (the locked commit is unavailable, an in-repo source moved on): every path
 *    still at risk is kept, with the reason and the command that overwrites. Never a write.
 *
 * Under -g with an applied record, the record's per-file hashes decide, offline as well.
 */
import { stat } from 'node:fs/promises';
import type {
  LockEntry,
  LockMerged,
  RenderedFile,
  RenderedFragment,
  TargetId,
} from '../core/types.js';
import { parseMergedRecord, type RecordState } from '../domain/merged-record.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import type { HashForm } from '../targets/render-hash.js';
import { type FileState, fragmentKey, readDisk } from './diff.js';
import type { Run } from './jobs.js';
import type { RenderOutput } from './render.js';
import { palmCommand } from './report.js';
import { lockedSource } from './scope.js';
import { MANIFEST_SOURCE } from './sources.js';
import { editedPaths } from './verify.js';

const EXEC_BITS = 0o111;

export interface EditInput {
  previous: LockEntry | undefined;
  out: RenderOutput;
  /** Disk against the new render, per lock path (`fileStates`). */
  files: Map<string, FileState>;
  /** Disk against the new render, per fragment key (`fragmentStates`). */
  fragments: Map<string, RecordState>;
  /** The secret values the new render writes literally (`--secrets literal`). */
  values?: Record<string, string> | undefined;
}

/** Why palm kept paths it could not check, and the command that overwrites them. */
export interface Unchecked {
  reason: string;
  command: string;
}

export interface EditCheck {
  /** Lock paths and `file#at#key` fragments to leave as they are on disk. */
  edited: Set<string>;
  /** Set when palm kept paths it could not check (check 3). */
  unchecked?: Unchecked;
}

/** The note an outcome carries for paths palm could not check. */
export function uncheckedNote(u: Unchecked): string {
  return `${u.reason}; ${u.command} overwrites`;
}

/** What the new render writes, over every target that writes something. */
interface Written {
  files: Map<string, RenderedFile>;
  fragments: Map<string, RenderedFragment>;
}

function writtenBy(out: RenderOutput): Written {
  const w: Written = { files: new Map(), fragments: new Map() };
  for (const r of Object.values(out.renders)) {
    if (!r || r.skipped) continue;
    for (const f of r.files) if (!w.files.has(f.path)) w.files.set(f.path, f);
    for (const g of r.fragments) w.fragments.set(fragmentKey(g), g);
  }
  return w;
}

/** A target whose render hash moved, or one the lock has that renders nothing now. */
function moved(previous: LockEntry, out: RenderOutput): boolean {
  for (const [t, r] of Object.entries(out.renders))
    if (r && !r.skipped && previous.render[t as TargetId] !== r.hash) return true;
  return Object.keys(previous.render).some((t) => {
    const r = out.renders[t as TargetId];
    return !r || !!r.skipped;
  });
}

function absOf(paths: ScopePaths, lockPath: string): string | undefined {
  try {
    return paths.safeAbs(lockPath);
  } catch {
    return undefined;
  }
}

async function onDisk(paths: ScopePaths, lockPath: string): Promise<boolean> {
  const abs = absOf(paths, lockPath);
  return !!abs && !!(await stat(abs).catch(() => undefined));
}

/** Owned paths the new render would overwrite (they differ from it) or drop (still on disk). */
async function atRisk(
  paths: ScopePaths,
  input: EditInput,
  previous: LockEntry,
  w: Written,
): Promise<string[]> {
  const risk: string[] = [];
  for (const f of previous.files) {
    if (!w.files.has(f)) {
      if (await onDisk(paths, f)) risk.push(f);
      continue;
    }
    const s = input.files.get(f);
    if (s !== 'same' && s !== 'missing') risk.push(f);
  }
  for (const m of previous.merged ?? [])
    if (input.fragments.get(fragmentKey(m)) === 'changed') risk.push(fragmentKey(m));
  return risk;
}

/** The disk, hashed as a render: what the checks read. */
interface DiskView {
  paths: ScopePaths;
  out: RenderOutput;
  written: Written;
  form: HashForm;
}

/** Levels two lock paths share (`.claude/skills/x/a.md`, `.claude/skills/x/b.md`: 3). */
function sharedDepth(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

/** The mode the render gives `path`, or its nearest neighbour's for a file it no longer writes. */
function modeSpec(w: Written, path: string): number | undefined {
  const same = w.files.get(path);
  if (same) return same.mode;
  let best: RenderedFile | undefined;
  let depth = -1;
  for (const f of w.files.values()) {
    const d = sharedDepth(f.path, path);
    if (d > depth) [best, depth] = [f, d];
  }
  return best?.mode;
}

/** The rendered mode when the disk agrees on the executable bit, else the git mode of the disk. */
function modeLike(spec: number, disk: number): number {
  if ((spec & EXEC_BITS) === (disk & EXEC_BITS)) return spec;
  return disk & EXEC_BITS ? 0o755 : 0o644;
}

async function diskFile(v: DiskView, path: string): Promise<RenderedFile | undefined> {
  const abs = absOf(v.paths, path);
  const disk = abs ? await readDisk(abs) : undefined;
  if (!disk) return undefined;
  const spec = modeSpec(v.written, path);
  return {
    path,
    data: disk.data,
    ...(spec === undefined ? {} : { mode: modeLike(spec, disk.mode) }),
  };
}

/** The fragment as its shared file holds it, found by key (a block ends as the render ends it). */
async function diskFragment(v: DiskView, m: LockMerged): Promise<RenderedFragment | undefined> {
  const abs = absOf(v.paths, m.file);
  if (!abs) return undefined;
  const like = v.written.fragments.get(fragmentKey(m))?.value;
  try {
    const { mergedRecordValue } = await import('../targets/merged-state.js');
    const value = await mergedRecordValue(parseMergedRecord({ ...m, file: abs, value: like }));
    return value === undefined
      ? undefined
      : { file: m.file, at: m.at, id: m.id, key: m.key, value };
  } catch {
    return undefined;
  }
}

interface Candidate {
  files: string[];
  merged: LockMerged[];
}

/** The render hashes `c` has on disk now (with and without literal secrets); none when a part is gone. */
async function hashesOf(v: DiskView, c: Candidate): Promise<string[]> {
  const files: RenderedFile[] = [];
  const fragments: RenderedFragment[] = [];
  for (const p of c.files) {
    const f = await diskFile(v, p);
    if (!f) return [];
    files.push(f);
  }
  for (const m of c.merged) {
    const g = await diskFragment(v, m);
    if (!g) return [];
    fragments.push(g);
  }
  const { renderHash } = await import('../targets/render-hash.js');
  return [
    renderHash(files, fragments, { ...v.form, secretPolicy: 'env-ref', secretValues: undefined }),
    renderHash(files, fragments, { ...v.form, secretPolicy: 'literal' }),
  ];
}

/**
 * What target `t` wrote, as far as the lock tells: everything when it is the lock's only target,
 * else the lock paths its new render still writes, and those plus the paths no render writes now.
 */
function candidates(previous: LockEntry, v: DiskView, t: TargetId): Candidate[] {
  const all: Candidate = { files: previous.files, merged: previous.merged ?? [] };
  if (Object.keys(previous.render).length <= 1) return [all];
  const r = v.out.renders[t];
  const files = new Set(r && !r.skipped ? r.files.map((f) => f.path) : []);
  const keys = new Set(r && !r.skipped ? r.fragments.map(fragmentKey) : []);
  const own: Candidate = {
    files: all.files.filter((f) => files.has(f)),
    merged: all.merged.filter((m) => keys.has(fragmentKey(m))),
  };
  const gone: Candidate = {
    files: all.files.filter((f) => !v.written.files.has(f)),
    merged: all.merged.filter((m) => !v.written.fragments.has(fragmentKey(m))),
  };
  if (!gone.files.length && !gone.merged.length) return [own];
  return [own, { files: [...own.files, ...gone.files], merged: [...own.merged, ...gone.merged] }];
}

/** Check 1: the lock paths of every target whose disk hashes to the lock's render hash. */
async function unedited(v: DiskView, previous: LockEntry): Promise<Set<string>> {
  const out = new Set<string>();
  for (const [t, hash] of Object.entries(previous.render)) {
    for (const c of candidates(previous, v, t as TargetId)) {
      if (!(await hashesOf(v, c)).includes(hash)) continue;
      for (const f of c.files) out.add(f);
      for (const m of c.merged) out.add(fragmentKey(m));
      break;
    }
  }
  return out;
}

/** The paths at risk that check 1 cannot clear. */
async function unclear(run: Run, input: EditInput, previous: LockEntry): Promise<string[]> {
  const { paths } = run.state;
  const written = writtenBy(input.out);
  const risk = await atRisk(paths, input, previous, written);
  if (!risk.length) return [];
  const form: HashForm = { scope: paths.scope, paths, secretValues: input.values };
  const clear = await unedited({ paths, out: input.out, written, form }, previous);
  return risk.filter((p) => !clear.has(p));
}

/** Check 3: why palm cannot tell, and the command that overwrites. */
function uncheckedOf(run: Run, e: LockEntry): Unchecked {
  const scope = run.state.paths.scope;
  if (e.source === MANIFEST_SOURCE)
    return {
      reason: 'palm cannot rebuild what it wrote from palm.yaml',
      command: palmCommand('install', [], scope, '--force'),
    };
  const command = palmCommand('install', [e.source, `${e.kind}:${e.name}`], scope, '--force');
  const sha = lockedSource(run.state, e.source)?.sha;
  if (sha) return { reason: `locked commit ${sha.slice(0, 7)} unavailable`, command };
  return { reason: `palm cannot rebuild what it wrote from ${e.source}`, command };
}

/**
 * When the render moved away from the lock (a new sha, a changed ref, a changed in-repo source,
 * a target dropped), the paths the person edited, by the three checks above; undefined when the
 * render did not move (every difference from it is then an edit) or under `--force`.
 */
export async function knownEdits(run: Run, input: EditInput): Promise<EditCheck | undefined> {
  const { previous } = input;
  if (!previous || run.ctx.flags.force || !moved(previous, input.out)) return undefined;
  if (!previous.files.length && !previous.merged?.length) return { edited: new Set() };
  const exact = () => editedPaths(run, previous).catch(() => undefined);
  if (run.state.paths.scope === 'global' && run.state.applied)
    return { edited: new Set((await exact()) ?? []) };
  const open = await unclear(run, input, previous);
  if (!open.length) return { edited: new Set() };
  const edited = await exact();
  if (edited) return { edited: new Set(edited) };
  return { edited: new Set(open), unchecked: uncheckedOf(run, previous) };
}
