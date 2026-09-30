/**
 * Fakes for the parts of the domain, lib and core API (API.md) that src/targets consumes and
 * that other areas deliver: `ScopePaths` with global tokens, `renderHashOf`, `fragmentKey`,
 * `fragmentId`, `parseMergedRecord`, the 0.2 skip lists and the new `walkFiles` result.
 *
 * Every test file mocks the real modules through the `with*` factories below, which keep the
 * real export whenever it exists (so once the domain area lands, the tests run against it) and
 * fill in the fake only where it is missing. This file imports nothing that is mocked.
 */
import { createHash } from 'node:crypto';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { PalmError } from '../../src/core/errors.js';
import type { Kind, Rendered, RenderedFragment, Scope, TargetId } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// core/hash, lib/json
// ---------------------------------------------------------------------------

export function fakeSha256(data: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ---------------------------------------------------------------------------
// domain/scope-paths
// ---------------------------------------------------------------------------

const HARNESS_ENV: Partial<Record<TargetId, string>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  copilot: 'COPILOT_HOME',
  gemini: 'GEMINI_CLI_HOME',
  opencode: 'XDG_CONFIG_HOME',
};
const OVERRIDE_SUBDIR: Partial<Record<TargetId, string>> = {
  gemini: '.gemini',
  opencode: 'opencode',
};
const HARNESSES: readonly TargetId[] = [
  'claude',
  'codex',
  'copilot',
  'cursor',
  'gemini',
  'opencode',
];

function expandHomeDir(value: string | undefined, home: string): string | undefined {
  if (!value) return undefined;
  if (value === '~') return path.resolve(home);
  if (value.startsWith('~/')) return path.resolve(home, value.slice(2));
  return path.resolve(home, value);
}

export function fakeHomeOf(env: NodeJS.ProcessEnv): string {
  return path.resolve(env.HOME ?? env.USERPROFILE ?? homedir());
}

export function fakePalmHomeOf(env: NodeJS.ProcessEnv, home: string): string {
  return expandHomeDir(env.PALM_HOME, home) ?? path.join(path.resolve(home), '.palm');
}

function within(child: string, parent: string, strict = false): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return !strict;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function realOrSelf(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}

/** lib `realpathInside`: realpath of the deepest existing ancestor plus the rest; dangling links followed. */
export async function fakeRealpathInside(
  abs: string,
  roots: readonly string[],
): Promise<{ real: string; inside: boolean; dangling: boolean }> {
  let dangling = false;
  const resolve = async (p: string, hops: number): Promise<string> => {
    try {
      return await realpath(p);
    } catch {
      const st = await lstat(p).catch(() => undefined);
      if (st?.isSymbolicLink() && hops < 40) {
        dangling = true;
        const target = path.resolve(path.dirname(p), await readlink(p));
        return resolve(target, hops + 1);
      }
      const parent = path.dirname(p);
      if (parent === p) return p;
      return path.join(await resolve(parent, hops), path.basename(p));
    }
  };
  const real = await resolve(path.resolve(abs), 0);
  const realRoots = await Promise.all(roots.map(realOrSelf));
  return { real, inside: realRoots.some((r) => within(real, r, true)), dangling };
}

/** domain `ScopePaths`: project paths relative to the root; global paths as `<token>/rest`. */
export class FakeScopePaths {
  readonly root: string;
  readonly palmHome: string;

  constructor(
    readonly scope: Scope,
    root: string,
    palmHome: string,
    readonly env: NodeJS.ProcessEnv,
  ) {
    this.root = path.resolve(root);
    this.palmHome = path.resolve(palmHome);
  }

  private get home(): string {
    return this.scope === 'global' ? this.root : fakeHomeOf(this.env);
  }

  get palmDir(): string {
    return this.scope === 'project' ? path.join(this.root, '.palm') : this.palmHome;
  }

  get assetsDir(): string {
    return path.join(this.palmDir, 'assets');
  }

