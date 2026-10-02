import { promises as fs } from 'node:fs';
import path from 'node:path';
import { messageOf, PalmError } from '../core/errors.js';
import { isSkillCopySkipped, skillLeftOutReason } from '../domain/skill-copy.js';
import {
  isEnoent,
  isWithin,
  resolveWriteTarget,
  type WalkResult,
  walkFiles,
  writeFileAtomic,
} from '../lib/fs.js';

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

/** Permission bits of `file` (links followed), or undefined when it cannot be stat'ed. */
export async function statMode(file: string): Promise<number | undefined> {
  return fs.stat(file).then(
    (st) => st.mode & 0o777,
    () => undefined,
  );
}

export async function ensureMode(file: string, mode: number): Promise<void> {
  const current = await statMode(file);
  if (current !== undefined && current !== mode) await fs.chmod(file, mode);
}

/** The path a write to `file` lands on (the final target of a symlinked file); E_IO on failure. */
export async function writeTargetPath(file: string): Promise<string> {
  try {
    return await resolveWriteTarget(file);
  } catch (e) {
    throw ioError('resolve', file, e);
  }
}

/** Delete a file; missing files are fine. */
export async function removeFileIfExists(p: string): Promise<void> {
  try {
    await fs.rm(p, { force: true });
  } catch (e) {
    if (!isEnoent(e)) throw ioError('remove', p, e);
  }
}

/** A skill directory's files as the copy takes them, and the harness and palm paths left out. */
export interface SkillFiles extends WalkResult {
  /** Paths below the skill left out as harness, palm or environment files (ruling Y2). */
  leftOut: string[];
  /** Test directories and `*.test.*` files left out (ruling T2). */
  testsLeftOut: string[];
}

/**
 * Recursively list the files to copy from the skill directory `root`, leaving out at any depth
 * what `isSkillCopySkipped` names: `.git`, `node_modules`, harness directories (`.claude`,
 * `.cursor`, …), palm's files, `.env` files, test directories and `*.test.*` files. A skill's own
 * `AGENTS.md` or `CLAUDE.md` is copied (ruling X1). Sorted for determinism.
 *
 * Symlinks are followed only when their real target stays inside `boundary` (default: `root`
 * itself; callers pass the source root so links between skills of one repository keep working).
 * A link that points anywhere else (`notes.md -> ~/.ssh/id_rsa`, `refs -> /etc`) is never read
 * and is reported in `symlinksOutside`. The index scans the same files for secrets.
 */
export async function listSkillFiles(
  root: string,
  opts: { boundary?: string } = {},
): Promise<SkillFiles> {
  const leftOut: string[] = [];
  const testsLeftOut: string[] = [];
  const skip = (name: string, rel: string): boolean => {
    if (!isSkillCopySkipped(name)) return false;
    const reason = skillLeftOutReason(name);
    if (reason === 'harness') leftOut.push(rel);
    if (reason === 'test') testsLeftOut.push(rel);
    return true;
  };
  const walk = await walkFiles(root, { boundary: opts.boundary, skip });
  const dangling = await danglingOutside(root, opts.boundary ?? root, walk);
  const symlinksOutside = [...walk.symlinksOutside, ...dangling].sort();
  return { ...walk, symlinksOutside, leftOut, testsLeftOut };
}

/**
 * Skipped links whose target, read as text, lies outside `boundary`: a fetched source keeps a link
 * to `../../outside.txt` that dangles in the checkout, and it is a link leaving the source all
 * the same (ruling S5).
 */
async function danglingOutside(root: string, boundary: string, walk: WalkResult) {
  const realBoundary = await fs.realpath(boundary).catch(() => path.resolve(boundary));
  const out: string[] = [];
  for (const rel of walk.skipped.filter((r) => !walk.symlinksOutside.includes(r))) {
    const abs = path.join(root, ...rel.split('/'));
    const text = await fs.readlink(abs).catch(() => undefined);
    if (text === undefined) continue;
    const parent = await fs.realpath(path.dirname(abs)).catch(() => path.dirname(abs));
    if (!isWithin(path.resolve(parent, text), realBoundary)) out.push(rel);
  }
  return out;
}
