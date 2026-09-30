/**
 * Files palm's own lock owns inside a source (ruling R18'): a source that is the project itself
 * (`.`), or a folder of it, holds the files palm wrote there (`.mcp.json`, `opencode.json`,
 * `AGENTS.md` blocks, …). A suggested layout never names one of them, so following a note can
 * never make palm read its own output.
 */

import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { Lock } from '../domain/lock.js';
import { LOCK_FILE } from '../domain/scope-paths.js';
import { toPosix } from '../lib/fs.js';

/** The closest directory at or above `root` holding palm.lock.yaml, stopping at a worktree top. */
function lockDirOf(root: string): string | undefined {
  let dir = root;
  for (;;) {
    if (existsSync(join(dir, LOCK_FILE))) return dir;
    const parent = dirname(dir);
    if (existsSync(join(dir, '.git')) || parent === dir) return undefined;
    dir = parent;
  }
}

/** Source-relative paths of the files the lock above `root` lists (whole files and merge targets). */
export async function lockOwnedPaths(root: string): Promise<Set<string>> {
  const dir = lockDirOf(root);
  if (dir === undefined) return new Set();
  const lock = await Lock.load(join(dir, LOCK_FILE)).catch(() => new Lock());
  const prefix = toPosix(relative(dir, root));
  const owned = new Set<string>();
  for (const e of lock.entries) {
    for (const p of [...e.files, ...(e.merged ?? []).map((m) => m.file)]) {
      if (prefix === '') owned.add(p);
      else if (p.startsWith(`${prefix}/`)) owned.add(p.slice(prefix.length + 1));
    }
  }
  return owned;
}
