/**
 * Sources: where entities come from, declared under `sources:` in the manifest of a scope
 * (DESIGN.md sections 3 and 5). `normalizeSource` turns a manifest key and body into a
 * `Source`, `SourceRef` derives identity and naming, `SourceSet` holds a scope's sources with
 * unique names and aliases.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PalmError } from '../core/errors.js';
import type {
  LayoutDescriptor,
  Manifest as ManifestData,
  ManifestSource,
  Source,
} from '../core/types.js';
import { sha256, short } from '../lib/digest.js';
import { toPosix } from '../lib/fs.js';
import { canonicalJson } from '../lib/json.js';
import { isValidAlias, sanitizeSourceDir } from '../lib/names.js';
import { isRecord } from '../lib/object.js';
import {
  comparableUrl,
  expandTilde,
  GITHUB_REPO,
  githubRepoOf,
  githubUrl,
  stripGit,
  trimSlashes,
  urlParts,
  validateSourceUrl,
} from './source-url.js';

/**
 * How a manifest key names its source: `github` (`owner/repo`, a GitHub repository unless the
 * body has `url:` or `path:`), `local` (`./dir`, `../dir`, `/dir`) or `named` (a chosen name,
 * which needs `url:` or `path:`).
 */
export function sourceNameKind(key: string): 'github' | 'local' | 'named' {
  if (key === '.' || key === '..') return 'local';
  if (key.startsWith('./') || key.startsWith('../') || key.startsWith('/')) return 'local';
  return GITHUB_REPO.test(key) || GITHUB_SUBDIR.test(key) ? 'github' : 'named';
}

/** `owner/repo/sub/dir`: a GitHub repository and the subdirectory that is the source root (ruling 20). */
const GITHUB_SUBDIR = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;

/** `owner/repo` and the root (`sub/dir`, or undefined) a GitHub source key names. */
function githubParts(key: string): { repo: string; root?: string } {
  const [owner, repo, ...rest] = key.split('/');
  return rest.length ? { repo: `${owner}/${repo}`, root: rest.join('/') } : { repo: key };
}

function badSource(where: string, name: string, why: string, hint?: string): PalmError {
  return new PalmError('E_PARSE', `${where}: source "${name}" ${why}`, hint);
}

/** The optional fields every source may carry, checked. */
function commonFields(name: string, raw: ManifestSource, where: string): Partial<Source> {
  const out: Partial<Source> = {};
  if (raw.alias !== undefined) {
    if (typeof raw.alias !== 'string' || !isValidAlias(raw.alias))
      throw badSource(
        where,
        name,
        `has an invalid alias "${String(raw.alias)}"`,
        'an alias is lowercase letters, digits, ".", "_" and "-", for example kit',
      );
    out.alias = raw.alias;
  }
  if (raw.ref !== undefined) {
    if (typeof raw.ref !== 'string' || !raw.ref || raw.ref.startsWith('-'))
      throw badSource(
        where,
        name,
        `has an invalid ref "${String(raw.ref)}"`,
        'a ref is a tag, branch, sha or range such as ^1.2',
      );
    out.ref = raw.ref;
  }
  if (raw.root !== undefined) out.root = checkedRoot(name, raw.root, where);
  if (raw.layout !== undefined) {
    if (!isRecord(raw.layout)) throw badSource(where, name, 'has a layout that is not a mapping');
    out.layout = raw.layout as LayoutDescriptor;
  }
  return out;
}

function checkedRoot(name: string, root: unknown, where: string): string | undefined {
  if (typeof root !== 'string' || isAbsolute(root) || root.split(/[\\/]+/).includes('..'))
    throw badSource(
      where,
      name,
      `has an invalid root "${String(root)}"`,
      'root is a directory inside the repository, for example plugins/kit',
    );
  return trimSlashes(root) || undefined;
}

function localSource(name: string, raw: ManifestSource, baseDir: string, where: string): Source {
  const p = raw.path ?? name;
  if (typeof p !== 'string' || !p) throw badSource(where, name, 'has an invalid path');
  if (raw.ref !== undefined)
    throw badSource(
      where,
      name,
      'is a directory, and a directory has no refs',
      `use file://${resolve(baseDir, expandTilde(p))} as url: for a tagged checkout`,
    );
  return { name, type: 'local', path: resolve(baseDir, expandTilde(p)) };
}

