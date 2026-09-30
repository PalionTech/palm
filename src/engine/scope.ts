/**
 * One scope as the engine sees it (DESIGN §2, §3, §4): the paths, palm.yaml, the lock, the
 * declared sources, the target set and, under -g, the machine record `applied.yaml`.
 * `openScope` applies the scope guards and the overlap rule; `saveScope` writes only what
 * changed since it was opened or last saved.
 */
import { realpathSync } from 'node:fs';
import { readdir, readlink, stat } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { PalmError } from '../core/errors.js';
import { contentHash, diskContentHash } from '../core/hash.js';
import {
  globalDirHolding,
  globalManifestInside,
  isHomeAsProject,
  worktreeRoot,
} from '../core/paths.js';
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
import { localUrlPath } from '../domain/source-url.js';
import { isWithin, toPosix } from '../lib/fs.js';
import { redactTypedArgs } from '../secrets/typed.js';
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

/** The command line as typed with `-g` added, or the words that say so. */
function withGlobal(ctx: PalmContext): string {
  const argv = ctx.argv?.filter((w) => w !== '--');
  if (!argv?.length) return 'run the command again with -g';
  return `palm ${[...redactTypedArgs(argv), '-g'].join(' ')}`;
}

/**
 * The scope guards (DESIGN §2): project scope is never the home directory without a palm.yaml,
 * never inside palm home (or the directory the global palm.yaml really lives in) and never
 * inside a harness's global directory (J4, J5), nor a directory holding the global palm.yaml
 * (J7', a dotfiles repository); the fix is `-g`.
 */
