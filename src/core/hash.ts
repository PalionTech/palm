import { createHash, type Hash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { HASH_SKIP, matchesSkip } from '../domain/ignore.js';
import { isWithin, walkFiles } from '../lib/fs.js';
import { PalmError } from './errors.js';

/** Text is a file without a NUL byte in its first 8 KB (git's heuristic). */
const TEXT_SNIFF_BYTES = 8192;

/**
 * `bytes` with CRLF line ends turned into LF when it is text, so a `core.autocrlf` checkout
 * hashes like an LF one. Binary content and lone CRs are left alone.
 */
function normalizeEol(bytes: Buffer): Buffer {
  if (!bytes.includes('\r\n') || bytes.subarray(0, TEXT_SNIFF_BYTES).includes(0)) return bytes;
  return Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
}

async function hashFile(h: Hash, abs: string): Promise<void> {
  h.update(normalizeEol(await readFile(abs)));
}

/**
 * sha256 of a file's bytes, or of a directory as the sorted list of (relative posix path + NUL +
 * content + NUL) for every regular file. Text content is hashed with LF line ends.
 *
 * The directory walk is the copy walk (lib/fs `walkFiles`): `HASH_SKIP` (= `COPY_SKIP`) is left
 * out, and a symlink is followed, and its target hashed, only when its real path stays inside
 * `opts.boundary` (default: `absPath`; the engine passes the origin root, like the copy). So a
 * content hash covers exactly the files a deploy copies. A root whose real path leaves the
 * boundary is an E_IO error.
 */
export async function hashPath(absPath: string, opts: { boundary?: string } = {}): Promise<string> {
  const real = await realpath(absPath).catch(() => undefined);
  if (real === undefined)
    throw new PalmError('E_IO', `Cannot hash ${absPath}: no such file or directory`);
  const boundary = await realpath(opts.boundary ?? absPath);
  if (!isWithin(real, boundary))
    throw new PalmError('E_IO', `Cannot hash ${absPath}: it links outside ${boundary}`);
  const h = createHash('sha256');
  if ((await stat(real)).isDirectory()) {
    const { files } = await walkFiles(absPath, {
      boundary,
      skip: (name) => matchesSkip(HASH_SKIP, name),
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

/** Deterministic JSON (sorted object keys) for hashing structured values. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}
