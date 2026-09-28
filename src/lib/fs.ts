/**
 * Filesystem primitives: errno checks, containment, atomic writes, JSON files, pruning of
 * empty directories and a symlink-safe file walk. Errors from the filesystem propagate unchanged (check them with
 * `errnoCode`); callers wrap them in their own error types.
 */
import { randomBytes } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { parseJson, stringifyJson } from './json.js';

/** The `code` of a Node.js system error (`ENOENT`, `EACCES`, …), or undefined. */
export function errnoCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null || !('code' in e)) return undefined;
  return typeof e.code === 'string' ? e.code : undefined;
}

/** True when `e` is a "no such file or directory" error. */
export function isEnoent(e: unknown): boolean {
  return errnoCode(e) === 'ENOENT';
}

/** True when `p` exists (symlinks are followed, so a broken link does not exist). */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `a` and `b` name one existing file (same device and inode): case variants of a name
 * on a case-insensitive filesystem, or hard links. False when either is missing.
 */
export async function isSameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([stat(a), stat(b)]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/** Creates `dir` and its missing parents. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * True when `child` lies below `parent`, or equals it unless `strict` is set. Lexical only
 * (symlinks are not resolved); pass absolute paths (relative ones resolve against the cwd).
 */
export function isWithin(child: string, parent: string, opts: { strict?: boolean } = {}): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return !opts.strict;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** `p` with the platform separator replaced by `/`. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Permission bits of `p`, or undefined when it cannot be stat'ed. */
async function fileMode(p: string): Promise<number | undefined> {
  try {
    return (await stat(p)).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** Longest symlink chain `writeFileAtomic` follows (Linux's own limit). */
const MAX_LINK_HOPS = 40;

/**
 * The path a write to `file` lands on: `file` itself, or, when it is a symbolic link (or a
 * chain of them), the final target, so a dotfiles-managed `~/.claude/settings.json` stays a
 * link. A relative link resolves against the real directory holding it; a dangling link
 * resolves to its missing target. Symlinked parent directories need nothing special: the
 * temp file and the rename both go through them.
 */
export async function resolveWriteTarget(file: string): Promise<string> {
  let current = path.resolve(file);
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    let isLink: boolean;
    try {
      isLink = (await lstat(current)).isSymbolicLink();
    } catch (e) {
      if (isEnoent(e)) return current;
      throw e;
    }
    if (!isLink) return current;
    current = path.resolve(await realpath(path.dirname(current)), await readlink(current));
  }
  throw Object.assign(new Error(`too many levels of symbolic links: ${file}`), { code: 'ELOOP' });
}

/**
 * Writes `data` to `file` through a temp file and a rename in the same directory, creating
 * missing parent directories. A symlinked `file` is written through: the temp file and the
 * rename happen next to the link's final target, and the link itself is left in place. The
 * existing file's permission bits are kept unless `mode` is given. On failure the temp file is
 * removed and the error rethrown.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  opts: { mode?: number } = {},
): Promise<void> {
  const target = await resolveWriteTarget(file);
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const mode = opts.mode ?? (await fileMode(target));
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, data, mode === undefined ? {} : { mode });
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** UTF-8 content of `file`, or undefined when it does not exist. Other errors propagate. */
export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if (isEnoent(e)) return undefined;
    throw e;
  }
}

function parseJsonFile<T>(text: string, file: string, opts: { tolerant?: boolean }): T {
  try {
    return parseJson<T>(text, opts);
  } catch (e) {
    throw new Error(`invalid JSON in ${file}: ${(e as Error).message}`, { cause: e });
  }
}

/**
 * Reads and parses a JSON file (a BOM is ignored; `tolerant` also accepts comments and
 * trailing commas). Invalid JSON throws an Error naming the file; fs errors propagate.
 */
export async function readJsonFile<T = unknown>(
  file: string,
  opts: { tolerant?: boolean } = {},
): Promise<T> {
  return parseJsonFile<T>(await readFile(file, 'utf8'), file, opts);
}

/** Like `readJsonFile`, but undefined when the file is missing or blank. */
export async function readJsonIfExists<T = unknown>(
  file: string,
  opts: { tolerant?: boolean } = {},
): Promise<T | undefined> {
  const text = await readTextIfExists(file);
  if (text === undefined || text.trim() === '') return undefined;
  return parseJsonFile<T>(text, file, opts);
}

/** Writes `value` as JSON (2-space indent, trailing newline) with `writeFileAtomic`. */
export async function writeJsonFile(
  file: string,
  value: unknown,
  opts: { mode?: number } = {},
): Promise<void> {
  await writeFileAtomic(file, stringifyJson(value), opts);
}

/**
 * Removes empty directories from `dirname(from)` upwards, stopping below `stopAt` (never
 * removed, nor anything outside it). A missing directory is skipped; one that cannot be
 * removed (not empty, no permission) ends the walk. Returns the removed directories.
 */
export async function removeEmptyParents(from: string, stopAt: string): Promise<string[]> {
  const stop = path.resolve(stopAt);
  const removed: string[] = [];
  let dir = path.dirname(path.resolve(from));
  while (isWithin(dir, stop, { strict: true })) {
    try {
      await rmdir(dir);
      removed.push(dir);
    } catch (e) {
      if (!isEnoent(e)) break;
    }
    dir = path.dirname(dir);
  }
  return removed;
}

/**
 * Remove `dir` when it holds no file at any depth (only empty directories); true when it went.
 * Anything else (a file, a link, an unreadable entry) keeps it and its path to that entry.
 */
export async function removeEmptyTree(dir: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const e of entries)
    if (!e.isDirectory() || !(await removeEmptyTree(path.join(dir, e.name)))) empty = false;
  if (!empty) return false;
  return rmdir(dir).then(
    () => true,
    () => false,
  );
}

