/**
 * One-pass file index of a source: every potentially relevant file (md/mdc/json/toml, apm.yml)
 * under the root, honouring ignore rules, including dot directories, and following symlinks only
 * when they stay inside the source (with loop protection).
 *
 * The walk runs once; directory indexes built from it (files per directory, child directories,
 * skill directories per parent) answer the scanner's per-plugin lookups without rescanning the
 * file list.
 */

import { realpathSync, statSync } from 'node:fs';
import { readlink, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import fg from 'fast-glob';
import { INSTALL_OUTPUT_DIRS, isScanIgnoredRel } from '../domain/ignore.js';
import { isWithin, toPosix } from '../lib/fs.js';
import { rebaseIgnore } from './ignore.js';
import { baseOf, dirDepth, dirOf } from './util.js';

export interface FileIndexOptions {
  ignore: string[];
  /** fast-glob `deep`: files up to `deep - 1` directories below the root. */
  deep: number;
  /** Also skip symlinked directories whose path hits the default ignore names. */
  ignoreDirNames: boolean;
}

const RELEVANT_EXT = ['.md', '.mdc', '.json', '.toml'];

/** What a source-relative path names on disk. */
export type PathKind = 'file' | 'dir' | 'outside';

function locateOnDisk(realRoot: string, abs: string): PathKind | undefined {
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return undefined;
  }
  if (!isWithin(real, realRoot)) return 'outside';
  const st = statSync(real, { throwIfNoEntry: false });
  if (st?.isFile()) return 'file';
  return st?.isDirectory() ? 'dir' : undefined;
}

function isRelevantFile(rel: string): boolean {
  const base = baseOf(rel).toLowerCase();
  if (base === 'apm.yml' || base === 'apm.yaml') return true;
  return RELEVANT_EXT.some((e) => base.endsWith(e));
}

