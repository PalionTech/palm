/**
 * Where a scope's files live: manifest, lock, hook assets, harness config dirs, and the
 * boundaries palm may write to and delete from. One value per (scope, root, palm home, env),
 * so every path rule is decided here instead of in each caller.
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { PalmError } from '../core/errors.js';
import type { PalmPaths, Scope, TargetId } from '../core/types.js';
import { isWithin, toPosix } from '../lib/fs.js';
import { isSafeName } from '../lib/names.js';

export const MANIFEST_FILE = 'palm.yaml';
export const LOCK_FILE = 'palm.lock.yaml';

/** Environment variable relocating a harness's global config dir (Cursor has none). */
const HARNESS_HOME_ENV = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  copilot: 'COPILOT_HOME',
} as const satisfies Partial<Record<TargetId, string>>;

/**
 * A directory from an environment value: `~` and `~/x` expand against `home`, anything
 * else resolves against `home`. Undefined when the value is unset or empty.
 */
export function expandHomeDir(value: string | undefined, home: string): string | undefined {
  if (!value) return undefined;
  if (value === '~') return path.resolve(home);
  if (value.startsWith('~/')) return path.resolve(home, value.slice(2));
  return path.resolve(home, value);
}

/** The user's home directory from `env` (HOME, then USERPROFILE), else the OS home. */
export function homeOf(env: NodeJS.ProcessEnv): string {
  return path.resolve(env.HOME ?? env.USERPROFILE ?? homedir());
}

/** palm's own home: `$PALM_HOME` (home-relative, `~` expanded) or `<home>/.palm`. */
export function palmHomeOf(env: NodeJS.ProcessEnv, home: string): string {
  return expandHomeDir(env.PALM_HOME, home) ?? path.join(path.resolve(home), '.palm');
}

export class ScopePaths {
  readonly root: string;
  readonly palmHome: string;

  /**
   * @param root project root (project scope) or home directory (global scope); lock paths
   *   are relative to it at project scope.
   * @param palmHome palm's home (global manifest, lock and hook assets).
   * @param env resolves CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME.
   */
  constructor(
    readonly scope: Scope,
    root: string,
    palmHome: string,
    readonly env: NodeJS.ProcessEnv,
  ) {
    this.root = path.resolve(root);
    this.palmHome = path.resolve(palmHome);
  }

  static from(paths: PalmPaths, scope: Scope, env: NodeJS.ProcessEnv): ScopePaths {
    const root = scope === 'project' ? paths.projectRoot : paths.home;
    return new ScopePaths(scope, root, paths.palmHome, env);
  }

  static of(ctx: { paths: PalmPaths; env: NodeJS.ProcessEnv }, scope: Scope): ScopePaths {
    return ScopePaths.from(ctx.paths, scope, ctx.env);
  }

  /**
   * Paths for a target call that only knows `(scope, scopeRoot, env)`: at global scope the
   * root is the home directory, so PALM_HOME resolves against it.
   */
  static at(scope: Scope, root: string, env: NodeJS.ProcessEnv): ScopePaths {
    const home = scope === 'global' ? root : homeOf(env);
    return new ScopePaths(scope, root, palmHomeOf(env, home), env);
  }

  get manifestFile(): string {
    return path.join(this.scope === 'project' ? this.root : this.palmHome, MANIFEST_FILE);
  }

  get lockFile(): string {
    return path.join(this.scope === 'project' ? this.root : this.palmHome, LOCK_FILE);
  }

  /** palm's own directory in this scope: `<project>/.palm` or palm home. */
  get palmDir(): string {
    return this.scope === 'project' ? path.join(this.root, '.palm') : this.palmHome;
  }

  /** Parent of every hook asset dir. */
  get hooksDir(): string {
    return path.join(this.palmDir, 'hooks');
  }

  /** Where a hook entity's scripts are copied; refuses names that could leave `hooksDir`. */
  hooksAssetDir(name: string): string {
    if (!isSafeName(name)) throw new PalmError('E_USAGE', `invalid entity name "${name}"`);
    return path.join(this.hooksDir, name);
  }

  /**
   * A harness's config dir: `<root>/.<id>` at project scope; at global scope the
   * CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME override when set, else `~/.<id>`.
   */
  harnessHome(id: TargetId): string {
    const def = path.join(this.root, `.${id}`);
    if (this.scope === 'project' || id === 'cursor') return def;
    return this.harnessOverride(id) ?? def;
  }

  /** The env override of a harness's global config dir, when one is set. */
  harnessOverride(id: Exclude<TargetId, 'cursor'>): string | undefined {
    return expandHomeDir(this.env[HARNESS_HOME_ENV[id]], this.root);
  }

  /** Absolute form of a lock path (scope-relative at project scope, absolute at global). */
  abs(lockPath: string): string {
    return path.resolve(this.root, lockPath);
  }

  /** Lock form of an absolute path: posix scope-relative (project) or absolute (global). */
  lockForm(abs: string): string {
    return this.scope === 'project' ? toPosix(path.relative(this.root, abs)) : abs;
  }

  /**
   * Directories this scope may write to and delete from: the project root (project), or
   * the home directory, palm home and each harness home override (global).
   */
  boundaries(): string[] {
    if (this.scope === 'project') return [this.root];
    const overrides = (Object.keys(HARNESS_HOME_ENV) as Array<keyof typeof HARNESS_HOME_ENV>)
      .map((id) => this.harnessOverride(id))
      .filter((d): d is string => d !== undefined);
    return [this.root, this.palmHome, ...overrides];
  }

  /** True when `abs` lies strictly inside one of the scope's boundaries. */
  contains(abs: string): boolean {
    const p = path.resolve(abs);
    return this.boundaries().some((b) => isWithin(p, b, { strict: true }));
  }

  /**
   * Absolute path of a lock path, or undefined when it would leave the scope's boundaries
   * (a tampered lockfile must never make palm delete `../victim`). Boundaries themselves
   * are never returned.
   */
  safeAbs(lockPath: string): string | undefined {
    const abs = this.abs(lockPath);
    return this.contains(abs) ? abs : undefined;
  }
}
