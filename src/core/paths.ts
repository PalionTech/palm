import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PalmError } from './errors.js';
import type { PalmPaths, Scope } from './types.js';

export const MANIFEST_FILE = 'palm.yaml';
export const LOCK_FILE = 'palm.lock.yaml';
export const CONFIG_FILE = 'config.yaml';

/** Walk from `start` up to the filesystem root, returning the first dir for which `test` is true. */
function findUp(start: string, test: (dir: string) => boolean): string | undefined {
  let dir = start;
  for (;;) {
    if (test(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function resolvePaths(cwd: string, env: NodeJS.ProcessEnv): PalmPaths {
  const home = resolve(env.HOME ?? env.USERPROFILE ?? homedir());
  const palmHome = resolve(env.PALM_HOME ?? join(home, '.palm'));
  const absCwd = resolve(cwd);
  // palmHome holds the *global* manifest; it must never be mistaken for a project root.
  const projectRoot =
    findUp(absCwd, (d) => d !== palmHome && existsSync(join(d, MANIFEST_FILE))) ??
    findUp(absCwd, (d) => existsSync(join(d, '.git'))) ??
    absCwd;
  return { palmHome, home, projectRoot, cwd: absCwd };
}

export function scopeRoot(paths: PalmPaths, scope: Scope): string {
  return scope === 'project' ? paths.projectRoot : paths.home;
}

export function manifestPath(paths: PalmPaths, scope: Scope): string {
  return scope === 'project' ? join(paths.projectRoot, MANIFEST_FILE) : join(paths.palmHome, MANIFEST_FILE);
}

export function lockPath(paths: PalmPaths, scope: Scope): string {
  return scope === 'project' ? join(paths.projectRoot, LOCK_FILE) : join(paths.palmHome, LOCK_FILE);
}

/** Names that are safe as a single path segment (entity names become file/dir names). */
export function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

export function hooksAssetDir(paths: PalmPaths, scope: Scope, entityName: string): string {
  if (!isSafeName(entityName)) throw new PalmError('E_USAGE', `invalid entity name "${entityName}"`);
  return scope === 'project'
    ? join(paths.projectRoot, '.palm', 'hooks', entityName)
    : join(paths.palmHome, 'hooks', entityName);
}

/**
 * Directories a scope may write to and delete from: the project root (project scope), or
 * the home directory, palm home and any harness home override (global scope).
 */
export function scopeBoundaries(paths: PalmPaths, scope: Scope, env: NodeJS.ProcessEnv = {}): string[] {
  if (scope === 'project') return [resolve(paths.projectRoot)];
  const extra = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME']
    .map((k) => env[k])
    .filter((v): v is string => !!v)
    .map((v) => resolve(paths.home, v.startsWith('~/') ? v.slice(2) : v));
  return [resolve(paths.home), resolve(paths.palmHome), ...extra];
}

/**
 * Absolute path of a scope-relative (project) or absolute (global) lock path, or undefined
 * when it would leave the scope's boundaries (a tampered lockfile must never make palm
 * delete `../victim`). The boundary directories themselves are never returned.
 */
export function safeScopePath(paths: PalmPaths, scope: Scope, file: string, env: NodeJS.ProcessEnv = {}): string | undefined {
  const root = scope === 'project' ? paths.projectRoot : paths.home;
  const abs = resolve(root, file);
  const inside = scopeBoundaries(paths, scope, env).some((b) => {
    const rel = relative(b, abs);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
  return inside ? abs : undefined;
}

export function configPath(paths: PalmPaths): string {
  return join(paths.palmHome, CONFIG_FILE);
}

export function cacheDir(paths: PalmPaths): string {
  return join(paths.palmHome, 'cache');
}
