/**
 * Filesystem primitives: errno checks, containment, atomic writes, JSON files and pruning of
 * empty directories. Errors from the filesystem propagate unchanged (check them with
 * `errnoCode`); callers wrap them in their own error types.
 */
import { randomBytes } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  readFile,
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

/**
 * Writes `data` to `file` through a temp file and a rename in the same directory, creating
 * missing parent directories. The existing file's permission bits are kept unless `mode` is
 * given. On failure the temp file is removed and the error rethrown.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  opts: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const mode = opts.mode ?? (await fileMode(file));
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, data, mode === undefined ? {} : { mode });
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, file);
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
