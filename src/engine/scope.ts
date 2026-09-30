/**
 * One scope as the engine sees it (DESIGN §2, §3, §4): the paths, palm.yaml, the lock, the
 * declared sources, the target set and, under -g, the machine record `applied.yaml`.
 * `openScope` applies the scope guards and the overlap rule; `saveScope` writes only what
 * changed since it was opened or last saved.
 */
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PalmError } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { isHomeAsProject } from '../core/paths.js';
import type {
  EngineDeps,
  LockSource,
  PalmContext,
  Rendered,
  Scope,
  TargetId,
} from '../core/types.js';
import { Applied } from '../domain/applied.js';
import { Lock } from '../domain/lock.js';
import { Manifest } from '../domain/manifest.js';
import { ScopePaths } from '../domain/scope-paths.js';
import type { SourceSet } from '../domain/source.js';
import { isWithin } from '../lib/fs.js';
import { ensureIgnoreLines } from './gitignore.js';
import { detectTargets } from './targets.js';

export interface ScopeState {
  paths: ScopePaths;
  manifest: Manifest;
  lock: Lock;
  sources: SourceSet;
  targets: TargetId[];
  applied?: Applied;
}

/** What `saveScope` compares against, and the hashes of files written this run (applied.yaml). */
interface Snapshot {
  ctx: PalmContext;
  manifest: string;
  lock: string;
  written: Map<string, string>;
  /** The lock's sources as opened: what "the locked sha" means for the whole run. */
  sources: Record<string, LockSource>;
}

const snapshots = new WeakMap<ScopeState, Snapshot>();

function snapshotOf(state: ScopeState): Snapshot {
  const snap = snapshots.get(state);
  if (!snap) throw new PalmError('E_INTERNAL', 'scope state was not opened with openScope');
  return snap;
}

const text = (v: { toJSON(): unknown }): string => JSON.stringify(v.toJSON());

function assertScope(ctx: PalmContext, scope: Scope): void {
  if (scope !== 'project' || !isHomeAsProject(ctx.paths, ctx.env)) return;
  throw new PalmError(
    'E_USAGE',
    'run inside a project or use -g: the home directory is not a project',
    'cd into a project and run palm again, or add -g to install for yourself',
  );
}

/** Where palm.yaml sits, for E_PARSE messages. */
function manifestLabel(scope: Scope): string {
  return scope === 'global' ? '~/.palm/palm.yaml' : 'palm.yaml';
}

/**
 * Opens a scope (DESIGN §6 step 1): the home-as-project guard, palm.yaml and the lock (old
 * formats are E_USAGE naming `palm migrate`), the target set (palm.yaml, else detection when
 * `deps` is given; never saved here) and, unless `readOnly`, the overlap rule (E_SOURCE).
 */
export async function openScope(
  ctx: PalmContext,
  scope: Scope,
  opts: { readOnly?: boolean; deps?: EngineDeps } = {},
): Promise<ScopeState> {
  assertScope(ctx, scope);
  const paths = ScopePaths.of(ctx, scope);
  const manifest = await Manifest.load(paths.manifestFile);
  const lock = await Lock.load(paths.lockFile);
  const sources = manifest.sources(dirname(paths.manifestFile), manifestLabel(scope));
  const detected = opts.deps && !manifest.targets ? await detectTargets(ctx, paths, opts.deps) : [];
  const state: ScopeState = {
    paths,
    manifest,
    lock,
    sources,
    targets: manifest.targets ?? detected,
  };
  if (scope === 'global' && paths.appliedFile)
    state.applied = await Applied.load(paths.appliedFile);
  snapshots.set(state, {
    ctx,
    manifest: text(manifest),
    lock: text(lock),
    written: new Map(),
    sources: lock.sources,
  });
  if (opts.deps && !opts.readOnly) await assertNoOverlap(ctx, state, opts.deps);
  return state;
}

/** A local source whose real path overlaps an output directory of an active target. */
export interface Overlap {
  source: string;
  sourceRel: string;
  target: TargetId | 'palm';
  dir: string;
}

function overlapError(o: Overlap): PalmError {
  const what = o.target === 'palm' ? 'palm asset directory' : `${o.target} output directory`;
  return new PalmError(
    'E_SOURCE',
    `source "${o.source}" (${o.sourceRel}) overlaps the ${what} ${o.dir}/`,
    'move the source files to a directory of their own (for example ./agent-kit) and declare that in palm.yaml',
  );
}