  assetRoot(source: { assetDir?: string; name: string }, entity: string): string {
    const segment = source.assetDir ?? source.name.replace(/^\.\//, '').replaceAll('/', '__');
    return this.lockForm(path.join(this.assetsDir, segment, entity));
  }

  private override(id: TargetId): string | undefined {
    const name = HARNESS_ENV[id];
    const dir = name ? expandHomeDir(this.env[name], this.home) : undefined;
    const sub = OVERRIDE_SUBDIR[id];
    return dir && sub ? path.join(dir, sub) : dir;
  }

  private globalHarnessHome(id: TargetId): string {
    const def = path.join(this.home, ...(id === 'opencode' ? ['.config', 'opencode'] : [`.${id}`]));
    return this.override(id) ?? def;
  }

  harnessHome(id: TargetId): string {
    if (this.scope === 'project') return path.join(this.root, `.${id}`);
    return this.globalHarnessHome(id);
  }

  token(id: TargetId | 'home' | 'palm' | 'agents'): string {
    if (id === 'home') return this.home;
    if (id === 'palm') return this.palmHome;
    if (id === 'agents') return path.join(this.home, '.agents');
    return this.globalHarnessHome(id);
  }

  private tokens(): Array<[string, string]> {
    const ids: Array<TargetId | 'home' | 'palm' | 'agents'> = [
      'home',
      'palm',
      'agents',
      ...HARNESSES,
    ];
    return ids.map((id) => [`<${id}>`, this.token(id)]);
  }

  abs(lockPath: string): string {
    if (this.scope === 'project') return path.resolve(this.root, lockPath);
    const m = /^(<[a-z]+>)(?:\/(.*))?$/.exec(lockPath);
    const dir = m ? this.tokens().find(([t]) => t === m[1])?.[1] : undefined;
    if (!m || !dir) throw new PalmError('E_PARSE', `lock path without a known token: ${lockPath}`);
    return m[2] ? path.join(dir, ...m[2].split('/')) : dir;
  }

  lockForm(abs: string): string {
    const p = path.resolve(abs);
    if (this.scope === 'project') return path.relative(this.root, p).split(path.sep).join('/');
    const best = this.tokens()
      .filter(([, dir]) => within(p, dir))
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (!best) throw new PalmError('E_IO', `${abs} is outside every global boundary`);
    const rel = path.relative(best[1], p).split(path.sep).join('/');
    return rel === '' ? best[0] : `${best[0]}/${rel}`;
  }

  boundaries(): string[] {
    if (this.scope === 'project') return [this.root];
    const overrides = HARNESSES.map((id) => this.override(id)).filter((d): d is string => !!d);
    return [this.root, this.palmHome, ...overrides];
  }

  contains(abs: string): boolean {
    return this.boundaries().some((b) => within(path.resolve(abs), b, true));
  }

  realInside(abs: string): Promise<{ real: string; inside: boolean; dangling: boolean }> {
    return fakeRealpathInside(abs, this.boundaries());
  }
}

// ---------------------------------------------------------------------------
// domain/lock, domain/merged-record
// ---------------------------------------------------------------------------

function isArrayAt(at: string): boolean {
  return /^\/hooks\/[^/]+$/.test(at) || at === '/instructions';
}

function identityOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const out: string[] = [];
  const walk = (v: unknown, key?: string): void => {
    if (typeof v === 'string' && key && ['matcher', 'command', 'bash', 'powershell'].includes(key))
      out.push(`${key}=${v}`);
    else if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
  };
  walk(value);
  return out.join('\n');
}

