/**
 * Plugin marketplaces (Claude, Cursor, Copilot, Codex): a scan rule only (DESIGN §5 rule 3).
 * Entries with relative sources become plugin entities (rules/marketplace.ts); remote entries are
 * never fetched, only named with the `palm install` line that would declare them.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { messageOf, PalmError } from '../core/errors.js';
import { parseJson } from '../lib/json.js';
import { isRecord, withoutUndefined } from '../lib/object.js';
import { type ComponentDecls, parseComponentDecls } from './plugin-manifest.js';
import { asBool, asString, joinRel, normRel } from './util.js';

/** Marketplace file locations relative to the repo root, in precedence order. */
const MARKETPLACE_FILES = [
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
  '.github/plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
] as const;

export type MarketplaceSource =
  | { type: 'local'; path: string }
  | { type: 'github'; repo: string; path?: string; ref?: string; sha?: string }
  | { type: 'git-subdir'; url: string; path: string; ref?: string; sha?: string }
  | { type: 'url'; url: string; ref?: string; sha?: string }
  | { type: 'git'; url: string; ref?: string; sha?: string }
  | { type: 'npm'; package: string; version?: string }
  | { type: 'unknown'; raw: unknown };

export interface MarketplaceEntry {
  name: string;
  source: MarketplaceSource;
  description?: string;
  version?: string;
  /** `strict: false` → the entry is the plugin's whole definition. Default true. */
  strict: boolean;
  components: ComponentDecls;
  unsupported: string[];
  raw: Record<string, unknown>;
}

export interface Marketplace {
  name?: string;
  /** Absolute path of the marketplace file. */
  file: string;
  /** Directory relative entries resolve against (the repo root for the standard locations). */
  rootDir: string;
  entries: MarketplaceEntry[];
  warnings: string[];
}

export async function findMarketplaceFile(root: string): Promise<string | undefined> {
  for (const rel of MARKETPLACE_FILES) {
    const abs = join(root, rel);
    try {
      if ((await stat(abs)).isFile()) return abs;
    } catch {
      // try next
    }
  }
  return undefined;
}

/** The directory whose relative paths a marketplace file's entries use. */
function marketplaceRootFor(fileAbs: string): string {
  const dir = dirname(fileAbs);
  const parent = basename(dir);
  if (parent === '.claude-plugin' || parent === '.cursor-plugin' || parent === '.codex-plugin')
    return dirname(dir);
  if (parent === 'plugin' && basename(dirname(dir)) === '.github') return dirname(dirname(dir));
  if (parent === 'plugins' && basename(dirname(dir)) === '.agents') return dirname(dirname(dir));
  return dir;
}

const REMOTE_STRING = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|github:)/;

function normalizeSourceString(src: string): MarketplaceSource {
  const s = src.trim();
  if (s.startsWith('github:')) return { type: 'github', repo: s.slice('github:'.length) };
  if (REMOTE_STRING.test(s)) return { type: 'git', url: s };
  return { type: 'local', path: normRel(s) };
}

type SourceObject = Record<string, unknown>;

function githubSource(src: SourceObject): MarketplaceSource {
  const repo = asString(src.repo);
  if (!repo) return { type: 'unknown', raw: src };
  const path = asString(src.path);
  return withoutUndefined({
    type: 'github' as const,
    repo,
    path: path ? normRel(path) : undefined,
    ref: asString(src.ref),
    sha: asString(src.sha),
  });
}

function gitSubdirSource(src: SourceObject): MarketplaceSource {
  const url = asString(src.url);
  if (!url) return { type: 'unknown', raw: src };
  return withoutUndefined({
    type: 'git-subdir' as const,
    url,
    path: normRel(asString(src.path) ?? ''),
    ref: asString(src.ref),
    sha: asString(src.sha),
  });
}