/** Shallowest first, then by path. */
export function byDepthThenPath(a: string, b: string): number {
  const d = dirDepth(a) - dirDepth(b);
  if (d !== 0) return d;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function pushTo(map: Map<string, string[]>, key: string, value: string): string[] {
  const list = map.get(key);
  if (list) {
    list.push(value);
    return list;
  }
  const created = [value];
  map.set(key, created);
  return created;
}

export class FileIndex {
  /** Relative posix paths, sorted. */
  readonly files: string[] = [];
  readonly warnings: string[] = [];
  /** Links whose target lies outside the source, dangling ones included (ruling S5). */
  readonly linksLeaving: string[] = [];
  private readonly fileSet = new Set<string>();
  /** Every ancestor directory of a listed file ('' excluded). */
  private readonly dirSet = new Set<string>();
  /** rel → real absolute path (differs from join(root, rel) under followed symlinks). */
  private readonly real = new Map<string, string>();
  private readonly filesByDir = new Map<string, string[]>();
  private readonly subdirsByDir = new Map<string, string[]>();
  private readonly skillDirSet = new Set<string>();
  /** Parent directory → skill directories directly inside it (the root skill '' excluded). */
  private readonly skillsByParent = new Map<string, string[]>();
  /** Lists that gained entries since the last `finish()`. */
  private readonly unsorted = new Set<string[]>();

  constructor(
    readonly rootAbs: string,
    readonly realRoot: string,
  ) {}

  /** Record one file (ignored when already listed or not relevant). */
  addFile(rel: string, realAbs: string): void {
    if (this.fileSet.has(rel) || !isRelevantFile(rel)) return;
    this.fileSet.add(rel);
    this.files.push(rel);
    this.real.set(rel, realAbs);
    const dir = dirOf(rel);
    this.unsorted.add(pushTo(this.filesByDir, dir, rel));
    this.addAncestors(dir);
    if (baseOf(rel) !== 'SKILL.md' || this.skillDirSet.has(dir)) return;
    this.skillDirSet.add(dir);
    if (dir !== '') this.unsorted.add(pushTo(this.skillsByParent, dirOf(dir), dir));
  }

  private addAncestors(dir: string): void {
    let d = dir;
    while (d !== '' && !this.dirSet.has(d)) {
      this.dirSet.add(d);
      this.unsorted.add(pushTo(this.subdirsByDir, dirOf(d), d));
      d = dirOf(d);
    }
  }

  /** Sort every list touched since the last call. */
  finish(): void {
    this.files.sort();
    for (const list of this.unsorted) list.sort();
    this.unsorted.clear();
  }

  /** Add the files of `sub` (an index of the directory `prefix`) under `prefix`. */
  merge(prefix: string, sub: FileIndex): void {
    for (const f of sub.files) this.addFile(`${prefix}/${f}`, sub.realPathOf(f));
    this.finish();
  }

  hasFile(rel: string): boolean {
    return this.fileSet.has(rel);
  }

  /** True for the root and every directory that holds an indexed file. */
  hasDir(rel: string): boolean {
    return rel === '' || this.dirSet.has(rel);
  }

  realPathOf(rel: string): string {
    return this.real.get(rel) ?? join(this.realRoot, rel);
  }

  /**
   * What `rel` names: an indexed file or directory, else whatever is on disk (scripts and ignored
   * directories such as `dist/` are not indexed). `outside` for a link that leaves the source.
   * Synchronous, for the reference resolver; it runs a handful of times per hook or server.
   */
  locate(rel: string): PathKind | undefined {
    if (this.fileSet.has(rel)) return 'file';
    if (this.hasDir(rel)) return 'dir';
    return locateOnDisk(this.realRoot, join(this.rootAbs, rel));
  }

  /** True when `rel` was reached through a symlink (its real path differs from its location). */
  isLinked(rel: string): boolean {
    const real = this.real.get(rel);
    return real !== undefined && real !== join(this.realRoot, rel);
  }

  /** Files directly inside `dirRel` ('' = root), sorted. */
  filesIn(dirRel: string): string[] {
    return [...(this.filesByDir.get(dirRel) ?? [])];
  }

  /** Directories directly inside `dirRel`, sorted. */
  subdirsOf(dirRel: string): readonly string[] {
    return this.subdirsByDir.get(dirRel) ?? [];
  }

  /** Files at most `maxDirDepth` directory levels below `dirRel`, sorted. */
  filesUnder(dirRel: string, maxDirDepth = Number.POSITIVE_INFINITY): string[] {
    const out: string[] = [];
    const visit = (dir: string, depth: number): void => {
      out.push(...(this.filesByDir.get(dir) ?? []));
      if (depth >= maxDirDepth) return;
      for (const sub of this.subdirsOf(dir)) visit(sub, depth + 1);
    };
    visit(dirRel, 0);
    return out.sort();
  }

  isSkillDir(dirRel: string): boolean {
    return this.skillDirSet.has(dirRel);
  }

  /** Every directory holding a SKILL.md ('' when the root does). */
  allSkillDirs(): string[] {
    return [...this.skillDirSet];
  }

  /** Skill directories directly inside `dirRel`, sorted. */
  childSkillDirs(dirRel: string): string[] {
    return [...(this.skillsByParent.get(dirRel) ?? [])];
  }

  /** Skill directories at or below `dirRel` (nested ones included). */
  skillDirsWithin(dirRel: string): string[] {
    if (dirRel === '') return this.allSkillDirs();
    const out: string[] = [];
    const visit = (dir: string): void => {
      if (this.skillDirSet.has(dir)) out.push(dir);
      for (const sub of this.subdirsOf(dir)) visit(sub);
    };
    visit(dirRel);
    return out;
  }

  /**
   * Top-most skill directories below `dirRel`: its direct children when there are any, else the
   * shallowest skill directories up to `maxDepth` levels down (buckets like `skills/engineering/*`).
   */
  skillDirsBelow(dirRel: string, maxDepth = 3): string[] {
    const direct = this.childSkillDirs(dirRel);
    if (direct.length > 0) return direct;
    const out: string[] = [];
    const visit = (dir: string, depth: number): void => {
      for (const sub of this.subdirsOf(dir)) {
        if (this.skillDirSet.has(sub)) out.push(sub);
        else if (depth < maxDepth) visit(sub, depth + 1);
      }
    };
    visit(dirRel, 1);
    return out.sort(byDepthThenPath);
  }

  /** True when a directory above `rel` (the root included) holds a SKILL.md. */
  insideSkillDir(rel: string): boolean {
    return this.nearestSkillDir(dirOf(rel)) !== undefined;
  }

  /** The closest skill directory strictly above the directory `dirRel`. */
  parentSkillDir(dirRel: string): string | undefined {
    return dirRel === '' ? undefined : this.nearestSkillDir(dirOf(dirRel));
  }

  private nearestSkillDir(from: string): string | undefined {
    let d = from;
    for (;;) {
      if (this.skillDirSet.has(d)) return d;
      if (d === '') return undefined;
      d = dirOf(d);
    }
  }

  /** Names directly inside `dirRel` for a directory listing: [files, directories]. */
  entriesOf(dirRel: string): [files: string[], dirs: string[]] {
    const names = (list: readonly string[] | undefined) => (list ?? []).map((p) => baseOf(p));
    return [names(this.filesByDir.get(dirRel)), names(this.subdirsByDir.get(dirRel))];
  }
}

interface WalkFrame {
  absDir: string;
  /** Source-relative path of `absDir` ('' at the root). */
  prefix: string;
  realDir: string;
  /** Path of `realDir` relative to the source's real root ('' at the root). */
  realRel: string;
  deep: number;
  /** Real directories on the current link chain (loop protection). */
  chain: Set<string>;
}

interface Walk {
  index: FileIndex;
  opts: FileIndexOptions;
}

const joinPrefix = (prefix: string, rel: string): string =>
  prefix === '' ? rel : `${prefix}/${rel}`;

export async function buildFileIndex(rootAbs: string, opts: FileIndexOptions): Promise<FileIndex> {
  const realRoot = await realpath(rootAbs);
  const index = new FileIndex(rootAbs, realRoot);
  const frame = { absDir: rootAbs, prefix: '', realDir: realRoot, realRel: '', deep: opts.deep };
  await walkTree({ index, opts }, { ...frame, chain: new Set([realRoot]) });
  index.finish();
  if (index.linksLeaving.length) index.warnings.push(linksLeavingNote(index.linksLeaving.sort()));
  return index;
}

async function walkTree(w: Walk, frame: WalkFrame): Promise<void> {
  const ignore = frame.prefix === '' ? w.opts.ignore : rebaseIgnore(w.opts.ignore, frame.prefix);
  const entries = await fg('**/*', {
    cwd: frame.absDir,
    dot: true,
    deep: frame.deep,
    followSymbolicLinks: false,
    onlyFiles: false,
    objectMode: true,
    ignore,
    suppressErrors: true,
  });
  const links: string[] = [];
  for (const e of entries) {
    if (reachesOutput(w, joinPrefix(frame.realRel, e.path))) continue;
    if (e.dirent.isFile())
      w.index.addFile(joinPrefix(frame.prefix, e.path), join(frame.realDir, e.path));
    else if (e.dirent.isSymbolicLink()) links.push(e.path);
  }
  for (const linkPath of links) await followLink(w, frame, linkPath);
}

/**
 * True when `realRel` (a path relative to the source's real root) lies in an install output
 * directory (`.claude/skills`, …): palm's own copies, which a symlink may reach under another
 * name (`mirror -> .claude/skills`). Auto-detected scans skip them (ruling C4).
 */
function reachesOutput(w: Walk, realRel: string): boolean {
  if (!w.opts.ignoreDirNames) return false;
  const padded = `/${realRel}/`;
  return INSTALL_OUTPUT_DIRS.some((d) => padded.includes(`/${d}/`));
}

/**
 * True when the dangling link `linkAbs` names a path outside the source: a fetched source keeps a
 * link to `../../outside.txt` whose target exists only on the author's machine (ruling S5).
 */
async function danglingLeaves(w: Walk, linkAbs: string, realParent: string): Promise<boolean> {
  const text = await readlink(linkAbs).catch(() => undefined);
  return text !== undefined && !isWithin(resolve(realParent, text), w.index.realRoot);
}

/** One note for the links a scan did not follow out of the source (ruling S5, the copy's wording). */
function linksLeavingNote(rels: readonly string[]): string {
  const shown = rels.slice(0, 3).join(', ');
  const more = rels.length > 3 ? ` +${rels.length - 3}` : '';
  const what = rels.length === 1 ? 'a link leaving the source' : 'links leaving the source';
  return `not copied (${what}): ${shown}${more}`;
}

async function realpathOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined; // broken link
  }
}

