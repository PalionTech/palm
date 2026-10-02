/**
 * Globs over the file index instead of the disk. fast-glob keeps its own matching, ignore and
 * base-directory rules; only its filesystem calls are answered from the index, so a declared glob
 * never walks a subtree the index already covers and never reaches outside the source.
 */

import fg from 'fast-glob';
import type { FileIndex } from './files.js';
import { baseOf } from './util.js';

/** Dirent and Stats stand-in for an indexed file or directory (never a symlink: links are resolved). */
class IndexEntry {
  constructor(
    readonly name: string,
    private readonly dir: boolean,
  ) {}
  isFile(): boolean {
    return !this.dir;
  }
  isDirectory(): boolean {
    return this.dir;
  }
  isSymbolicLink(): boolean {
    return false;
  }
  isBlockDevice(): boolean {
    return false;
  }
  isCharacterDevice(): boolean {
    return false;
  }
  isFIFO(): boolean {
    return false;
  }
  isSocket(): boolean {
    return false;
  }
}

type Callback<T> = (err: NodeJS.ErrnoException | null, value?: T) => void;

function enoent(p: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`ENOENT: not in the scan index, '${p}'`);
  err.code = 'ENOENT';
  return err;
}

/** Source-relative form of an absolute path fast-glob asks about; undefined outside the source. */
function relOf(index: FileIndex, abs: string): string | undefined {
  const root = index.rootAbs.replace(/\/+$/, '');
  const p = abs.replace(/\/+$/, '');
  if (p === root) return '';
  return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : undefined;
}

function statOf(index: FileIndex, abs: string): IndexEntry | undefined {
  const rel = relOf(index, abs);
  if (rel === undefined) return undefined;
  if (index.hasFile(rel)) return new IndexEntry(baseOf(rel), false);
  return index.hasDir(rel) ? new IndexEntry(baseOf(rel), true) : undefined;
}

function indexAdapter(index: FileIndex): Partial<fg.FileSystemAdapter> {
  const statCb = (p: string, cb: Callback<IndexEntry>): void => {
    const entry = statOf(index, String(p));
    process.nextTick(() => (entry ? cb(null, entry) : cb(enoent(String(p)))));
  };
  const readdir = (
    p: string,
    optsOrCb: { withFileTypes?: boolean } | Callback<unknown>,
    maybeCb?: Callback<unknown>,
  ): void => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Callback<unknown>;
    const withTypes = typeof optsOrCb === 'object' && optsOrCb?.withFileTypes === true;
    const rel = relOf(index, String(p));
    if (rel === undefined || !index.hasDir(rel)) {
      process.nextTick(() => cb(enoent(String(p))));
      return;
    }
    const [files, dirs] = index.entriesOf(rel);
    const listing = withTypes
      ? [...files.map((n) => new IndexEntry(n, false)), ...dirs.map((n) => new IndexEntry(n, true))]
      : [...files, ...dirs];
    process.nextTick(() => cb(null, listing));
  };
  return { lstat: statCb, stat: statCb, readdir } as unknown as Partial<fg.FileSystemAdapter>;
}

/** fast-glob over the indexed files and directories; results are relative to `options.cwd`. */
export function globIndex(
  index: FileIndex,
  patterns: string | string[],
  options: Omit<fg.Options, 'fs' | 'objectMode' | 'stats'>,
): Promise<string[]> {
  return fg(patterns, { ...options, fs: indexAdapter(index) });
}
