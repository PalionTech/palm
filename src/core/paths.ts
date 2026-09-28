import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homeOf, MANIFEST_FILE, palmHomeOf, ScopePaths } from '../domain/scope-paths.js';
import type { PalmPaths, Scope } from './types.js';

const CONFIG_FILE = 'config.yaml';

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
  const home = homeOf(env);
  const palmHome = palmHomeOf(env, home);
  const absCwd = resolve(cwd);
  // palmHome holds the *global* manifest; it must never be mistaken for a project root.
  const projectRoot =
    findUp(absCwd, (d) => d !== palmHome && existsSync(join(d, MANIFEST_FILE))) ??
    findUp(absCwd, (d) => existsSync(join(d, '.git'))) ??
    absCwd;
  return { palmHome, home, projectRoot, cwd: absCwd };
}

/**
 * True when the project scope would be the home directory itself without the user having made it
 * a palm project: `paths.projectRoot` is the home of `env` and there is no palm.yaml there. A
 * `.git` in home (a dotfiles repository) does not count as a marker, since project-scope files
 * would then land in the harnesses' global dirs. Commands refuse project scope in this case
 * ("run inside a project or use -g").
 */
export function isHomeAsProject(paths: PalmPaths, env: NodeJS.ProcessEnv): boolean {
  const home = homeOf(env);
  return resolve(paths.projectRoot) === home && !existsSync(join(home, MANIFEST_FILE));
}

// Facades over ScopePaths, kept while the remaining callers move to `ScopePaths.of(ctx, scope)`.

export function scopeRoot(paths: PalmPaths, scope: Scope): string {
  return ScopePaths.from(paths, scope, {}).root;
}

export function manifestPath(paths: PalmPaths, scope: Scope): string {
  return ScopePaths.from(paths, scope, {}).manifestFile;
}

export function lockPath(paths: PalmPaths, scope: Scope): string {
  return ScopePaths.from(paths, scope, {}).lockFile;
}

export function hooksAssetDir(paths: PalmPaths, scope: Scope, entityName: string): string {
  return ScopePaths.from(paths, scope, {}).hooksAssetDir(entityName);
}

export function configPath(paths: PalmPaths): string {
  return join(paths.palmHome, CONFIG_FILE);
}

export function cacheDir(paths: PalmPaths): string {
  return join(paths.palmHome, 'cache');
}
