/**
 * `palm find <path>`: which lock entry wrote a file. The path may be absolute, `~/…`,
 * relative to the working directory or relative to the scope root; it matches a file an entry
 * lists, a path inside a directory an entry lists (a skill's `SKILL.md`), a config file an
 * entry merged a fragment into (`.mcp.json`, `settings.json`), or a directory holding files an
 * entry lists (`.claude/skills/tdd`, with how many).
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { PalmError } from '../core/errors.js';
import type { LockEntry, PalmContext, Scope } from '../core/types.js';
import { filePaths, Lock } from '../domain/lock.js';
import { expandHomeDir, ScopePaths } from '../domain/scope-paths.js';
import { isWithin } from '../lib/fs.js';

type FileMatch = 'file' | 'inside' | 'merged' | 'contains';

export interface FileOwner {
  scope: Scope;
  /**
   * The lock path that matched: the file, the directory holding it, the merged config file, or
   * (match `contains`) the queried directory in lock form.
   */
  file: string;
  /** How the path matched `file`. */
  match: FileMatch;
  /** JSON pointer / block id of the merged fragment (match `merged`). */
  pointer?: string;
  /** How many of the entry's files lie under the directory (match `contains`). */
  files?: number;
  entry: LockEntry;
}

/** The absolute paths `query` may mean in this scope: as given (cwd, `~`) and scope-relative. */
function candidates(ctx: PalmContext, paths: ScopePaths, query: string): string[] {
  const home = ctx.paths.home;
  if (query === '~' || query.startsWith('~/')) return [expandHomeDir(query, home) ?? query];
  if (isAbsolute(query)) return [resolve(query)];
  return [...new Set([resolve(ctx.paths.cwd, query), resolve(paths.root, query)])];
}

/**
 * `abs` in the lexical form the lock uses: a path reached through a symlinked parent
 * (macOS `/private/var` for `/var`) is mapped back under the scope root.
 */
function lexical(paths: ScopePaths, abs: string): string {
  if (isWithin(abs, paths.root) || !existsSync(paths.root)) return abs;
  const real = realpathSync(paths.root);
  return isWithin(abs, real) ? join(paths.root, relative(real, abs)) : abs;
}

/** How `entry` owns one of `wanted` (absolute paths), if it does. */
function ownership(
  paths: ScopePaths,
  entry: LockEntry,
  wanted: readonly string[],
): Omit<FileOwner, 'scope' | 'entry'> | undefined {
  for (const file of filePaths(entry)) {
    const abs = paths.abs(file);
    if (wanted.includes(abs)) return { file, match: 'file' };
    if (wanted.some((w) => isWithin(w, abs, { strict: true }))) return { file, match: 'inside' };
  }
  const merged = (entry.merged ?? []).find((m) => wanted.includes(paths.abs(m.file)));
  if (merged) return { file: merged.file, match: 'merged', pointer: merged.pointer };
  return containing(paths, entry, wanted);
}

/** A queried directory holding files of `entry`, and how many. */
function containing(
  paths: ScopePaths,
  entry: LockEntry,
  wanted: readonly string[],
): Omit<FileOwner, 'scope' | 'entry'> | undefined {
  for (const dir of wanted) {
    const n = filePaths(entry).filter((f) => isWithin(paths.abs(f), dir, { strict: true })).length;
    if (n) return { file: paths.lockForm(dir) || '.', match: 'contains', files: n };
  }
  return undefined;
}

/** Entries of one scope's lock that own `query`. */
export function ownersIn(ctx: PalmContext, scope: Scope, lock: Lock, query: string): FileOwner[] {
  const paths = ScopePaths.of(ctx, scope);
  const wanted = candidates(ctx, paths, query).map((p) => lexical(paths, p));
  return lock.entries.flatMap((entry) => {
    const hit = ownership(paths, entry, wanted);
    return hit ? [{ scope, entry, ...hit }] : [];
  });
}

/**
 * Lock entries that wrote `query`, searching each scope in `scopes` that has a lockfile.
 * E_USAGE when none of them has one (nothing palm installed to search).
 */
export async function findFileOwners(
  ctx: PalmContext,
  query: string,
  opts: { scopes: readonly Scope[] },
): Promise<{ owners: FileOwner[]; searched: Scope[] }> {
  const searched = opts.scopes.filter((s) => existsSync(ScopePaths.of(ctx, s).lockFile));
  if (!searched.length) {
    const where = opts.scopes.length === 1 && opts.scopes[0] === 'global' ? ' -g' : '';
    throw new PalmError(
      'E_USAGE',
      `no palm.lock.yaml to search (${opts.scopes.join(' or ')} scope): palm has installed nothing there`,
      `see what is installed: palm get${where}`,
    );
  }
  const owners: FileOwner[] = [];
  for (const scope of searched) {
    const lock = await Lock.load(ScopePaths.of(ctx, scope).lockFile);
    owners.push(...ownersIn(ctx, scope, lock, query));
  }
  return { owners, searched };
}
