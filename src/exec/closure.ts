/**
 * The closure of an in-repo (in-place) source as the working tree holds it (ruling E2, which
 * reverses ruling 24): its scripts run from the repository, and the exec hash covers every byte
 * and executable bit of them, so an edited script asks for consent again, as the docs promise.
 * Paths are source-relative, like a git source's copy below its asset root; files follow the
 * same rules as the copy (`CLOSURE_NEVER` inside directories, the copy skip list), and a file a
 * script reads (`Closure.reads`) is kept whatever its name.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../core/hash.js';
import type { Closure, ClosureFile } from '../core/types.js';
import { isClosureExcluded, shouldSkipFile } from '../domain/ignore.js';
import { walkFiles } from '../lib/fs.js';

/** The mode git records: 755 for anything executable, else 644. */
function gitMode(mode: number): number {
  return mode & 0o111 ? 0o755 : 0o644;
}

async function fileOf(abs: string, rel: string): Promise<ClosureFile | undefined> {
  const [st, data] = await Promise.all([
    stat(abs).catch(() => undefined),
    readFile(abs).catch(() => undefined),
  ]);
  if (!st?.isFile() || !data) return undefined;
  return { path: rel, mode: gitMode(st.mode), size: data.byteLength, hash: sha256(data) };
}

/** The source-relative files below one closure path (a directory swallows its files). */
async function filesAt(sourceRoot: string, rel: string, reads: ReadonlySet<string>) {
  const abs = join(sourceRoot, ...rel.split('/'));
  const st = await stat(abs).catch(() => undefined);
  if (!st) return [];
  if (!st.isDirectory()) return reads.has(rel) || !isClosureExcluded(rel) ? [{ rel, abs }] : [];
  const walk = await walkFiles(abs, { boundary: sourceRoot, skip: (n) => shouldSkipFile(n) });
  return walk.files
    .map((f) => ({ rel: `${rel}/${f.rel}`, abs: f.abs }))
    .filter((f) => reads.has(f.rel) || !isClosureExcluded(f.rel));
}

/**
 * Every file of `closure` read in place from `sourceRoot`, sorted by path, without duplicates.
 * A path the working tree lacks is left out (`palm check` reports a missing hook script).
 */
export async function inPlaceClosure(sourceRoot: string, closure: Closure): Promise<ClosureFile[]> {
  const reads = new Set(closure.reads ?? []);
  const seen = new Map<string, string>();
  for (const p of closure.paths) {
    const rel = p.replace(/\/+$/, '');
    for (const f of await filesAt(sourceRoot, rel, reads)) seen.set(f.rel, f.abs);
  }
  const out: ClosureFile[] = [];
  for (const [rel, abs] of [...seen].sort(([a], [b]) => (a < b ? -1 : Number(a > b)))) {
    const file = await fileOf(abs, rel);
    if (file) out.push(file);
  }
  return out;
}
