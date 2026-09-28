import { promises as fs } from 'node:fs';
import path from 'node:path';
import { messageOf, PalmError } from '../core/errors.js';
import { isEnoent, isWithin, writeFileAtomic } from '../lib/fs.js';

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

export interface SourceFile {
  /** Path relative to the copied root, posix separators. */
  rel: string;
  abs: string;
  mode: number;
}

export interface CopyListing {
  files: SourceFile[];
  /** Symlinks that were not followed (target outside the boundary, or broken), relative to the root. */
  skipped: string[];
}

// Wave 2: one skip list with src/index (targets may not import src/index today).
const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.DS_Store']);

/**
 * Recursively list the files to copy from `root`, skipping `.git`, `node_modules`,
 * `*.zip`, `.DS_Store` and any top-level names in `skipTop`. Sorted for determinism.
 *
 * Symlinks are followed only when their real target stays inside `boundary`
 * (default: `root` itself; callers pass the origin root so links between skills of one
 * repository keep working). A link that points anywhere else (`notes.md -> ~/.ssh/id_rsa`,
 * `refs -> /etc`) is never read and is reported in `skipped`. A symlinked `root` is
 * resolved and checked the same way.
 */
export async function listCopyFiles(
  root: string,
  opts: { skipTop?: readonly string[]; boundary?: string } = {},
): Promise<CopyListing> {
  const skipTop = opts.skipTop ?? [];
  const files: SourceFile[] = [];
  const skipped: string[] = [];
  const boundary = await fs.realpath(opts.boundary ?? root);
  const realRoot = await fs.realpath(root);
  if (!isWithin(realRoot, boundary)) return { files, skipped: ['.'] };
  const seen = new Set<string>();
  async function walk(dir: string, relDir: string): Promise<void> {
    const real = await fs.realpath(dir);
    if (seen.has(real)) return;
    seen.add(real);
    const names = (await fs.readdir(dir)).sort();
    for (const name of names) {
      if (ALWAYS_SKIP.has(name) || name.toLowerCase().endsWith('.zip')) continue;
      if (relDir === '' && skipTop.includes(name)) continue;
      const abs = path.join(dir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      let st;
      try {
        const lst = await fs.lstat(abs);
        if (lst.isSymbolicLink()) {
          const target = await fs.realpath(abs); // throws for a broken link
          if (!isWithin(target, boundary)) {
            skipped.push(rel);
            continue;
          }
        }
        st = await fs.stat(abs);
      } catch {
        skipped.push(rel); // broken symlink or unreadable entry
        continue;
      }
      if (st.isDirectory()) await walk(abs, rel);
      else if (st.isFile()) files.push({ rel, abs, mode: st.mode & 0o777 });
    }
  }
  await walk(root, '');
  return { files, skipped };
}
