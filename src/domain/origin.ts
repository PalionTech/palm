import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { PalmError } from '../core/errors.js';
import type { OriginSpec } from '../core/types.js';
import { stableJson } from '../lib/json.js';
import { isValidAlias } from '../lib/names.js';

// ---------------------------------------------------------------------------
// String helpers shared with core/origin-input and core/config-file
// ---------------------------------------------------------------------------

/** scp-like git address `user@host:path` (groups: user, host, path). */
export const SCP_LIKE = /^([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+):(.+)$/;

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

export function stripGit(s: string): string {
  return s.replace(/\.git$/i, '');
}

/** `~` and `~/…` against the OS home directory; anything else unchanged. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** host + path segments of a git URL, scp-like address, or local path (host `file`). */
export function urlParts(url: string): { host: string; segs: string[] } {
  const scp = SCP_LIKE.exec(url);
  if (scp && !URL_SCHEME.test(url)) {
    const [, , host = '', path = ''] = scp;
    return { host: host.toLowerCase(), segs: trimSlashes(path).split('/').filter(Boolean) };
  }
  try {
    const u = new URL(url);
    if (u.protocol === 'file:')
      return { host: 'file', segs: decodeURIComponent(u.pathname).split('/').filter(Boolean) };
    return {
      host: u.hostname.toLowerCase() || u.protocol.replace(':', ''),
      segs: u.pathname.split('/').filter(Boolean).map(decodeURIComponent),
    };
  } catch {
    return { host: 'file', segs: url.split(/[\\/]+/).filter(Boolean) };
  }
}

function comparableUrl(url: string): string {
  return stripGit(url.trim().replace(/\/+$/, '')).toLowerCase();
}

function sanitizeId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

/** Ref or slot text safe as one file-name segment. */
function sanitizeRef(ref: string): string {
  return ref.replace(/[^A-Za-z0-9._-]/g, '-');
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// Alias rules (DESIGN.md §5): every stored origin carries an explicit, unique alias
// ---------------------------------------------------------------------------

/** Lowercase, runs of other characters to `-`, no leading `-._` or trailing `-` (lib/names ALIAS_RE). */
export function sanitizeAlias(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|-+$/g, '');
}

/** A problem with a stored origin's alias. Unlike other bad palm.yaml origin entries these are never skipped. */
export class OriginAliasError extends PalmError {}

function aliasFormatHint(alias: string): string {
  const suggestion = sanitizeAlias(alias);
  const example = suggestion && suggestion !== alias ? ` (e.g. \`${suggestion}\`)` : '';
  return `An alias is lowercase letters, digits, ".", "_" and "-", starting with a letter or digit${example}.`;
}

/** Throws `code` (E_PARSE as an OriginAliasError) unless `alias` is a valid alias. */
export function assertAliasFormat(
  alias: string,
  code: 'E_USAGE' | 'E_PARSE',
  where?: string,
): void {
  if (isValidAlias(alias)) return;
  const msg = `${where ? `${where}: ` : ''}invalid origin alias "${alias}"`;
  if (code === 'E_PARSE') throw new OriginAliasError(code, msg, aliasFormatHint(alias));
  throw new PalmError(code, msg, aliasFormatHint(alias));
}

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

/**
 * How well a query names an origin: 3 = its alias; 2 = exactly this origin (`owner/repo[/root]`,
 * URL or path including its root); 1 = its repository or directory but not its `root`; 0 = no match.
 */
export type MatchRank = 0 | 1 | 2 | 3;

/**
 * Where a git origin is checked out: one slot per requested ref, so pinning `x@origin#v1` never
 * moves the checkout other entities of the same origin are read from. The slot depends on the
 * origin id (url + root) and the ref, never on the alias: two aliases of one repo + root + ref
 * share it.
 */
export interface CheckoutSlot {
  /** `<cache>/<origin id>`: every slot of this origin. */
  dir: string;
  /** `repo` (no ref requested: latest) or `ref-<ref>`. */
  name: string;
  /** `<dir>/<name>`: the git work tree. */
  repoDir: string;
  /** `<dir>/checkout.json` or `<dir>/checkout-<name>.json`. */
  metaFile: string;
  /** `<dir>/<name>.lock`: advisory fetch lock (git refuses ref names ending in `.lock`). */
  lockFile: string;
}

/** One configured origin: a stored `OriginSpec` plus the rules derived from it. */
export class Origin {
  readonly spec: OriginSpec;

  constructor(spec: OriginSpec) {
    this.spec = spec;
  }

  static of(spec: OriginSpec | Origin): Origin {
    return spec instanceof Origin ? spec : new Origin(spec);
  }

  get alias(): string {
    return this.spec.alias;
  }

  get isLocal(): boolean {
    return this.spec.type === 'local';
  }

  get isGit(): boolean {
    return this.spec.type === 'git';
  }

  /**
   * Cache directory name: `<host>__<owner>__<repo>[__<root>]`, or `local__<path>[__<root>]-<hash8>`
   * (the short hash of the raw path keeps `a/b` and `a-b` apart). Independent of the alias.
   */
  get id(): string {
    const { spec } = this;
    const rootSegs = spec.root ? trimSlashes(spec.root).split('/').filter(Boolean) : [];
    if (spec.type === 'local') {
      const segs = (spec.path ?? '').split(/[\\/]+/).filter(Boolean);
      const hash = sha256Hex(`${spec.path ?? ''}\0${spec.root ?? ''}`).slice(0, 8);
      return `${['local', ...segs, ...rootSegs].map(sanitizeId).join('__')}-${hash}`;
    }
    const { host, segs } = urlParts(spec.url ?? '');
    const path = segs.map((s, i) => (i === segs.length - 1 ? stripGit(s) : s));
    return [host, ...path, ...rootSegs].map(sanitizeId).join('__');
  }

  /** The local path, or the URL plus ` (<root>)` (tables, messages). */
  describe(): string {
    const { spec } = this;
    if (spec.type === 'local') return spec.path ?? '';
    return `${spec.url ?? ''}${spec.root ? ` (${spec.root})` : ''}`;
  }

  /** Owner and repository name from the URL (git) or the last two path segments (local). */
  repoParts(): { owner?: string; repo: string } {
    if (this.spec.type === 'local') {
      const p = this.spec.path ?? '';
      const owner = basename(dirname(p));
      return { owner: owner && owner !== '/' ? owner : undefined, repo: basename(p) || 'local' };
    }
    const { segs } = urlParts(this.spec.url ?? '');
    const repo = stripGit(segs[segs.length - 1] ?? 'origin');
    const owner = segs.length >= 2 ? segs[segs.length - 2] : undefined;
    return { owner, repo };
  }

  /**
   * Same repository or directory as `other`, root/ref/layout aside: what one alias must keep
   * meaning across config.yaml and palm.yaml.
   */
  sameSource(other: Origin): boolean {
    if (this.spec.type !== other.spec.type) return false;
    if (this.isLocal) return resolve(this.spec.path ?? '') === resolve(other.spec.path ?? '');
    return comparableUrl(this.spec.url ?? '') === comparableUrl(other.spec.url ?? '');
  }

  /** See MatchRank. Aliases compare case-insensitively; paths accept `~/…`. */
  matchRank(query: string): MatchRank {
    const q = query.trim();
    if (!q) return 0;
    if (this.alias.toLowerCase() === q.toLowerCase()) return 3;
    const root = this.spec.root ? trimSlashes(this.spec.root).toLowerCase() : '';
    const ranks = [this.repoRank(q, root), this.urlRank(q, root), this.pathRank(q, root)];
    return Math.max(...ranks) as MatchRank;
  }

  /**
   * Whether `query` names this origin: its alias (any case), `owner/repo` or `owner/repo/root` of
   * a git origin's URL + root, the full URL, or the local path (absolute or `~/…`).
   */
  matches(query: string): boolean {
    return this.matchRank(query) > 0;
  }

  /**
   * `<cacheDir>/<id>[@<ref>][~<layout hash>].index.json`. Two aliases of one repository with
   * different layout descriptors (or refs) share the checkout but never an index.
   */
  indexFile(cacheDir: string, ref: string | undefined = this.spec.ref): string {
    const r = this.isGit ? ref : undefined;
    const suffix = r ? `@${sanitizeRef(r)}` : '';
    const layout = this.spec.layout
      ? `~${sha256Hex(stableJson(this.spec.layout)).slice(0, 8)}`
      : '';
    return join(cacheDir, `${this.id}${suffix}${layout}.index.json`);
  }

  /** See CheckoutSlot. */
  checkoutSlot(cacheDir: string): CheckoutSlot {
    const dir = join(cacheDir, this.id);
    const { ref } = this.spec;
    const name = ref ? `ref-${sanitizeRef(ref)}` : 'repo';
    return {
      dir,
      name,
      repoDir: join(dir, name),
      metaFile: join(dir, ref ? `checkout-${name}.json` : 'checkout.json'),
      lockFile: join(dir, `${name}.lock`),
    };
  }

  /** `owner/repo` forms of a remote git origin: the full repository path and its last two segments. */
  private repoPaths(): string[] {
    const { url } = this.spec;
    if (!this.isGit || !url) return [];
    const { host, segs } = urlParts(url);
    if (host === 'file' || segs.length < 2) return [];
    const clean = segs.map((s, i) => (i === segs.length - 1 ? stripGit(s) : s).toLowerCase());
    return [...new Set([clean.join('/'), clean.slice(-2).join('/')])];
  }

  private repoRank(q: string, root: string): 0 | 1 | 2 {
    const lower = q.replace(/\/+$/, '').toLowerCase();
    let rank: 0 | 1 | 2 = 0;
    for (const p of this.repoPaths()) {
      if (root && lower === `${p}/${root}`) return 2;
      if (lower === p) rank = root ? 1 : 2;
    }
    return rank;
  }

  private urlRank(q: string, root: string): 0 | 1 | 2 {
    const { url } = this.spec;
    if (!this.isGit || !url || comparableUrl(url) !== comparableUrl(q)) return 0;
    return root ? 1 : 2;
  }

  /** The directory a path query can name: a local origin's path or a bare repository's. */
  private localDir(): string | undefined {
    if (this.isLocal) return this.spec.path;
    const { url } = this.spec;
    return url && isAbsolute(url) ? url : undefined;
  }

  private pathRank(q: string, root: string): 0 | 1 | 2 {
    const dir = this.localDir();
    if (!dir || !(isAbsolute(q) || q === '~' || q.startsWith('~/'))) return 0;
    const abs = resolve(expandTilde(q));
    if (root && abs === resolve(dir, this.spec.root ?? '')) return 2;
    if (abs === resolve(dir)) return root ? 1 : 2;
    return 0;
  }
}