async function statKind(p: string): Promise<'file' | 'dir' | undefined> {
  try {
    const st = await stat(p);
    if (st.isFile()) return 'file';
    return st.isDirectory() ? 'dir' : undefined;
  } catch {
    return undefined;
  }
}

/** Index a symlink found by the walk: a file link directly, a directory link by walking it. */
async function followLink(w: Walk, frame: WalkFrame, linkPath: string): Promise<void> {
  const rel = joinPrefix(frame.prefix, linkPath);
  const linkAbs = join(frame.absDir, linkPath);
  const target = await realpathOrUndefined(linkAbs);
  const leaves =
    target === undefined
      ? await danglingLeaves(w, linkAbs, join(frame.realDir, dirOf(linkPath)))
      : !isWithin(target, w.index.realRoot);
  if (leaves) w.index.linksLeaving.push(rel);
  if (target === undefined || leaves) return;
  const realRel = toPosix(relative(w.index.realRoot, target));
  if (reachesOutput(w, realRel)) return;
  const kind = await statKind(target);
  if (kind === 'file') w.index.addFile(rel, target);
  if (kind !== 'dir' || (w.opts.ignoreDirNames && isScanIgnoredRel(rel))) return;
  const linkRealParent = join(frame.realDir, dirOf(linkPath));
  // A link to one of its own ancestors (or already on the walk chain) would loop.
  if (isWithin(linkRealParent, target) || frame.chain.has(target)) return;
  const remaining = frame.deep - linkPath.split('/').length;
  if (remaining < 1) return;
  await walkTree(w, {
    absDir: join(frame.absDir, linkPath),
    prefix: rel,
    realDir: target,
    realRel,
    deep: remaining,
    chain: new Set([...frame.chain, target]),
  });
}