/** Lock-form output directories of the active targets, plus the asset directory. */
function outputDirs(ctx: PalmContext, state: ScopeState, deps: EngineDeps) {
  const { paths } = state;
  const dirs: Array<{ target: TargetId | 'palm'; dir: string }> = [
    { target: 'palm', dir: paths.lockForm(paths.assetsDir) },
  ];
  for (const t of state.targets)
    for (const dir of deps.getTarget(t).outputDirs(paths.scope, paths.root, ctx.env))
      dirs.push({ target: t, dir });
  return dirs;
}

function overlaps(source: string, dir: string, root: string): boolean {
  if (source === root) return dir === root;
  return isWithin(dir, source) || isWithin(source, dir);
}

/**
 * Every local source that contains, equals or lies inside an output directory of an active
 * target or `.palm/assets`, on real paths (DESIGN §2). A source at the scope root is scanned
 * with the output directories excluded, so it only overlaps a directory equal to the root.
 */
export async function findOverlaps(
  ctx: PalmContext,
  state: ScopeState,
  deps: EngineDeps,
): Promise<Overlap[]> {
  const { paths } = state;
  const root = (await paths.realInside(paths.root)).real;
  const dirs = outputDirs(ctx, state, deps);
  const found: Overlap[] = [];
  for (const ref of state.sources.all()) {
    if (!ref.isLocal || !ref.source.path) continue;
    const real = (await paths.realInside(ref.source.path)).real;
    for (const { target, dir } of dirs) {
      const dirReal = (await paths.realInside(paths.abs(dir))).real;
      if (!overlaps(real, dirReal, root)) continue;
      found.push({ source: ref.name, sourceRel: paths.lockForm(ref.source.path), target, dir });
    }
  }
  return found;
}

/** E_SOURCE for the first local source that overlaps an output directory (DESIGN §2). */
export async function assertNoOverlap(
  ctx: PalmContext,
  state: ScopeState,
  deps: EngineDeps,
): Promise<void> {
  const [overlap] = await findOverlaps(ctx, state, deps);
  if (overlap) throw overlapError(overlap);
}

/** The lock's record of `name` as the scope was opened (before this run moved any sha). */
export function lockedSource(state: ScopeState, name: string): LockSource | undefined {
  return snapshotOf(state).sources[name];
}

/** Records the files a target wrote this run, for applied.yaml (global scope). */
export function noteWritten(state: ScopeState, rendered: Rendered): void {
  const { written } = snapshotOf(state);
  for (const f of rendered.files) written.set(state.paths.abs(f.path), sha256(f.data));
}

async function diskHash(abs: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(abs));
  } catch {
    return undefined;
  }
}

/** applied.yaml for the current lock: this run's hashes, else the previous record, else the disk. */
async function rewriteApplied(state: ScopeState, snap: Snapshot): Promise<void> {
  const { paths, lock } = state;
  const file = paths.appliedFile;
  if (!file) return;
  const hashes = new Map<string, string>();
  for (const entry of lock.entries)
    for (const p of entry.files) {
      const abs = paths.abs(p);
      const h = snap.written.get(abs) ?? state.applied?.fileHash(abs) ?? (await diskHash(abs));
      if (h) hashes.set(abs, h);
    }
  const applied = Applied.fromLock(lock, paths, hashes);
  await applied.save(file);
  state.applied = applied;
}

/**
 * Writes palm.yaml and the lock when they changed since the scope was opened or last saved
 * (never in a dry run). A project write adds the ignore lines once; under -g applied.yaml is
 * rewritten with the lock.
 */
export async function saveScope(
  state: ScopeState,
  opts: { manifest?: boolean; lock?: boolean } = {},
): Promise<void> {
  const snap = snapshotOf(state);
  if (snap.ctx.flags.dryRun) return;
  const { paths, manifest, lock } = state;
  const manifestText = text(manifest);
  const lockText = text(lock);
  const writeManifest = opts.manifest !== false && manifestText !== snap.manifest;
  const writeLock = opts.lock !== false && lockText !== snap.lock;
  if (writeManifest) await manifest.save(paths.manifestFile);
  if (writeLock) await lock.save(paths.lockFile);
  if ((writeManifest || writeLock) && paths.scope === 'project') {
    const line = await ensureIgnoreLines(paths.root, false);
    if (line) snap.ctx.log.info(line);
  }
  if (writeManifest) snap.manifest = manifestText;
  if (writeLock) snap.lock = lockText;
  const stale = state.applied?.record.lockHash !== lock.hash();
  if (paths.scope === 'global' && (writeLock || snap.written.size || stale))
    await rewriteApplied(state, snap);
  snap.written.clear();
}

/** Writes `targets:` into palm.yaml when it has none; true when it did. */
export async function persistTargets(state: ScopeState): Promise<boolean> {
  if (state.manifest.targets || !state.targets.length) return false;
  state.manifest.setTargets(state.targets);
  return true;
}
