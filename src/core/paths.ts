import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

export function hooksAssetDir(paths: PalmPaths, scope: Scope, entityName: string): string {
  return scope === 'project'
    ? join(paths.projectRoot, '.palm', 'hooks', entityName)
    : join(paths.palmHome, 'hooks', entityName);
}

export function configPath(paths: PalmPaths): string {
  return join(paths.palmHome, CONFIG_FILE);
}

export function cacheDir(paths: PalmPaths): string {
  return join(paths.palmHome, 'cache');
}
