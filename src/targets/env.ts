import os from 'node:os';
import path from 'node:path';
import type { Scope } from '../core/types.js';

export type Env = NodeJS.ProcessEnv;

const HOME_OVERRIDES = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'PALM_HOME'] as const;

/**
 * Environment used for path resolution in deploy/undeploy, which the Target contract
 * does not pass an env to. Priority: env on the call > env bound by createTarget() >
 * process.env. When falling back to process.env for a global-scope call whose
 * scopeRoot is not that environment's HOME (tests with a temp home), the directory
 * overrides (CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME, PALM_HOME) are ignored so
 * nothing is written outside scopeRoot.
 */
export function effectiveEnv(scope: Scope, scopeRoot: string, explicit?: Env, bound?: Env): Env {
  if (explicit) return explicit;
  if (bound) return bound;
  const env = process.env;
  if (scope === 'global') {
    const home = path.resolve(env.HOME ?? os.homedir());
    if (home !== path.resolve(scopeRoot)) {
      const copy: Env = { ...env };
      for (const k of HOME_OVERRIDES) delete copy[k];
      return copy;
    }
  }
  return env;
}

/** Directory from an env var (`~/x` resolved against `home`), or the fallback. */
export function envDir(env: Env, key: string, home: string, fallback: string): string {
  const v = env[key];
  if (!v) return fallback;
  if (v === '~') return home;
  if (v.startsWith('~/')) return path.join(home, v.slice(2));
  return path.resolve(home, v);
}

/** Hook asset dir: `<projectRoot>/.palm/hooks/<n>` or `<PALM_HOME|~/.palm>/hooks/<n>`. */
export function hooksAssetDir(
  scope: Scope,
  scopeRoot: string,
  env: Env,
  entityName: string,
): string {
  return path.join(palmHooksRoot(scope, scopeRoot, env).dir, entityName);
}

/** `{ dir: <...>/hooks, stop: <palm dir> }` for cleanup. */
export function palmHooksRoot(
  scope: Scope,
  scopeRoot: string,
  env: Env,
): { dir: string; stop: string } {
  const palm =
    scope === 'project'
      ? path.join(scopeRoot, '.palm')
      : envDir(env, 'PALM_HOME', scopeRoot, path.join(scopeRoot, '.palm'));
  return { dir: path.join(palm, 'hooks'), stop: palm };
}
