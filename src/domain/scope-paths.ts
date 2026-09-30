/**
 * Where a scope's files live: manifest, lock, assets, harness config dirs, the lock form of
 * every path (project-relative, or a token path under `-g`) and the boundaries palm may write
 * to and delete from (DESIGN.md sections 2 and 4). One value per (scope, root, palm home, env),
 * so every path rule is decided here instead of in each caller.
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { PalmError } from '../core/errors.js';
import type { AppliedRecord, PalmPaths, Scope, TargetId } from '../core/types.js';
import { TARGET_IDS } from '../core/types.js';
import { isWithin, type RealPathInfo, realpathInside, toPosix } from '../lib/fs.js';
import { isSafeName } from '../lib/names.js';
import type { SourceRef } from './source.js';

export const MANIFEST_FILE = 'palm.yaml';
export const LOCK_FILE = 'palm.lock.yaml';
export const LOCAL_MANIFEST_FILE = 'palm.local.yaml';
export const APPLIED_FILE = 'applied.yaml';

/** What a global lock path may start with (`<claude>/skills/x`). */
export type TokenName = TargetId | 'home' | 'palm' | 'agents';

const TOKEN_NAMES: readonly TokenName[] = ['home', 'palm', 'agents', ...TARGET_IDS];

/** The tokens of global lock paths, in this order: `<home> <palm> <agents> <claude> … <opencode>`. */
export const TOKENS: readonly string[] = TOKEN_NAMES.map((t) => `<${t}>`);

/** Environment variable relocating a harness's global config dir (Cursor has none). */
const HARNESS_HOME_ENV = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  copilot: 'COPILOT_HOME',
  // GEMINI_CLI_HOME replaces the *home* Gemini CLI resolves `.gemini` against, not the config
  // dir: `$GEMINI_CLI_HOME/.gemini` (gemini-cli packages/core/src/utils/paths.ts).
  gemini: 'GEMINI_CLI_HOME',
  // OpenCode's global config is `$XDG_CONFIG_HOME/opencode` (opencode packages/core/src/global.ts).
  opencode: 'XDG_CONFIG_HOME',
} as const satisfies Partial<Record<TargetId, string>>;

type OverridableTarget = keyof typeof HARNESS_HOME_ENV;

/** The config dir below an override's value (the value itself for claude/codex/copilot). */
const OVERRIDE_SUBDIR: Partial<Record<OverridableTarget, string>> = {
  gemini: '.gemini',
  opencode: 'opencode',
};

/** The default global config dir below the home directory, when it is not `.<id>`. */
const GLOBAL_DEFAULT: Partial<Record<TargetId, string[]>> = {
  opencode: ['.config', 'opencode'],
};

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

function badLockPath(lockPath: string, why: string): PalmError {
  return new PalmError(
    'E_PARSE',
    `palm.lock.yaml lists "${lockPath}": ${why}`,
    'restore palm.lock.yaml from git, then run palm install',
  );
}

export class ScopePaths {
  readonly root: string;
  readonly palmHome: string;
  /** The user's home directory: the root at global scope, else from `env`. */
  readonly home: string;

