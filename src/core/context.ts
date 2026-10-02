/**
 * The context of one command: where it runs, how it talks to the user, and its flags. Nothing is
 * read to build it; scopes open their manifest and lock when a command needs them.
 */
import { ScopePaths } from '../domain/scope-paths.js';
import { setGitRunner } from '../lib/git-query.js';
import { runGit } from './git-exec.js';
import { withLock } from './lock-file.js';
import { resolvePaths } from './paths.js';
import type { Logger, PalmContext, PalmFlags, Scope, UI } from './types.js';

export interface ContextInit {
  cwd: string;
  env: NodeJS.ProcessEnv;
  ui: UI;
  log: Logger;
  flags: PalmFlags;
}

/** The read-only git questions of lib/git-query (ignored, tracked, toplevel) go through the hardened runner. */
function installGitRunner(): void {
  setGitRunner((args, cwd) => runGit(args, { cwd }));
}

/** The context for one command. Reads nothing and writes nothing. */
export async function createContext(init: ContextInit): Promise<PalmContext> {
  installGitRunner();
  return {
    paths: resolvePaths(init.cwd, init.env),
    ui: init.ui,
    log: init.log,
    env: init.env,
    flags: { ...init.flags },
  };
}

/** The paths of `scope` for this context. */
export function scopedPaths(ctx: PalmContext, scope: Scope): ScopePaths {
  return ScopePaths.of(ctx, scope);
}

/**
 * Runs `fn` holding the scope's advisory lock (`<project>/.palm/local/lock` or `$PALM_HOME/lock`,
 * DESIGN.md section 2), so two palm processes on one scope take turns. Dry runs and read-only
 * commands do not call it. The lock's directory stays when the run ends: another palm may be
 * creating its lock in it at that moment, and removing it under that process fails its run (B1).
 */
export async function withScopeLock<T>(paths: ScopePaths, fn: () => Promise<T>): Promise<T> {
  return withLock(paths.processLock, fn);
}
