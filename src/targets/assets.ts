/**
 * The asset closure (DESIGN.md section 2): the files a hook or stdio MCP server runs, copied
 * from a git source into `.palm/assets/<source>/<entity>/` (committed with the project), never
 * the whole source. In-repo sources are not copied: their scripts run in place.
 *
 * What is read: every file under each closure path (a directory swallows its files), minus
 * `CLOSURE_NEVER` (skills, root docs, manifests, `.git*`, `node_modules`) and the copy skip list.
 * Symlinks are dereferenced while their real target stays inside the source; a link that leaves
 * it refuses the entity (E_SOURCE). Modes are kept as git keeps them (755 for an executable, else
 * 644), so the render and the exec hash are the same on every machine.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { messageOf, PalmError } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import type { Closure, ClosureFile } from '../core/types.js';
import { isClosureExcluded, shouldSkipFile } from '../domain/ignore.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import type { SourceRef } from '../domain/source.js';
import { isEnoent, isWithin, toPosix, walkFiles, writeFileAtomic } from '../lib/fs.js';
import { isSafeName } from '../lib/names.js';

/** One closure file as read from the source. */
export interface ClosureEntry {
  /** Source-relative posix path (also its path below the asset root). */
  rel: string;
  mode: number;
  data: Buffer;
}

/** The mode git records: 755 for anything executable, else 644. */
export function gitMode(mode: number): number {
  return mode & 0o111 ? 0o755 : 0o644;
}

function leaves(link: string, boundary: string, real?: string): PalmError {
  const where = real ? `to ${real}, ` : '';
  return new PalmError(
    'E_SOURCE',
    `refusing to copy ${link}: it links ${where}outside the source ${boundary}`,
    'remove the link from the source, or copy the file into it',
  );
}

/** The files below one closure path: [rel, abs] pairs, links checked against `boundary`. */
async function filesAt(
  sourceRoot: string,
  rel: string,
  boundary: string,
): Promise<Array<{ rel: string; abs: string }>> {
  const abs = path.join(sourceRoot, ...rel.split('/'));
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch (e) {
    if (isEnoent(e))
      throw new PalmError('E_SOURCE', `closure path ${rel} is missing in the source ${sourceRoot}`);
    throw new PalmError('E_IO', `cannot read ${abs}: ${messageOf(e)}`);
  }
  if (!isWithin(real, boundary)) throw leaves(abs, boundary, real);
  if (!(await fs.stat(abs)).isDirectory()) return [{ rel, abs }];
  const walk = await walkFiles(abs, { boundary, skip: (name: string) => shouldSkipFile(name) });
  const outside = walk.symlinksOutside[0];
  if (outside !== undefined) throw leaves(path.join(abs, outside), boundary);
  return walk.files.map((f) => ({ rel: path.posix.join(rel, f.rel), abs: f.abs }));
}

/**
 * Every file of `closure`, read from `sourceRoot`, sorted by path, deduplicated, excluded names
 * left out. `boundary` (default: `sourceRoot`) is where symlinks may point.
 */
export async function readClosure(
  sourceRoot: string,
  closure: Closure,
  boundary = sourceRoot,
): Promise<ClosureEntry[]> {
  const realBoundary = await fs.realpath(boundary);
  const seen = new Map<string, string>();
  for (const p of closure.paths) {
    const rel = toPosix(path.normalize(p)).replace(/\/$/, '');
    for (const f of await filesAt(sourceRoot, rel, realBoundary))
      if (!isClosureExcluded(f.rel)) seen.set(f.rel, f.abs);
  }
  const out: ClosureEntry[] = [];
  for (const [rel, abs] of [...seen].sort(([a], [b]) => Number(a > b) - Number(a < b))) {
    const st = await fs.stat(abs);
    out.push({ rel, mode: gitMode(st.mode), data: await fs.readFile(abs) });
  }
  return out;
}

/**
 * Copy `closure` from `sourceRoot` into `destAbs`, keeping modes; returns what was copied, paths
 * relative to `destAbs`. A symlink leaving `boundary` refuses the copy before anything is written.
 */
export async function copyClosure(input: {
  sourceRoot: string;
  closure: Closure;
  destAbs: string;
  boundary: string;
}): Promise<ClosureFile[]> {
  const files = await readClosure(input.sourceRoot, input.closure, input.boundary);
  for (const f of files)
    await writeFileAtomic(path.join(input.destAbs, ...f.rel.split('/')), f.data, { mode: f.mode });
  return files.map((f) => ({ path: f.rel, mode: f.mode, size: f.data.byteLength, hash: sha256(f.data) }));
}

/**
 * Lock form of the directory an entity's closure lives in: `.palm/assets/<source>/<entity>`
 * (`<palm>/assets/…` at global scope) for git sources, the source's own directory in place.
 */
export function assetRootFor(
  paths: ScopePaths,
  source: SourceRef,
  entity: string,
  inPlace: boolean,
): string {
  if (!isSafeName(entity))
    throw new PalmError('E_USAGE', `refusing an asset directory for "${entity}"`);
  if (!inPlace) return paths.assetRoot(source, entity);
  const dir = source.source.path;
  if (dir === undefined)
    throw new PalmError('E_INTERNAL', `source ${source.name} has no path to run in place`);
  return paths.lockForm(dir);
}