function gitSource(name: string, raw: ManifestSource, where: string): Source {
  if (typeof raw.url === 'string') {
    validateSourceUrl(raw.url, `${where}: source "${name}"`);
    return { name, type: 'git', url: raw.url };
  }
  if (raw.url !== undefined) throw badSource(where, name, 'has a url that is not a string');
  if (sourceNameKind(name) === 'github') {
    const { repo, root } = githubParts(name);
    return { name, type: 'git', url: githubUrl(repo), ...(root ? { root } : {}) };
  }
  throw badSource(
    where,
    name,
    'needs url: or path:',
    `add url: under sources."${name}" in palm.yaml`,
  );
}

/**
 * A manifest key and body as a `Source`. A local path becomes absolute (resolved against
 * `baseDir`, `~` expanded); a URL passes `validateSourceUrl` (E_SOURCE); `owner/repo` without
 * `url:`/`path:` is GitHub. A bad body, alias, ref, root or layout is E_PARSE naming `where`.
 */
export function normalizeSource(
  name: string,
  raw: ManifestSource,
  baseDir: string,
  where: string,
): Source {
  const body: ManifestSource = raw ?? {};
  if (!isRecord(body)) throw badSource(where, name, 'must be a mapping');
  if (body.url !== undefined && body.path !== undefined)
    throw badSource(where, name, 'has both url: and path:', 'keep one of them');
  const local =
    body.path !== undefined || (sourceNameKind(name) === 'local' && body.url === undefined);
  const base = local ? localSource(name, body, baseDir, where) : gitSource(name, body, where);
  return { ...base, ...commonFields(name, body, where) };
}

/** `./rel` (or `../rel`) of `abs` from `baseDir`, posix. */
function relativePath(baseDir: string, abs: string): string {
  const rel = toPosix(relative(baseDir, abs));
  if (rel === '') return '.';
  return rel.startsWith('../') || rel === '..' ? rel : `./${rel}`;
}

/**
 * The manifest body of `source` minus its entries, keys in a fixed order. `url` is left out when
 * the name is the GitHub shorthand of it; a local `path` is written relative to `baseDir` and
 * left out when the name is that path.
 */
export function toManifestSource(
  source: Source,
  baseDir: string,
): Pick<ManifestSource, 'url' | 'path' | 'root' | 'ref' | 'alias' | 'layout'> {
  const out: Pick<ManifestSource, 'url' | 'path' | 'root' | 'ref' | 'alias' | 'layout'> = {};
  const implied = impliedByKey(source);
  if (source.type === 'git' && source.url && !implied.url) out.url = source.url;
  if (source.type === 'local' && source.path) {
    const rel = relativePath(baseDir, source.path);
    if (rel !== source.name) out.path = rel;
  }
  if (source.root && !implied.root) out.root = source.root;
  if (source.ref) out.ref = source.ref;
  if (source.alias) out.alias = source.alias;
  if (source.layout) out.layout = source.layout;
  return out;
}

/** Whether the GitHub shorthand key already says the url (and, for `owner/repo/sub/dir`, the root). */
function impliedByKey(source: Source): { url: boolean; root: boolean } {
  if (source.type !== 'git' || !source.url || sourceNameKind(source.name) !== 'github')
    return { url: false, root: false };
  const { repo, root } = githubParts(source.name);
  const url = githubRepoOf(source.url)?.toLowerCase() === repo.toLowerCase();
  const sameRoot = (root ?? '') === (source.root ?? '');
  return { url: url && sameRoot, root: url && sameRoot && root !== undefined };
}

function sanitizeId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

function realPathOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * How well a query names a source: 3 = its name or alias; 2 = exactly this source
 * (`owner/repo[/root]`, URL or path including its root); 1 = its repository or directory but
 * not its root; 0 = no match.
 */
export type MatchRank = 0 | 1 | 2 | 3;

/** One declared source with the facts derived from it. */
export class SourceRef {
  constructor(readonly source: Source) {}

  static of(s: Source | SourceRef): SourceRef {
    return s instanceof SourceRef ? s : new SourceRef(s);
  }

  get name(): string {
    return this.source.name;
  }

  get alias(): string | undefined {
    return this.source.alias;
  }

  get isLocal(): boolean {
    return this.source.type === 'local';
  }

  get isGit(): boolean {
    return this.source.type === 'git';
  }

  private get rootSegs(): string[] {
    return this.source.root ? trimSlashes(this.source.root).split('/').filter(Boolean) : [];
  }

  /**
   * Cache directory name: `<host>__<owner>__<repo>[__<root>]`, or
   * `local__<basename>[__<root>]-<hash8>` (hash of the real path and root). Never the name, so
   * renaming a source keeps its cache.
   */
  get id(): string {
    const { source } = this;
    if (source.type === 'local') {
      const real = realPathOf(source.path ?? '.');
      const hash = short(sha256(`${real}\0${source.root ?? ''}`));
      return `${['local', basename(real) || 'root', ...this.rootSegs].map(sanitizeId).join('__')}-${hash}`;
    }
    const { host, segs } = urlParts(source.url ?? '');
    const path = segs.map((s, i) => (i === segs.length - 1 ? stripGit(s) : s));
    return [host, ...path, ...this.rootSegs].map(sanitizeId).join('__');
  }

