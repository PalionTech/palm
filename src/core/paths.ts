/** Where palm runs: the home, palm home and project root of one invocation (DESIGN.md section 2). */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homeOf, MANIFEST_FILE, palmHomeOf } from '../domain/scope-paths.js';
import { isWithin } from '../lib/fs.js';
import type { PalmPaths } from './types.js';

/**
 * The project root for `cwd`: walking up, the first directory holding palm.yaml, else the first
 * holding `.git` (discovery stops there: a palm.yaml above belongs to another repository), else
 * `cwd`. palm home holds the global manifest and never counts as a project.
 */
function projectRootOf(cwd: string, palmHome: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (dir !== palmHome && existsSync(join(dir, MANIFEST_FILE))) return dir;
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

export function resolvePaths(cwd: string, env: NodeJS.ProcessEnv): PalmPaths {
  const home = homeOf(env);
  const palmHome = palmHomeOf(env, home);
  const absCwd = resolve(cwd);
  return { palmHome, home, projectRoot: projectRootOf(absCwd, palmHome), cwd: absCwd };
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

/**
 * The directory holding a palm.yaml strictly above `cwd` and at or below `stopAt` (the root of
 * the repository `cwd` is in): `palm init` refuses to start a nested project there without
 * `--here`. Undefined when there is none.
 */
export function enclosingProject(cwd: string, stopAt: string): string | undefined {
  const stop = resolve(stopAt);
  let dir = resolve(cwd);
  if (!isWithin(dir, stop)) return undefined;
  while (dir !== stop) {
    dir = dirname(dir);
    if (existsSync(join(dir, MANIFEST_FILE))) return dir;
  }
  return undefined;
}