export interface WalkOptions {
  /** Symlinks are followed only when their real target lies inside this directory (default: the root). */
  boundary?: string;
  /** Entries left out (not listed, not entered), decided on the name before the entry is examined. */
  skip?: (name: string, rel: string) => boolean;
}

export interface WalkResult {
  /**
   * Regular files, depth first, each directory's names sorted: `rel` relative to the root (posix
   * separators), `abs` below the root (through any followed link), `mode` the permission bits.
   */
  files: Array<{ rel: string; abs: string; mode: number }>;
  /** Entries not followed: symlinks leaving the boundary, broken links, unreadable entries. `'.'` when the root itself leaves the boundary. */
  skipped: string[];
}

interface Walk {
  boundary: string;
  skip: (name: string, rel: string) => boolean;
  /** Real paths of the directories entered (a link back into one is not walked again). */
  seen: Set<string>;
  out: WalkResult;
}

/** Stats of `abs` (following a link whose real target stays inside `boundary`); undefined otherwise. */
async function statInside(abs: string, boundary: string): Promise<Stats | undefined> {
  try {
    const lst = await lstat(abs);
    if (!lst.isSymbolicLink()) return lst;
    return isWithin(await realpath(abs), boundary) ? await stat(abs) : undefined;
  } catch {
    return undefined; // broken link or unreadable entry
  }
}

async function walkDir(dir: string, relDir: string, w: Walk): Promise<void> {
  const real = await realpath(dir);
  if (w.seen.has(real)) return;
  w.seen.add(real);
  for (const name of (await readdir(dir)).sort()) {
    const rel = relDir ? `${relDir}/${name}` : name;
    if (w.skip(name, rel)) continue;
    const abs = path.join(dir, name);
    const st = await statInside(abs, w.boundary);
    if (!st) w.out.skipped.push(rel);
    else if (st.isDirectory()) await walkDir(abs, rel, w);
    else if (st.isFile()) w.out.files.push({ rel, abs, mode: st.mode & 0o777 });
  }
}

/**
 * Every regular file below the directory `root`. Symlinks are followed only when their real
 * target stays inside `boundary` (default: `root`); a link that points anywhere else, or is
 * broken, is never read and is reported in `skipped`. A symlinked `root` is resolved and checked
 * the same way. Each real directory is walked once, so links cannot loop. Errors reading `root`
 * itself propagate.
 */
export async function walkFiles(root: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const boundary = await realpath(opts.boundary ?? root);
  const out: WalkResult = { files: [], skipped: [] };
  if (!isWithin(await realpath(root), boundary)) {
    out.skipped.push('.');
    return out;
  }
  await walkDir(root, '', { boundary, skip: opts.skip ?? (() => false), seen: new Set(), out });
  return out;
}