  /** The `.palm/assets/<segment>` directory segment (`owner/repo` → `owner__repo`). */
  get assetDir(): string {
    return sanitizeSourceDir(this.name);
  }

  /** The local path, or the URL plus ` (<root>)` (tables, messages). */
  describe(): string {
    const { source } = this;
    const where = source.type === 'local' ? (source.path ?? '') : (source.url ?? '');
    return `${where}${source.root ? ` (${source.root})` : ''}`;
  }

  /** Owner and repository name from the URL (git) or the last two path segments (local). */
  repoParts(): { owner?: string; repo: string } {
    if (this.isLocal) {
      const p = this.source.path ?? '';
      const owner = basename(dirname(p));
      return { owner: owner && owner !== '/' ? owner : undefined, repo: basename(p) || 'local' };
    }
    const { segs } = urlParts(this.source.url ?? '');
    const repo = stripGit(segs[segs.length - 1] ?? 'source');
    const owner = segs.length >= 2 ? segs[segs.length - 2] : undefined;
    return { owner, repo };
  }

  /** Same repository (URL case, `.git` and trailing slash aside) or same directory, and same root. */
  sameLocation(other: SourceRef): boolean {
    if (this.source.type !== other.source.type) return false;
    if (trimSlashes(this.source.root ?? '') !== trimSlashes(other.source.root ?? '')) return false;
    if (this.isLocal)
      return realPathOf(this.source.path ?? '') === realPathOf(other.source.path ?? '');
    return comparableUrl(this.source.url ?? '') === comparableUrl(other.source.url ?? '');
  }

  /** See MatchRank. Names and aliases compare case-insensitively; paths accept `~/…`. */
  matchRank(query: string): MatchRank {
    const q = query.trim();
    if (!q) return 0;
    const lower = q.toLowerCase();
    if (this.name.toLowerCase() === lower || this.alias?.toLowerCase() === lower) return 3;
    const root = this.rootSegs.join('/').toLowerCase();
    return Math.max(
      this.repoRank(q, root),
      this.urlRank(q, root),
      this.pathRank(q, root),
    ) as MatchRank;
  }

  /** Whether `query` names this source: name or alias, `owner/repo[/root]`, the URL or the path. */
  matches(query: string): boolean {
    return this.matchRank(query) > 0;
  }

  /**
   * `<cacheDir>/<id>@<version8>[~<layout hash8>].index.json`, where `version` is the sha (git) or
   * the tree hash (local). Two names for one location share the file; another layout never does.
   */
  indexFile(cacheDir: string, version: string): string {
    const layout = this.source.layout ? `~${short(sha256(canonicalJson(this.source.layout)))}` : '';
    return join(cacheDir, `${this.id}@${short(version)}${layout}.index.json`);
  }

  /** `<cacheDir>/<id>/sha-<sha>`: the checkout of one commit, fetched once. */
  checkoutDir(cacheDir: string, sha: string): string {
    return join(cacheDir, this.id, `sha-${sha}`);
  }

  /** `owner/repo` forms of a remote git source: the full repository path and its last two segments. */
  private repoPaths(): string[] {
    const { url } = this.source;
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
    const { url } = this.source;
    if (!this.isGit || !url || comparableUrl(url) !== comparableUrl(q)) return 0;
    return root ? 1 : 2;
  }

  /** The directory a path query can name: a local source's path or a bare repository's. */
  private localDir(): string | undefined {
    if (this.isLocal) return this.source.path;
    const { url } = this.source;
    return url && isAbsolute(url) ? url : undefined;
  }

  private pathRank(q: string, root: string): 0 | 1 | 2 {
    const dir = this.localDir();
    if (!dir || !(isAbsolute(q) || q === '~' || q.startsWith('~/'))) return 0;
    const abs = resolve(expandTilde(q));
    if (root && abs === resolve(dir, root)) return 2;
    if (abs === resolve(dir)) return root ? 1 : 2;
    return 0;
  }
}

/** Lower-cased names and aliases of `ref`. */
function handles(ref: SourceRef): string[] {
  return [ref.name, ...(ref.alias ? [ref.alias] : [])].map((h) => h.toLowerCase());
}