export function assertScope(ctx: PalmContext, scope: Scope): void {
  if (scope !== 'project') return;
  if (isHomeAsProject(ctx.paths, ctx.env))
    throw new PalmError(
      'E_USAGE',
      'run inside a project or use -g: the home directory is not a project',
      'cd into a project and run palm again, or add -g to install for yourself',
    );
  const { cwd, projectRoot } = ctx.paths;
  for (const dir of [cwd, projectRoot]) {
    const what = globalDirHolding(dir, ctx.paths, ctx.env);
    if (what)
      throw new PalmError(
        'E_USAGE',
        `${dir} is inside ${what}, not a project; your own setup takes -g`,
        withGlobal(ctx),
      );
  }
  const manifest = globalManifestInside(projectRoot, ctx.paths);
  if (manifest)
    throw new PalmError(
      'E_USAGE',
      `${projectRoot} holds the global palm.yaml (${manifest}), not a project; your own setup takes -g`,
      withGlobal(ctx),
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
  opts: {
    readOnly?: boolean;
    deps?: EngineDeps;
    /** `palm migrate`: palm.yaml and the lock as converted, instead of the files on disk. */
    preload?: { manifest: Manifest; lock: Lock };
  } = {},
): Promise<ScopeState> {
  assertScope(ctx, scope);
  const paths = ScopePaths.of(ctx, scope);
  const manifest = opts.preload?.manifest ?? (await Manifest.load(paths.manifestFile));
  const lock = opts.preload?.lock ?? (await Lock.load(paths.lockFile));
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
  if (opts.deps && !opts.readOnly) {
    await assertNoOverlap(ctx, state, opts.deps);
    await noteOutputLinks(ctx, state, opts.deps);
  }
  return state;
}

/** A local source whose real path overlaps an output directory of an active target. */
export interface Overlap {
  source: string;
  sourceRel: string;
  target: TargetId | 'palm';
  /** The output directory, or the symlinked directory inside it that leads into the source. */
  dir: string;
  /** Set when a symlink leads there (`.claude/skills -> ../skill`): what the link says (C1). */
  link?: string;
}

/** The overlap in words (install, listing and `check` say the same). */
export function overlapMessage(o: Overlap): string {
  const what = o.target === 'palm' ? 'palm asset directory' : `${o.target} output directory`;
  const through = o.link ? ` through the symlink ${o.dir} -> ${o.link}` : ` ${o.dir}/`;
  return `source "${o.source}" (${o.sourceRel}) overlaps the ${what}${through}`;
}

function overlapError(o: Overlap): PalmError {
  return new PalmError(
    'E_SOURCE',
    overlapMessage(o),
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

/** A directory palm writes through: an output directory or a directory one level inside it. */
interface OutputDir {
  target: TargetId | 'palm';
  /** Lock form. */
  dir: string;
  /** Real path. */
  real: string;
  /** What the symlink says, when `dir` is one. */
  link?: string;
}

async function linkOf(abs: string): Promise<string | undefined> {
  return readlink(abs).catch(() => undefined);
}

/** The symlinked directories directly inside an output directory (`.claude/skills -> ../skill`). */
async function linkedChildren(state: ScopeState, o: OutputDir): Promise<OutputDir[]> {
  const { paths } = state;
  const entries = await readdir(paths.abs(o.dir), { withFileTypes: true }).catch(() => []);
  const out: OutputDir[] = [];
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue;
    const dir = `${o.dir}/${e.name}`;
    const abs = paths.abs(dir);
    const isDir = await stat(abs).then(
      (s) => s.isDirectory(),
      () => false,
    );
    const link = await linkOf(abs);
    if (isDir && link)
      out.push({ target: o.target, dir, real: (await paths.realInside(abs)).real, link });
  }
  return out;
}

/**
 * The directories palm writes through, on real paths: each output directory and every
 * symlinked directory one level inside it (C1: `.claude/skills -> ../skill`).
 */
async function writtenDirs(
  ctx: PalmContext,
  state: ScopeState,
  deps: EngineDeps,
): Promise<OutputDir[]> {
  const out: OutputDir[] = [];
  for (const { target, dir } of outputDirs(ctx, state, deps)) {
    const abs = state.paths.abs(dir);
    const link = await linkOf(abs);
    const own: OutputDir = { target, dir, real: (await state.paths.realInside(abs)).real };
    out.push(link ? { ...own, link } : own, ...(await linkedChildren(state, own)));
  }
  return out;
}

/**
 * Every local source that contains, equals or lies inside an output directory of an active
 * target or `.palm/assets`, on real paths (DESIGN §2), a symlinked directory inside an output
 * directory included (C1). A source at the scope root is scanned with the output directories
 * excluded, so it only overlaps a directory equal to the root.
 */
export async function findOverlaps(
  ctx: PalmContext,
  state: ScopeState,
  deps: EngineDeps,
): Promise<Overlap[]> {
  const { paths } = state;
  const root = (await paths.realInside(paths.root)).real;
  const dirs = await writtenDirs(ctx, state, deps);
  const found: Overlap[] = [];
  for (const ref of state.sources.all()) {
    if (!ref.isLocal || !ref.source.path) continue;
    const real = (await paths.realInside(ref.source.path)).real;
    const sourceRel = localPathOf(state, ref.source.path);
    for (const { target, dir, real: dirReal, link } of dirs) {
      if (!overlaps(real, dirReal, root)) continue;
      found.push({ source: ref.name, sourceRel, target, dir, ...(link ? { link } : {}) });
    }
  }
  return found;
}

/**
 * One line per symlinked output directory, once per run (C1): palm writes through the link, and
 * the person should know where the files land.
 */
export async function noteOutputLinks(
  ctx: PalmContext,
  state: ScopeState,
  deps: EngineDeps,
): Promise<void> {
  for (const d of await writtenDirs(ctx, state, deps))
    if (d.link && d.target !== 'palm')
      ctx.log.info(`${shownPath(state, d.dir)} is a symlink to ${d.link}; palm writes through it`);
}

/**
 * A declared local source outside the project (DESIGN §3): E_SOURCE on real paths. A nested
 * project may use a directory anywhere in its repository (B9). Project scope only;
 * normalizeSource cannot tell, since it does not know the scope (ruling 9).
 */
async function assertInsideProject(state: ScopeState): Promise<void> {
  const { paths } = state;
  if (paths.scope !== 'project') return;
  const top = worktreeRoot(paths.root) ?? paths.root;
  const root = (await paths.realInside(top)).real;
  for (const ref of state.sources.all()) {
    if (!ref.isLocal || !ref.source.path) continue;
    const { real } = await paths.realInside(ref.source.path);
    if (isWithin(real, root)) continue;
    throw new PalmError(
      'E_SOURCE',
      `source "${ref.name}" is outside the project ${top}; a local source is a directory inside it`,
      'move the directory into the project (for example ./agent-kit) and declare that in palm.yaml',
    );
  }
}

/** True when this run's command line names `url` (with or without `#ref`). */
function typedThisRun(ctx: PalmContext, url: string): boolean {
  return (ctx.argv ?? []).some((w) => w === url || w.startsWith(`${url}#`));
}

/**
 * S4: in a project, a `file://` URL (or an absolute path) outside the repository that only
 * palm.yaml names is refused like a `../` source: a committed palm.yaml must not make palm read
 * a private repository on this machine. Typed on this run's command line, it is the person's
 * own choice and goes through.
 */
async function assertNoOutsideUrl(ctx: PalmContext, state: ScopeState): Promise<void> {
  const { paths } = state;
  if (paths.scope !== 'project') return;
  const top = worktreeRoot(paths.root) ?? paths.root;
  const root = (await paths.realInside(top)).real;
  for (const ref of state.sources.all()) {
    const url = ref.isLocal ? undefined : ref.source.url;
    const dir = url ? localUrlPath(url) : undefined;
    if (!url || !dir || typedThisRun(ctx, url)) continue;
    if (isWithin((await paths.realInside(dir)).real, root)) continue;
    const names = state.manifest
      .allEntries()
      .filter((e) => e.source === ref.name)
      .map((e) => e.entry.name);
    throw new PalmError(
      'E_SOURCE',
      `source "${ref.name}" is ${url}, outside the project ${top}; palm.yaml names only sources inside it or remote URLs`,
      `to install from it on purpose, type its URL: ${['palm install', url, ...names].join(' ')}`,
    );
  }
}

/** E_SOURCE for the first local source outside the project or overlapping an output directory (DESIGN §2). */
export async function assertNoOverlap(
  ctx: PalmContext,
  state: ScopeState,
  deps: EngineDeps,
): Promise<void> {
  await assertInsideProject(state);
  await assertNoOutsideUrl(ctx, state);
  const [overlap] = await findOverlaps(ctx, state, deps);
  if (overlap) throw overlapError(overlap);
}

/**
 * A local source's path in lock form: project-relative (`agent-kit`, or `../kit` for a
 * directory elsewhere in the repository, B9), or a token path under -g (`<home>/dotfiles/kit`).
 */
export function localPathOf(state: ScopeState, abs: string): string {
  const { paths } = state;
  if (paths.scope !== 'project') return paths.lockForm(abs);
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return toPosix(relative(real(paths.root), real(abs))) || '.';
}

/**
 * A lock path as people read it: itself in a project, `~/…` under -g (tokens are for the lock
 * only, J24).
 */
export function shownPath(state: ScopeState, lockPath: string): string {
  const { paths } = state;
  if (paths.scope === 'project') return lockPath;
  const abs = paths.abs(lockPath);
  return isWithin(abs, paths.home) ? `~/${toPosix(relative(paths.home, abs))}` : abs;
}

/** The lock's record of `name` as the scope was opened (before this run moved any sha). */
export function lockedSource(state: ScopeState, name: string): LockSource | undefined {
  return snapshotOf(state).sources[name];
}

/** Records the files a target wrote this run, for applied.yaml (global scope). */
export function noteWritten(state: ScopeState, rendered: Rendered): void {
  const { written } = snapshotOf(state);
  for (const f of rendered.files) written.set(state.paths.abs(f.path), contentHash(f.data));
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
      const h =
        snap.written.get(abs) ?? state.applied?.fileHash(abs) ?? (await diskContentHash(abs));
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
