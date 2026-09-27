import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PalmError } from '../core/errors.js';

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Read a file; `undefined` when it does not exist. Other errors become E_IO. */
export async function readFileOrUndefined(p: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(p);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return undefined;
    throw new PalmError('E_IO', `cannot read ${p}: ${(e as Error).message}`);
  }
}

export async function readTextOrUndefined(p: string): Promise<string | undefined> {
  const buf = await readFileOrUndefined(p);
  return buf?.toString('utf8');
}

async function fileMode(p: string): Promise<number | undefined> {
  try {
    return (await fs.stat(p)).mode & 0o777;
  } catch {
    return undefined;
  }
}

/**
 * Write via temp file + rename in the same directory. Keeps the existing file's
 * permission bits unless `mode` is given (important for ~/.claude.json, 0600).
 */
export async function atomicWrite(file: string, data: string | Buffer, mode?: number): Promise<void> {
  const dir = path.dirname(file);
  try {
    await fs.mkdir(dir, { recursive: true });
    const finalMode = mode ?? (await fileMode(file));
    const tmp = path.join(dir, `.${path.basename(file)}.palm-${randomBytes(6).toString('hex')}.tmp`);
    await fs.writeFile(tmp, data);
    if (finalMode !== undefined) await fs.chmod(tmp, finalMode);
    await fs.rename(tmp, file);
  } catch (e) {
    if (e instanceof PalmError) throw e;
    throw new PalmError('E_IO', `cannot write ${file}: ${(e as Error).message}`);
  }
}

export async function ensureMode(file: string, mode: number): Promise<void> {
  const current = await fileMode(file);
  if (current !== undefined && current !== mode) await fs.chmod(file, mode);
}

/** Delete a file; missing files are fine. */
export async function removeFileIfExists(p: string): Promise<void> {
  try {
    await fs.rm(p, { force: true });
  } catch (e) {
    if (errCode(e) !== 'ENOENT') throw new PalmError('E_IO', `cannot remove ${p}: ${(e as Error).message}`);
  }
}

export async function removeDirIfExists(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

/** True when `child` is `parent` or lies below it. */
export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Remove empty directories from dirname(file) upwards, stopping before `stopDir`
 * (which is never removed). Non-empty or missing directories end the walk.
 */
export async function removeEmptyParents(file: string, stopDir: string): Promise<void> {
  let dir = path.dirname(file);
  while (dir !== stopDir && isWithin(dir, stopDir)) {
    try {
      await fs.rmdir(dir);
    } catch (e) {
      if (errCode(e) !== 'ENOENT') return;
    }
    dir = path.dirname(dir);
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export interface SourceFile {
  /** Path relative to the copied root, posix separators. */
  rel: string;
  abs: string;
  mode: number;
}

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.DS_Store']);

/**
 * Recursively list the files to copy from `root`, skipping `.git`, `node_modules`,
 * `*.zip`, `.DS_Store` and any top-level names in `skipTop`. Symlinks are followed
 * (with a cycle guard). Sorted for determinism.
 */
export async function listCopyableFiles(root: string, skipTop: readonly string[] = []): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
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
        st = await fs.stat(abs);
      } catch {
        continue; // broken symlink
      }
      if (st.isDirectory()) await walk(abs, rel);
      else if (st.isFile()) out.push({ rel, abs, mode: st.mode & 0o777 });
    }
  }
  await walk(root, '');
  return out;
}