function urlSource(src: SourceObject, kind: 'url' | 'git'): MarketplaceSource {
  const url = asString(src.url);
  if (!url) return { type: 'unknown', raw: src };
  // Codex writes `{source:"url", url:"./"}` for the marketplace repo itself.
  if (!REMOTE_STRING.test(url) && !/^[a-z]+:\/\//i.test(url))
    return { type: 'local', path: normRel(url) };
  return withoutUndefined({ type: kind, url, ref: asString(src.ref), sha: asString(src.sha) });
}

/** A marketplace entry's `source` (string or object, any of the four dialects), normalized. */
export function normalizeEntrySource(src: unknown): MarketplaceSource {
  if (typeof src === 'string') return normalizeSourceString(src);
  if (!isRecord(src)) return { type: 'unknown', raw: src };
  const kind = asString(src.source) ?? asString(src.type);
  switch (kind) {
    case 'github':
      return githubSource(src);
    case 'git-subdir':
      return gitSubdirSource(src);
    case 'url':
    case 'git':
      return urlSource(src, kind);
    case 'local':
    case 'relative':
    case 'path':
      return { type: 'local', path: normRel(asString(src.path) ?? asString(src.url) ?? '') };
    case 'npm': {
      const pkg = asString(src.package) ?? asString(src.name) ?? '';
      return withoutUndefined({
        type: 'npm' as const,
        package: pkg,
        version: asString(src.version),
      });
    }
    default:
      return { type: 'unknown', raw: src };
  }
}

/** `@<sha12>` when pinned to a commit, else `#<ref>`, else nothing. */
function pinSuffix(s: { ref?: string; sha?: string }): string {
  if (s.sha) return `@${s.sha.slice(0, 12)}`;
  return s.ref ? `#${s.ref}` : '';
}

const pathSuffix = (path: string | undefined): string => (path ? `/${path}` : '');

export function describeEntrySource(s: MarketplaceSource): string {
  switch (s.type) {
    case 'local':
      return s.path === '' ? './' : s.path;
    case 'github':
      return `github:${s.repo}${pathSuffix(s.path)}${pinSuffix(s)}`;
    case 'git-subdir':
      return `${s.url} (${s.path})${pinSuffix(s)}`;
    case 'url':
    case 'git':
      return `${s.url}${pinSuffix(s)}`;
    case 'npm':
      return `npm:${s.package}`;
    case 'unknown':
      return JSON.stringify(s.raw);
  }
}

function isRemoteSource(
  s: MarketplaceSource,
): s is Extract<MarketplaceSource, { type: 'github' | 'git-subdir' | 'url' | 'git' }> {
  return s.type === 'github' || s.type === 'git-subdir' || s.type === 'url' || s.type === 'git';
}

const GITHUB_URL =
  /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/;

/** `owner/repo` for a GitHub URL (the source input form), else the URL itself. */
function repoInput(url: string): { input: string; github: boolean } {
  const m = GITHUB_URL.exec(url.trim());
  return m ? { input: `${m[1]}/${m[2]}`, github: true } : { input: url.trim(), github: false };
}

/** A repository's identity for comparison: `owner/repo` of a GitHub URL, else the URL without `.git`. */
function repoKey(url: string): string {
  return repoInput(url)
    .input.replace(/\.git\/?$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * The path inside the scanned repository that a remote entry names when it names that very
 * repository (`selfUrl`), else undefined. A marketplace listing its own repository by URL is a
 * local entry, never a remote plugin to declare (ruling C21).
 */
export function selfEntryPath(
  s: MarketplaceSource,
  selfUrl: string | undefined,
): string | undefined {
  if (!selfUrl || !isRemoteSource(s)) return undefined;
  const other = s.type === 'github' ? s.repo.replace(/\.git$/, '').toLowerCase() : repoKey(s.url);
  if (other !== repoKey(selfUrl)) return undefined;
  return normRel(s.type === 'github' || s.type === 'git-subdir' ? (s.path ?? '') : '');
}

/**
 * The `palm install` input that declares a remote entry (DESIGN §5 "Input forms"): `owner/repo`,
 * `owner/repo/sub/dir` or a URL, with `#<sha or ref>`. A subdirectory of a non-GitHub repository
 * cannot be written in the input; it comes back as `root` for palm.yaml.
 */
export function installInput(s: MarketplaceSource): { input: string; root?: string } | undefined {
  if (!isRemoteSource(s)) return undefined;
  const pin = s.sha ?? s.ref;
  const suffix = pin ? `#${pin}` : '';
  if (s.type === 'github') return { input: `${s.repo}${pathSuffix(s.path)}${suffix}` };
  const repo = repoInput(s.url);
  const sub = s.type === 'git-subdir' ? s.path : '';
  if (sub === '' || repo.github) return { input: `${repo.input}${pathSuffix(sub)}${suffix}` };
  return { input: `${repo.input}${suffix}`, root: sub };
}

function parseEntry(
  p: unknown,
  i: number,
  pluginRoot: string | undefined,
): MarketplaceEntry | string {
  if (!isRecord(p)) return `marketplace entry #${i + 1} is not an object; skipped`;
  let source = normalizeEntrySource(p.source);
  if (source.type === 'local' && pluginRoot)
    source = { type: 'local', path: joinRel(pluginRoot, source.path) };
  const name =
    asString(p.name) ??
    (source.type === 'local' && source.path !== '' ? basename(source.path) : undefined);
  if (!name) return `marketplace entry #${i + 1} has no name; skipped`;
  const { decls, unsupported } = parseComponentDecls(p);
  return withoutUndefined({
    name,
    source,
    description: asString(p.description),
    version: asString(p.version),
    strict: asBool(p.strict) ?? true,
    components: decls,
    unsupported,
    raw: p,
  });
}

/** Parse marketplace JSON text into normalized entries. */
function parseMarketplaceJson(text: string, file: string): Marketplace {
  let json: unknown;
  try {
    json = parseJson(text);
  } catch (e) {
    throw new PalmError('E_PARSE', `invalid JSON in marketplace ${file}: ${messageOf(e)}`);
  }
  if (!isRecord(json) || !Array.isArray(json.plugins)) {
    throw new PalmError('E_PARSE', `${file} is not a plugin marketplace (no "plugins" array)`);
  }
  const metadata = isRecord(json.metadata) ? json.metadata : {};
  const pluginRoot = asString(metadata.pluginRoot) ?? asString(json.pluginRoot);
  const warnings: string[] = [];
  const entries: MarketplaceEntry[] = [];
  json.plugins.forEach((p, i) => {
    const entry = parseEntry(p, i, pluginRoot);
    if (typeof entry === 'string') warnings.push(entry);
    else entries.push(entry);
  });
  const rootDir = marketplaceRootFor(resolve(file));
  return withoutUndefined({ name: asString(json.name), file, rootDir, entries, warnings });
}

/** Read and parse a marketplace file (E_IO when unreadable, E_PARSE when it is not one). */
export async function readMarketplace(file: string): Promise<Marketplace> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    throw new PalmError('E_IO', `cannot read marketplace file ${file}: ${messageOf(e)}`);
  }
  return parseMarketplaceJson(text, file);
}