  /**
   * @param root project root (project scope) or home directory (global scope).
   * @param palmHome palm's home (global manifest, lock, assets, applied record, cache).
   * @param env resolves CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME / GEMINI_CLI_HOME /
   *   XDG_CONFIG_HOME for the harness homes.
   */
  constructor(
    readonly scope: Scope,
    root: string,
    palmHome: string,
    readonly env: NodeJS.ProcessEnv,
  ) {
    this.root = path.resolve(root);
    this.palmHome = path.resolve(palmHome);
    this.home = scope === 'global' ? this.root : homeOf(env);
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

  /** The directory holding the scope's manifest and lock: the project root or palm home. */
  private get base(): string {
    return this.scope === 'project' ? this.root : this.palmHome;
  }

  get manifestFile(): string {
    return path.join(this.base, MANIFEST_FILE);
  }

  get lockFile(): string {
    return path.join(this.base, LOCK_FILE);
  }

  /** 0.3: the personal overlay's manifest (`palm.local.yaml`). */
  get localManifestFile(): string {
    return path.join(this.base, LOCAL_MANIFEST_FILE);
  }

  /** 0.3: the personal overlay's lock (`.palm/local/lock.yaml`). */
  get localLockFile(): string {
    return path.join(this.palmDir, 'local', 'lock.yaml');
  }

  /** Global scope only: `<palmHome>/applied.yaml`, the lock as last applied on this machine. */
  get appliedFile(): string | undefined {
    return this.scope === 'global' ? path.join(this.palmHome, APPLIED_FILE) : undefined;
  }

  /** palm's own directory in this scope: `<project>/.palm` or palm home. */
  get palmDir(): string {
    return this.scope === 'project' ? path.join(this.root, '.palm') : this.palmHome;
  }

  /** Parent of every asset directory: `<palmDir>/assets`. */
  get assetsDir(): string {
    return path.join(this.palmDir, 'assets');
  }

  /** The advisory lock two palm processes on this scope serialise on: `<palmDir>/lock`. */
  get processLock(): string {
    return path.join(this.palmDir, 'lock');
  }

  /**
   * Lock form of an entity's asset directory: `.palm/assets/<segment>/<entity>` (project) or
   * `<palm>/assets/<segment>/<entity>` (global). An entity name that is not one safe path
   * segment is E_USAGE.
   */
  assetRoot(source: SourceRef, entity: string): string {
    if (!isSafeName(entity)) throw new PalmError('E_USAGE', `invalid entity name "${entity}"`);
    return this.lockForm(path.join(this.assetsDir, source.assetDir, entity));
  }

  /**
   * A harness's config dir: `<root>/.<id>` at project scope; at global scope the
   * CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME / `$GEMINI_CLI_HOME/.gemini` /
   * `$XDG_CONFIG_HOME/opencode` override when set, else `~/.<id>` (`~/.config/opencode`).
   */
  harnessHome(id: TargetId): string {
    if (this.scope === 'project') return path.join(this.root, `.${id}`);
    return this.globalHarnessHome(id);
  }

  private globalHarnessHome(id: TargetId): string {
    const def = path.join(this.home, ...(GLOBAL_DEFAULT[id] ?? [`.${id}`]));
    if (id === 'cursor') return def;
    return this.harnessOverride(id) ?? def;
  }

  /** The env override of a harness's global config dir, when one is set. */
  harnessOverride(id: OverridableTarget): string | undefined {
    const dir = expandHomeDir(this.env[HARNESS_HOME_ENV[id]], this.home);
    const sub = OVERRIDE_SUBDIR[id];
    return dir && sub ? path.join(dir, sub) : dir;
  }

  /** The absolute directory a token expands to (`home` → the home dir, `claude` → its home, …). */
  token(id: TokenName): string {
    if (id === 'home') return this.home;
    if (id === 'palm') return this.palmHome;
    if (id === 'agents') return path.join(this.home, '.agents');
    return this.globalHarnessHome(id);
  }

  /**
   * Lock form → absolute. Project scope: relative to the root. Global scope: the leading token
   * expanded. A token path in a project, a global path without a known token, or an absolute
   * lock path is E_PARSE.
   */
  abs(lockPath: string): string {
    if (path.isAbsolute(lockPath)) throw badLockPath(lockPath, 'a lock path is never absolute');
    const m = /^<([^>]*)>(?:\/(.*))?$/.exec(lockPath);
    if (this.scope === 'project') {
      if (m) throw badLockPath(lockPath, 'a project lock path has no token');
      return path.resolve(this.root, lockPath);
    }
    if (!m || !TOKEN_NAMES.includes(m[1] as TokenName))
      throw badLockPath(lockPath, `a global lock path starts with one of ${TOKENS.join(' ')}`);
    return path.resolve(this.token(m[1] as TokenName), m[2] ?? '');
  }

  /**
   * Absolute → lock form. Project scope: posix relative to the root. Global scope: the longest
   * matching token (on a tie the more specific one: a harness home before `<home>`). A path
   * outside the root (project) or every token (global) is E_IO.
   */
  lockForm(abs: string): string {
    const p = path.resolve(abs);
    if (this.scope === 'project') {
      if (!isWithin(p, this.root)) throw this.outside(p);
      return toPosix(path.relative(this.root, p));
    }
    let best: { name: TokenName; dir: string } | undefined;
    for (const name of TOKEN_NAMES) {
      const dir = this.token(name);
      if (isWithin(p, dir) && (!best || dir.length >= best.dir.length)) best = { name, dir };
    }
    if (!best) throw this.outside(p);
    const rel = toPosix(path.relative(best.dir, p));
    return rel ? `<${best.name}>/${rel}` : `<${best.name}>`;
  }

  private outside(p: string): PalmError {
    return new PalmError(
      'E_IO',
      `${p} is outside the ${this.scope} scope (${this.boundaries().join(', ')})`,
      this.scope === 'project'
        ? 'palm writes only inside the project'
        : 'palm writes only inside the home directory and the harness homes',
    );
  }

  /**
   * Directories this scope may write to and delete from: the project root (project), or the
   * home directory, palm home and every harness home (global), without duplicates.
   */
  boundaries(): string[] {
    if (this.scope === 'project') return [this.root];
    const homes = TARGET_IDS.map((id) => this.globalHarnessHome(id));
    return [...new Set([this.root, this.palmHome, ...homes])];
  }

  /** True when `abs` lies strictly inside one of the scope's boundaries (lexically). */
  contains(abs: string): boolean {
    const p = path.resolve(abs);
    return this.boundaries().some((b) => isWithin(p, b, { strict: true }));
  }

  /**
   * Absolute path of a lock path, or undefined when it would leave the scope's boundaries (a
   * tampered lock must never make palm delete `../victim`). Boundaries themselves never qualify.
   */
  safeAbs(lockPath: string): string | undefined {
    const abs = this.abs(lockPath);
    return this.contains(abs) ? abs : undefined;
  }

  /** Where `abs` really lands (symlinks followed, dangling ones too) and whether that is inside the scope. */
  async realInside(abs: string): Promise<RealPathInfo> {
    return realpathInside(abs, this.boundaries());
  }

  /** The directory each token expands to on this machine (applied.yaml `homes`). */
  homes(): AppliedRecord['homes'] {
    return Object.fromEntries(TOKEN_NAMES.map((t) => [t, this.token(t)]));
  }
}
