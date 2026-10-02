/**
 * Content hashes: an entity's source (`hashPath`), a directory tree with modes (`treeHash`, the
 * local source tree and the asset closure), and plain values (`hashValue`). Every hash is
 * `sha256:<hex>`; text is hashed with LF line ends so a `core.autocrlf` checkout agrees.
 */
import { createHash, type Hash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { HASH_SKIP, matchesSkip } from '../domain/ignore.js';
import { contentHash, lfText, sha256 } from '../lib/digest.js';
import { isWithin, walkFiles } from '../lib/fs.js';
import { canonicalJson } from '../lib/json.js';
import { PalmError } from './errors.js';
import type { ClosureFile } from './types.js';

export { contentHash, lfText, sameContent, sha256, short } from '../lib/digest.js';

async function hashFile(h: Hash, abs: string): Promise<void> {
  h.update(lfText(await readFile(abs)));
}

/**
 * The content hash of the file at `abs` as palm compares it with a render or a record (O1): text
 * with LF line ends, so a checkout whose clean filter or `core.autocrlf` changed them agrees.
 * Undefined when the file cannot be read.
 */
export async function diskContentHash(abs: string): Promise<string | undefined> {
  try {
    return contentHash(await readFile(abs));
  } catch {
    return undefined;
  }
}

/**
 * sha256 of a file's bytes, or of a directory as the sorted list of (relative posix path + NUL +
 * content + NUL) for every regular file. Text content is hashed with LF line ends.
 *
 * The directory walk is the copy walk (lib/fs `walkFiles`): `HASH_SKIP` (= `COPY_SKIP`) is left
 * out, and a symlink is followed, and its target hashed, only when its real path stays inside
 * `opts.boundary` (default: `absPath`; the engine passes the source root, like the copy). So a
 * content hash covers exactly the files a deploy copies. A root whose real path leaves the
 * boundary is an E_IO error.
 */
export async function hashPath(
  absPath: string,
  opts: { boundary?: string; skip?: (rel: string) => boolean } = {},
): Promise<string> {
  const real = await realpath(absPath).catch(() => undefined);
  if (real === undefined)
    throw new PalmError('E_IO', `cannot hash ${absPath}: no such file or directory`);
  const boundary = await realpath(opts.boundary ?? absPath);
  if (!isWithin(real, boundary))
    throw new PalmError('E_IO', `cannot hash ${absPath}: it links outside ${boundary}`);
  const h = createHash('sha256');
  if ((await stat(real)).isDirectory()) {
    const { files } = await walkFiles(absPath, {
      boundary,
      skip: (name, rel) => matchesSkip(HASH_SKIP, name) || !!opts.skip?.(rel),
    });
    const byRel = new Map(files.map((f) => [f.rel, f.abs]));
    for (const rel of [...byRel.keys()].sort()) {
      h.update(rel);
      h.update('\0');
      await hashFile(h, byRel.get(rel) as string);
      h.update('\0');
    }
  } else {
    await hashFile(h, real);
  }
  return `sha256:${h.digest('hex')}`;
}

/** sha256 of plain data in canonical JSON (key order never matters). */
export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** The mode a tree records: 0o755 when any execute bit is set, else 0o644 (git's two modes). */
function treeMode(mode: number): number {
  return mode & 0o111 ? 0o755 : 0o644;
}

/**
 * The tree hash of `root` (DESIGN.md section 4 "Source tree hash", section 7 closure tree):
 * sha256 over the sorted lines `path NUL mode NUL sha256(content)` of every regular file,
 * `path` relative and posix, `mode` 755 or 644, content with CRLF normalised to LF when it is
 * text. `skip(rel)` leaves a file or directory out (decided before it is entered); symlinks are
 * followed only inside `boundary` (default `root`). Independent of creation order and of line
 * endings. `files` lists what was hashed, sorted by path.
 */
export async function treeHash(
  root: string,
  opts: { skip: (rel: string) => boolean; boundary?: string },
): Promise<{ tree: string; files: ClosureFile[] }> {
  const walked = await walkFiles(root, {
    boundary: opts.boundary ?? root,
    skip: (_name, rel) => opts.skip(rel),
  });
  const files: ClosureFile[] = [];
  for (const f of [...walked.files].sort((a, b) => (a.rel < b.rel ? -1 : Number(a.rel > b.rel)))) {
    const hash = contentHash(await readFile(f.abs));
    files.push({ path: f.rel, mode: treeMode(f.mode), size: f.size, hash });
  }
  const lines = files.map((f) => `${f.path}\0${f.mode.toString(8)}\0${f.hash}`);
  return { tree: sha256(lines.join('\n')), files };
}