function unescapePointer(seg: string): string {
  return seg.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function fakeFragmentKey(at: string, value: unknown): string {
  if (at.startsWith('block:')) return at.slice('block:'.length);
  if (isArrayAt(at)) return fakeSha256(identityOf(value)).slice(0, 'sha256:'.length + 8);
  return unescapePointer(at.split('/').at(-1) ?? '');
}

export function fakeFragmentId(entry: { kind: Kind; name: string }, n: number): string {
  return `palm:${entry.kind}:${entry.name}:${n}`;
}

export function fakeRenderHashOf(rendered: Pick<Rendered, 'files' | 'fragments'>): string {
  const files = rendered.files
    .map((f) => `${f.path}\u0000${f.mode ?? ''}\u0000${fakeSha256(f.data)}`)
    .sort();
  const frags = rendered.fragments
    .map((f) => `${f.file}\u0000${f.at}\u0000${f.key}\u0000${canonicalJson(f.value)}`)
    .sort();
  return fakeSha256([...files, '', ...frags].join('\n'));
}

export function fakeParseMergedRecord(stored: RenderedFragment): unknown {
  const { file, at, id, key, value } = stored;
  if (at.startsWith('block:'))
    return { type: 'md-block', file, id, key, content: typeof value === 'string' ? value : '' };
  const segs = at.split('/').slice(1).map(unescapePointer);
  if (segs.length === 0 || at === '')
    throw new PalmError('E_INTERNAL', `fragment of ${file}: pointer names the whole file`);
  if (file.endsWith('.toml')) return { type: 'toml-table', file, path: segs, id, key, value };
  const type = isArrayAt(at) ? 'json-item' : 'json-key';
  return { type, file, path: segs, id, key, value };
}

export function fakeToLockMerged(
  rec: { file: string; id: string; key: string } & Record<string, unknown>,
) {
  const at = rec.type === 'md-block' ? `block:${rec.key}` : `/${(rec.path as string[]).join('/')}`;
  return { file: rec.file, at, id: rec.id, key: rec.key };
}

// ---------------------------------------------------------------------------
// domain/ignore
// ---------------------------------------------------------------------------

export const FAKE_PLUGIN_ROOT_TOKENS =
  /\$\{(?:CLAUDE_PLUGIN_ROOT|CURSOR_PLUGIN_ROOT|PLUGIN_ROOT|extensionPath)(?::?-[^}]*)?\}|\$CLAUDE_PLUGIN_ROOT\b/g;
export const FAKE_PROJECT_DIR_TOKENS =
  /\$\{(?:CLAUDE|CURSOR|GEMINI)_PROJECT_DIR\}|\$(?:CLAUDE|CURSOR|GEMINI)_PROJECT_DIR\b/g;
export const FAKE_CLOSURE_NEVER = [
  'SKILL.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'marketplace.json',
  'plugin.json',
  '*-plugin',
  '.git*',
  'node_modules',
];

export function fakeIsClosureExcluded(rel: string): boolean {
  return rel.split('/').some((seg) =>
    FAKE_CLOSURE_NEVER.some((p) => {
      if (p.startsWith('*')) return seg.endsWith(p.slice(1));
      if (p.endsWith('*')) return seg.startsWith(p.slice(0, -1));
      return seg === p;
    }),
  );
}

// ---------------------------------------------------------------------------
// vi.mock factories: the real export when present, the fake otherwise
// ---------------------------------------------------------------------------

type Mod = Record<string, unknown>;

export function withScopePaths(actual: Mod): Mod {
  const Real = actual.ScopePaths as { prototype?: Record<string, unknown> } | undefined;
  if (Real?.prototype && 'token' in Real.prototype) return actual;
  return { ...actual, ScopePaths: FakeScopePaths, homeOf: fakeHomeOf, palmHomeOf: fakePalmHomeOf };
}

export function withLock(actual: Mod): Mod {
  return {
    renderHashOf: fakeRenderHashOf,
    fragmentKey: fakeFragmentKey,
    fragmentId: fakeFragmentId,
    ...actual,
  };
}

export function withMergedRecord(actual: Mod): Mod {
  if ('toLockMerged' in actual) return actual;
  return { ...actual, parseMergedRecord: fakeParseMergedRecord, toLockMerged: fakeToLockMerged };
}

export function withIgnore(actual: Mod): Mod {
  if ('isClosureExcluded' in actual) return actual;
  return {
    ...actual,
    PLUGIN_ROOT_TOKENS: FAKE_PLUGIN_ROOT_TOKENS,
    PROJECT_DIR_TOKENS: FAKE_PROJECT_DIR_TOKENS,
    CLOSURE_NEVER: FAKE_CLOSURE_NEVER,
    isClosureExcluded: fakeIsClosureExcluded,
  };
}

/** lib/fs: 0.1's `walkFiles` reports `skipped`; 0.2 names the links that leave `symlinksOutside`. */
export function withFs(actual: Mod): Mod {
  const walk = actual.walkFiles as (root: string, opts: unknown) => Promise<Mod>;
  return {
    realpathInside: fakeRealpathInside,
    ...actual,
    walkFiles: async (root: string, opts: unknown) => {
      const r = await walk(root, opts);
      return 'symlinksOutside' in r ? r : { ...r, symlinksOutside: r.skipped ?? [] };
    },
  };
}

export function withHash(actual: Mod): Mod {
  return { sha256: fakeSha256, ...actual };
}
