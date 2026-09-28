import { promises as fs } from 'node:fs';
import { messageOf, PalmError } from '../core/errors.js';
import { shouldSkipFile } from '../domain/ignore.js';
import { isEnoent, type WalkResult, walkFiles, writeFileAtomic } from '../lib/fs.js';

function ioError(action: string, p: string, e: unknown): PalmError {
  return new PalmError('E_IO', `cannot ${action} ${p}: ${messageOf(e)}`);
}

/** Read a file; `undefined` when it does not exist. Other errors become E_IO. */
export async function readFileOrUndefined(p: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(p);
  } catch (e) {
    if (isEnoent(e)) return undefined;
    throw ioError('read', p, e);
  }
}

export async function readTextOrUndefined(p: string): Promise<string | undefined> {
  const buf = await readFileOrUndefined(p);
  return buf?.toString('utf8');
}

/**
 * `writeFileAtomic` with failures as E_IO. Keeps the existing file's permission bits unless
 * `mode` is given (important for ~/.claude.json, 0600).
 */
export async function atomicWrite(
  file: string,
  data: string | Buffer,
  mode?: number,
): Promise<void> {
  try {
    await writeFileAtomic(file, data, { mode });
  } catch (e) {
    throw ioError('write', file, e);
  }
}

export async function ensureMode(file: string, mode: number): Promise<void> {
  const current = await fs.stat(file).then(
    (st) => st.mode & 0o777,
    () => undefined,
  );
  if (current !== undefined && current !== mode) await fs.chmod(file, mode);
}

/** Delete a file; missing files are fine. */
export async function removeFileIfExists(p: string): Promise<void> {
  try {
    await fs.rm(p, { force: true });
  } catch (e) {
    if (!isEnoent(e)) throw ioError('remove', p, e);
  }
}

export async function removeDirIfExists(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

/**
 * Recursively list the files to copy from `root`, skipping `COPY_SKIP` (`.git`, `node_modules`,
 * `.DS_Store`, `*.zip`) at any depth and the names in `skipTop` at the top level. Sorted for
 * determinism.
 *
 * Symlinks are followed only when their real target stays inside `boundary` (default: `root`
 * itself; callers pass the origin root so links between skills of one repository keep working).
 * A link that points anywhere else (`notes.md -> ~/.ssh/id_rsa`, `refs -> /etc`) is never read
 * and is reported in `skipped`. A symlinked `root` is resolved and checked the same way. Content
 * hashes (core/hash) walk with the same rule, so what is copied is what is hashed.
 */
export async function listCopyFiles(
  root: string,
  opts: { skipTop?: readonly string[]; boundary?: string } = {},
): Promise<WalkResult> {
  const skipTop = opts.skipTop ?? [];
  return walkFiles(root, {
    boundary: opts.boundary,
    skip: (name, rel) => shouldSkipFile(name) || (rel === name && skipTop.includes(name)),
  });
}
