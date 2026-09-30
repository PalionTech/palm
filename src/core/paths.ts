/** Where palm runs: the home, palm home and project root of one invocation (DESIGN.md section 2). */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homeOf, LOCK_FILE, MANIFEST_FILE, palmHomeOf, ScopePaths } from '../domain/scope-paths.js';
import { isWithin } from '../lib/fs.js';
import { type PalmPaths, TARGET_IDS } from './types.js';

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** A palm.yaml that is the global manifest reached through a symlink (a dotfiles checkout). */
function isGlobalManifest(file: string, palmHome: string): boolean {
  const global = join(palmHome, MANIFEST_FILE);
  return existsSync(global) && realOrSelf(file) === realOrSelf(global);
}

const TOKEN_LINE =
  /^\s*(?:-\s+|path:\s+|file:\s+)<(?:home|palm|agents|claude|codex|copilot|cursor|gemini|opencode)>/m;

/** A palm.lock.yaml written for the global scope: its paths are tokens (`<claude>/skills/x`). */
function isGlobalLock(dir: string): boolean {
  try {
    return TOKEN_LINE.test(readFileSync(join(dir, LOCK_FILE), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * A directory whose palm.yaml makes it a project: it has one, and that file is neither the
 * global manifest (palm home, or its real file behind a symlink) nor next to a global lock (J4).
 */
function holdsProjectManifest(dir: string, palmHome: string): boolean {
  if (dir === palmHome) return false;
  const file = join(dir, MANIFEST_FILE);
  return existsSync(file) && !isGlobalManifest(file, palmHome) && !isGlobalLock(dir);
}

/**
 * The project root for `cwd`: walking up, the first directory holding a project's palm.yaml,
 * else the first holding `.git` (discovery stops there: a palm.yaml above belongs to another
 * repository), else `cwd`. The global manifest never counts as a project's, even through a
 * symlink.
 */
function projectRootOf(cwd: string, palmHome: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (holdsProjectManifest(dir, palmHome)) return dir;
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

/** The directories of the global scope below home, with what each one is. */
function globalDirs(
  paths: PalmPaths,
  env: NodeJS.ProcessEnv,
): Array<{ dir: string; what: string }> {
  const global = new ScopePaths('global', paths.home, paths.palmHome, env);
  const out = [{ dir: paths.palmHome, what: 'palm home' }];
  const manifest = join(paths.palmHome, MANIFEST_FILE);
  if (existsSync(manifest))
    out.push({ dir: dirname(realOrSelf(manifest)), what: 'the directory of the global palm.yaml' });
  for (const id of TARGET_IDS)
    out.push({ dir: global.token(id), what: `the global ${id} directory` });
  out.push({ dir: global.token('agents'), what: 'the global skills directory' });
  return out;
}

/**
 * What global directory `dir` lies in (palm home, the real directory of the global palm.yaml,
 * a harness home such as `~/.claude`, `~/.agents`), or undefined. Project scope is refused there:
 * a project's `.claude/` inside `~/.claude` or `~/.palm` would write the global setup (J4, J5).
 */
export function globalDirHolding(
  dir: string,
  paths: PalmPaths,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const lexical = resolve(dir);
  const real = realOrSelf(dir);
  const hit = globalDirs(paths, env).find(
    (g) => isWithin(lexical, resolve(g.dir)) || isWithin(real, realOrSelf(g.dir)),
  );
  return hit?.what;
}

/**
 * Why `palm init` may not make `dir` a project, or undefined: the home directory (K14, B8,
 * C10), or a directory of the global scope (J4, J5). The fix is `-g`, which needs no init.
 */
export function initRefusal(
  dir: string,
  paths: PalmPaths,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (realOrSelf(dir) === realOrSelf(homeOf(env))) return 'the home directory is not a project';
  const what = globalDirHolding(dir, paths, env);
  return what ? `${dir} is inside ${what}, not a project` : undefined;
}

/**
 * The root of the repository `dir` is in: the nearest ancestor (or `dir`) holding `.git` (a
 * directory, or the file of a submodule or linked worktree). Undefined outside a repository.
 * A nested project's in-repo sources may lie anywhere below it (B9).
 */
export function worktreeRoot(dir: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return undefined;
  }
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
