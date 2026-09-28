/**
 * Plugin marketplaces (Claude, Cursor, Copilot, Codex). Used two ways:
 *  - during a scan, relative entries become plugin entities (see rules/marketplace.ts);
 *  - `palm install origin <marketplace.json>` expands a marketplace into one OriginSpec per entry
 *    (parseMarketplace).
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { messageOf, PalmError } from '../core/errors.js';
import type { OriginSpec } from '../core/types.js';
import { parseJson } from '../lib/json.js';
import { slugify } from '../lib/names.js';
import { isRecord, withoutUndefined } from '../lib/object.js';
import { type ComponentDecls, parseComponentDecls } from './plugin-manifest.js';
import { asBool, asString, joinRel, normRel, toSlug } from './util.js';

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
  /** Absolute path (or URL) of the marketplace file. */
  file: string;
  /** Directory relative entries resolve against (the repo root for the standard locations). */
  rootDir?: string;
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
export function marketplaceRootFor(fileAbs: string): string {
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

export function normalizeSource(src: unknown): MarketplaceSource {
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

const refSuffix = (ref: string | undefined): string => (ref ? `#${ref}` : '');
const pathSuffix = (path: string | undefined): string => (path ? `/${path}` : '');

export function describeSource(s: MarketplaceSource): string {
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

/** The `palm install origin` arguments that would fetch this remote source. */
export function originHint(s: MarketplaceSource): string | undefined {
  switch (s.type) {
    case 'github':
      return `${s.repo}${pathSuffix(s.path)}${refSuffix(s.ref)}`;
    case 'url':
    case 'git':
      return `${s.url}${refSuffix(s.ref)}`;
    case 'git-subdir':
      return `${s.url}${refSuffix(s.ref)} --root ${s.path}`;
    default:
      return undefined;
  }
}

export function isRemoteSource(s: MarketplaceSource): boolean {
  return s.type === 'github' || s.type === 'git-subdir' || s.type === 'url' || s.type === 'git';
}

async function readMarketplaceText(file: string): Promise<string> {
  if (/^https?:\/\//.test(file)) {
    let res: Response;
    try {
      res = await fetch(file);
    } catch (e) {
      throw new PalmError('E_NETWORK', `could not fetch ${file}: ${messageOf(e)}`);
    }
    if (!res.ok) throw new PalmError('E_NETWORK', `could not fetch ${file}: HTTP ${res.status}`);
    return res.text();
  }
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    throw new PalmError('E_IO', `cannot read marketplace file ${file}: ${messageOf(e)}`);
  }
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
  const warnings: string[] = [];
  const metadata = isRecord(json.metadata) ? json.metadata : {};
  const pluginRoot = asString(metadata.pluginRoot) ?? asString(json.pluginRoot);
  const entries: MarketplaceEntry[] = [];
  json.plugins.forEach((p, i) => {
    if (!isRecord(p)) {
      warnings.push(`marketplace entry #${i + 1} is not an object; skipped`);
      return;
    }
    let source = normalizeSource(p.source);
    if (source.type === 'local' && pluginRoot)
      source = { type: 'local', path: joinRel(pluginRoot, source.path) };
    const name =
      asString(p.name) ??
      (source.type === 'local' && source.path !== '' ? basename(source.path) : undefined);
    if (!name) {
      warnings.push(`marketplace entry #${i + 1} has no name; skipped`);
      return;
    }
    const { decls, unsupported } = parseComponentDecls(p);
    entries.push(
      withoutUndefined({
        name,
        source,
        description: asString(p.description),
        version: asString(p.version),
        strict: asBool(p.strict) ?? true,
        components: decls,
        unsupported,
        raw: p,
      }),
    );
  });
  const rootDir = /^https?:\/\//.test(file) ? undefined : marketplaceRootFor(resolve(file));
  return withoutUndefined({ name: asString(json.name), file, rootDir, entries, warnings });
}

export async function readMarketplace(file: string): Promise<Marketplace> {
  return parseMarketplaceJson(await readMarketplaceText(file), file);
}

/** `https://github.com/o/r` → `https://github.com/o/r.git`; other URLs untouched. */
function normalizeGitUrl(url: string): string {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (m) return `https://github.com/${m[1]}/${m[2]}.git`;
  return url.trim();
}

/** Derive base.url/ref from a raw.githubusercontent.com or github.com/blob marketplace URL. */
function baseFromUrl(file: string): { url?: string; ref?: string; root?: string } {
  const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(file);
  const blob = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/.exec(file);
  const m = raw ?? blob;
  if (!m) return {};
  const [, owner, repo, ref, filePath] = m;
  const root = marketplaceRootFor(`/${filePath ?? ''}`).slice(1);
  return withoutUndefined({
    url: `https://github.com/${owner}/${repo}.git`,
    ref,
    root: root === '' ? undefined : root,
  });
}

/** Where relative entries of an imported marketplace resolve: a repository URL or a directory. */
interface ImportBase {
  url?: string;
  ref?: string;
  /** Marketplace root inside the repository (URL imports). */
  root: string;
  path?: string;
}

type SpecOrWarning = Omit<OriginSpec, 'alias'> | string;

function localEntrySpec(e: MarketplaceEntry, path: string, base: ImportBase): SpecOrWarning {
  const rel = joinRel(base.root, path);
  if (base.url)
    return {
      type: 'git',
      url: normalizeGitUrl(base.url),
      ref: base.ref,
      root: rel === '' ? undefined : rel,
    };
  if (base.path) return { type: 'local', path: resolve(base.path, rel === '' ? '.' : rel) };
  return `plugin "${e.name}": relative source ${describeSource(e.source)} cannot be resolved without a base path or URL; skipped`;
}

/** The origin an entry imports as (remote pins: `sha` wins over `ref`), or why it cannot. */
function entrySpec(e: MarketplaceEntry, base: ImportBase): SpecOrWarning {
  const s = e.source;
  switch (s.type) {
    case 'local':
      return localEntrySpec(e, s.path, base);
    case 'github':
      return {
        type: 'git',
        url: `https://github.com/${s.repo.replace(/\.git$/, '')}.git`,
        ref: s.sha ?? s.ref,
        root: s.path || undefined,
      };
    case 'git-subdir':
      return {
        type: 'git',
        url: normalizeGitUrl(s.url),
        ref: s.sha ?? s.ref,
        root: s.path || undefined,
      };
    case 'url':
    case 'git':
      return { type: 'git', url: normalizeGitUrl(s.url), ref: s.sha ?? s.ref };
    case 'npm':
      return `plugin "${e.name}": npm source ${s.package} is not supported; skipped`;
    case 'unknown':
      return `plugin "${e.name}": unrecognised source ${describeSource(s)}; skipped`;
  }
}

interface ImportedSpec {
  spec: OriginSpec;
  entry: string;
}

/** One origin per distinct location; entries sharing one (several `./` subsets) import once. */
function collapseShared(mp: Marketplace, specs: ImportedSpec[], warnings: string[]): OriginSpec[] {
  const groups = new Map<string, ImportedSpec[]>();
  for (const s of specs) {
    const key = JSON.stringify([s.spec.type, s.spec.url, s.spec.path, s.spec.ref, s.spec.root]);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const used = new Set<string>();
  const uniqueAlias = (wanted: string) => {
    let a = wanted;
    for (let i = 2; used.has(a); i++) a = `${wanted}-${i}`;
    used.add(a);
    return a;
  };
  const origins: OriginSpec[] = [];
  for (const [first, ...rest] of groups.values()) {
    if (!first) continue;
    if (rest.length === 0) {
      origins.push(
        withoutUndefined({ ...first.spec, alias: uniqueAlias(slugify(first.entry) || 'plugin') }),
      );
      continue;
    }
    const alias = uniqueAlias(toSlug(mp.name, first.entry));
    warnings.push(
      `plugins ${[first, ...rest].map((g) => `"${g.entry}"`).join(', ')} share one source; imported once as origin "${alias}"`,
    );
    first.spec.description = mp.name ? `marketplace ${mp.name}` : first.spec.description;
    origins.push(withoutUndefined({ ...first.spec, alias }));
  }
  return origins;
}

/**
 * Expand a marketplace into origin specs, one per entry. Remote sources keep their URL and
 * pin (`sha` wins over `ref`); relative sources resolve against `base.url` (same repo, with
 * `root`) or `base.path`/the marketplace's own directory (local). Entries that resolve to the
 * same location are imported once.
 */
export const parseMarketplace = async (
  file: string,
  base: { url?: string; path?: string; ref?: string },
): Promise<{ origins: OriginSpec[]; warnings: string[] }> => {
  const mp = await readMarketplace(file);
  const warnings = [...mp.warnings];
  const fromUrl = /^https?:\/\//.test(file) ? baseFromUrl(file) : {};
  const importBase: ImportBase = {
    url: base.url ?? fromUrl.url,
    ref: base.ref ?? fromUrl.ref,
    root: base.url ? '' : (fromUrl.root ?? ''),
    path: base.path ?? mp.rootDir,
  };
  const specs: ImportedSpec[] = [];
  for (const e of mp.entries) {
    const spec = entrySpec(e, importBase);
    if (typeof spec === 'string') warnings.push(spec);
    else
      specs.push({
        spec: withoutUndefined({ alias: '', ...spec, description: e.description }) as OriginSpec,
        entry: e.name,
      });
  }
  return { origins: collapseShared(mp, specs, warnings), warnings };
};