/** The first pair of sources sharing a name or alias (any case), with the shared word. */
function firstClash(
  list: readonly SourceRef[],
): { a: SourceRef; b: SourceRef; word: string } | undefined {
  const seen = new Map<string, SourceRef>();
  for (const ref of list) {
    for (const h of new Set(handles(ref))) {
      const other = seen.get(h);
      if (other) return { a: other, b: ref, word: h };
      seen.set(h, ref);
    }
  }
  return undefined;
}

/**
 * The sources of one scope. Names and aliases are unique, case-insensitively. Immutable: `add`
 * and `without` return a new set.
 */
export class SourceSet {
  private constructor(private readonly list: readonly SourceRef[]) {}

  /** A set of `sources`; two sharing a name or alias is E_PARSE. */
  static of(sources: Iterable<Source | SourceRef> = [], where = 'palm.yaml'): SourceSet {
    const list = [...sources].map(SourceRef.of);
    const clash = firstClash(list);
    if (clash) {
      throw new PalmError(
        'E_PARSE',
        `${where}: sources "${clash.a.name}" and "${clash.b.name}" both answer to "${clash.word}"`,
        'names and aliases of sources are unique in any case; rename one of them in palm.yaml',
      );
    }
    return new SourceSet(list);
  }

  /** The sources of a manifest (`sources:`), local paths resolved against `baseDir`. */
  static fromManifest(m: { toJSON(): ManifestData }, baseDir: string, where: string): SourceSet {
    const sources = m.toJSON().sources ?? {};
    const list = Object.entries(sources).map(([name, raw]) =>
      normalizeSource(name, raw, baseDir, where),
    );
    return SourceSet.of(list, where);
  }

  get size(): number {
    return this.list.length;
  }

  all(): SourceRef[] {
    return [...this.list];
  }

  names(): string[] {
    return this.list.map((s) => s.name);
  }

  /** The source whose name or alias is `nameOrAlias` (any case). */
  byName(nameOrAlias: string): SourceRef | undefined {
    const key = nameOrAlias.toLowerCase();
    return this.list.find((s) => handles(s).includes(key));
  }

  /**
   * The one source `query` names (SourceRef.matchRank): a name or alias wins over everything
   * else, and a query naming a source exactly (root included) over one naming only its
   * repository. E_NOT_FOUND listing the names, or E_AMBIGUOUS.
   */
  resolveQuery(query: string): SourceRef {
    const ranked = this.list
      .map((s) => ({ s, rank: s.matchRank(query) }))
      .filter((r) => r.rank > 0);
    const top = Math.max(0, ...ranked.map((r) => r.rank));
    const best = ranked.filter((r) => r.rank === top).map((r) => r.s);
    const [first] = best;
    if (first && best.length === 1) return first;
    if (!first) throw this.notFound(query);
    throw new PalmError(
      'E_AMBIGUOUS',
      `"${query}" matches ${best.length} sources: ${best.map((s) => `${s.name} (${s.describe()})`).join(', ')}`,
      `name one of them, for example palm get -s ${first.name}`,
    );
  }

  /**
   * `source` added. The source with the same name and location is replaced in place (another
   * ref, alias or layout); another source that already uses the name or an alias is E_CONFLICT.
   * Two names may share a location (per-entry pins, Z2); a rename is `without(old)` then
   * `add(renamed)`.
   */
  add(source: Source): SourceSet {
    const next = new SourceRef(source);
    const at = this.list.findIndex(
      (s) => s.name.toLowerCase() === source.name.toLowerCase() && s.sameLocation(next),
    );
    const rest = this.list.filter((_, i) => i !== at);
    const taken = rest.find((s) => handles(s).some((h) => handles(next).includes(h)));
    if (taken) {
      throw new PalmError(
        'E_CONFLICT',
        `source name "${source.name}" is already used by ${taken.name} (${taken.describe()})`,
        `choose another name: palm install ${next.describe()} --as ${source.name}-2`,
      );
    }
    return new SourceSet(at >= 0 ? this.list.with(at, next) : [...this.list, next]);
  }

  /** This set without the source named (or aliased) `name`, any case. */
  without(name: string): SourceSet {
    const key = name.toLowerCase();
    return new SourceSet(this.list.filter((s) => !handles(s).includes(key)));
  }

  private notFound(query: string): PalmError {
    const names = this.names().sort();
    return new PalmError(
      'E_NOT_FOUND',
      names.length
        ? `no source matches "${query}"; declared: ${names.join(', ')}`
        : `no source matches "${query}"; palm.yaml declares none`,
      names.length
        ? 'palm get sources'
        : `palm install ${query.includes('/') ? query : 'owner/repo'}`,
    );
  }
}
