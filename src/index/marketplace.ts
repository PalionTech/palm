/**
 * Plugin marketplaces (Claude, Cursor, Copilot, Codex). Used two ways:
 *  - during a scan, relative entries become plugin entities (see scan.ts);
 *  - `palm origin import` expands a marketplace into one OriginSpec per entry (parseMarketplace).
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { OriginSpec, ParseMarketplaceFn } from '../core/types.js';
import { PalmError } from '../core/errors.js';
import { parseComponentDecls, type ComponentDecls } from './plugin-manifest.js';
import { slugify, toSlug } from './slug.js';
import { asBool, asString, compact, isRecord, joinRel, normRel } from './util.js';

/** Marketplace file locations relative to the repo root, in precedence order. */
export const MARKETPLACE_FILES = [
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
  if (parent === '.claude-plugin' || parent === '.cursor-plugin' || parent === '.codex-plugin') return dirname(dir);
  if (parent === 'plugin' && basename(dirname(dir)) === '.github') return dirname(dirname(dir));
  if (parent === 'plugins' && basename(dirname(dir)) === '.agents') return dirname(dirname(dir));
  return dir;
}

const REMOTE_STRING = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|github:)/;

export function normalizeSource(src: unknown): MarketplaceSource {
  if (typeof src === 'string') {
    const s = src.trim();
    if (s.startsWith('github:')) return { type: 'github', repo: s.slice('github:'.length) };
    if (REMOTE_STRING.test(s)) return { type: 'git', url: s };
    return { type: 'local', path: normRel(s) };
  }
  if (!isRecord(src)) return { type: 'unknown', raw: src };
  const kind = asString(src.source) ?? asString(src.type);
  const ref = asString(src.ref);
  const sha = asString(src.sha);
  const path = asString(src.path);
  switch (kind) {
    case 'github': {
      const repo = asString(src.repo);
      if (!repo) return { type: 'unknown', raw: src };
      return compact({ type: 'github' as const, repo, path: path ? normRel(path) : undefined, ref, sha });
    }
    case 'git-subdir': {
      const url = asString(src.url);
      if (!url) return { type: 'unknown', raw: src };
      return compact({ type: 'git-subdir' as const, url, path: normRel(path ?? ''), ref, sha });
    }
    case 'url':
    case 'git': {
      const url = asString(src.url);
      if (!url) return { type: 'unknown', raw: src };
      // Codex writes `{source:"url", url:"./"}` for the marketplace repo itself.
      if (!REMOTE_STRING.test(url) && !/^[a-z]+:\/\//i.test(url)) return { type: 'local', path: normRel(url) };
      return compact({ type: kind, url, ref, sha });
    }
    case 'local':
    case 'relative':
    case 'path':
      return { type: 'local', path: normRel(path ?? asString(src.url) ?? '') };
    case 'npm': {
      const pkg = asString(src.package) ?? asString(src.name) ?? '';
      return compact({ type: 'npm' as const, package: pkg, version: asString(src.version) });
    }
    default:
      return { type: 'unknown', raw: src };
  }
}

export function describeSource(s: MarketplaceSource): string {
  switch (s.type) {
    case 'local':
      return s.path === '' ? './' : s.path;
    case 'github':
      return `github:${s.repo}${s.path ? '/' + s.path : ''}${s.sha ? '@' + s.sha.slice(0, 12) : s.ref ? '#' + s.ref : ''}`;
    case 'git-subdir':
      return `${s.url} (${s.path})${s.sha ? '@' + s.sha.slice(0, 12) : s.ref ? '#' + s.ref : ''}`;
    case 'url':
    case 'git':
      return `${s.url}${s.sha ? '@' + s.sha.slice(0, 12) : s.ref ? '#' + s.ref : ''}`;
    case 'npm':
      return `npm:${s.package}`;
    case 'unknown':
      return JSON.stringify(s.raw);
  }
}

/** A `palm origin add` argument that would fetch this remote source. */
export function originHint(s: MarketplaceSource): string | undefined {
  switch (s.type) {
    case 'github':
      return `${s.repo}${s.path ? '/' + s.path : ''}${s.ref ? '#' + s.ref : ''}`;
    case 'url':
    case 'git':
      return `${s.url}${s.ref ? '#' + s.ref : ''}`;
    case 'git-subdir':
      return `${s.url}${s.ref ? '#' + s.ref : ''} (root: ${s.path})`;
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
      throw new PalmError('E_NETWORK', `could not fetch ${file}: ${(e as Error).message}`);
    }
    if (!res.ok) throw new PalmError('E_NETWORK', `could not fetch ${file}: HTTP ${res.status}`);
    return res.text();
  }
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    throw new PalmError('E_IO', `cannot read marketplace file ${file}: ${(e as Error).message}`);
  }
}

/** Parse marketplace JSON text into normalized entries. */
export function parseMarketplaceJson(text: string, file: string): Marketplace {
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new PalmError('E_PARSE', `invalid JSON in marketplace ${file}: ${(e as Error).message}`);
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
    if (source.type === 'local' && pluginRoot) source = { type: 'local', path: joinRel(pluginRoot, source.path) };
    const name = asString(p.name) ?? (source.type === 'local' && source.path !== '' ? basename(source.path) : undefined);
    if (!name) {
      warnings.push(`marketplace entry #${i + 1} has no name; skipped`);
      return;
    }
    const { decls, unsupported } = parseComponentDecls(p);
    entries.push(
      compact({
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
  return compact({ name: asString(json.name), file, rootDir, entries, warnings });
}

export async function readMarketplace(file: string): Promise<Marketplace> {
  return parseMarketplaceJson(await readMarketplaceText(file), file);
}

/** `https://github.com/o/r` → `https://github.com/o/r.git`; other URLs untouched. */
export function normalizeGitUrl(url: string): string {
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
  const root = marketplaceRootFor('/' + (filePath ?? '')).slice(1);
  return compact({ url: `https://github.com/${owner}/${repo}.git`, ref, root: root === '' ? undefined : root });
}

/**
 * Expand a marketplace into origin specs, one per entry. Remote sources keep their URL and
 * pin (`sha` wins over `ref`); relative sources resolve against `base.url` (same repo, with
 * `root`) or `base.path`/the marketplace's own directory (local). Entries that resolve to the
 * same location are imported once.
 */
export const parseMarketplace: ParseMarketplaceFn = async (file, base) => {
  const mp = await readMarketplace(file);
  const warnings = [...mp.warnings];
  const fromUrl = /^https?:\/\//.test(file) ? baseFromUrl(file) : {};
  const baseUrl = base.url ?? fromUrl.url;
  const baseRef = base.ref ?? fromUrl.ref;
  const baseRoot = base.url ? '' : (fromUrl.root ?? '');
  const basePath = base.path ?? mp.rootDir;

  const specs: Array<{ spec: OriginSpec; entry: string; key: string }> = [];
  for (const e of mp.entries) {
    const s = e.source;
    let spec: Omit<OriginSpec, 'alias'> | undefined;
    switch (s.type) {
      case 'local': {
        const rel = joinRel(baseRoot, s.path);
        if (baseUrl) spec = { type: 'git', url: normalizeGitUrl(baseUrl), ref: baseRef, root: rel === '' ? undefined : rel };
        else if (basePath) spec = { type: 'local', path: resolve(basePath, rel === '' ? '.' : rel) };
        else warnings.push(`plugin "${e.name}": relative source ${describeSource(s)} cannot be resolved without a base path or URL; skipped`);
        break;
      }
      case 'github':
        spec = { type: 'git', url: `https://github.com/${s.repo.replace(/\.git$/, '')}.git`, ref: s.sha ?? s.ref, root: s.path || undefined };
        break;
      case 'git-subdir':
        spec = { type: 'git', url: normalizeGitUrl(s.url), ref: s.sha ?? s.ref, root: s.path || undefined };
        break;
      case 'url':
      case 'git':
        spec = { type: 'git', url: normalizeGitUrl(s.url), ref: s.sha ?? s.ref };
        break;
      case 'npm':
        warnings.push(`plugin "${e.name}": npm source ${s.package} is not supported; skipped`);
        break;
      case 'unknown':
        warnings.push(`plugin "${e.name}": unrecognised source ${describeSource(s)}; skipped`);
        break;
    }
    if (!spec) continue;
    const full = compact({ alias: '', ...spec, description: e.description }) as OriginSpec;
    const key = JSON.stringify([full.type, full.url, full.path, full.ref, full.root]);
    specs.push({ spec: full, entry: e.name, key });
  }

  // Collapse entries sharing one location (e.g. several `source: "./"` subsets of one repo).
  const groups = new Map<string, Array<{ spec: OriginSpec; entry: string }>>();
  for (const s of specs) {
    const g = groups.get(s.key);
    if (g) g.push(s);
    else groups.set(s.key, [s]);
  }
  const used = new Set<string>();
  const uniqueAlias = (wanted: string) => {
    let a = wanted;
    for (let i = 2; used.has(a); i++) a = `${wanted}-${i}`;
    used.add(a);
    return a;
  };
  const origins: OriginSpec[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    let alias: string;
    if (group.length > 1) {
      alias = uniqueAlias(toSlug(mp.name, first.entry));
      warnings.push(`plugins ${group.map((g) => `"${g.entry}"`).join(', ')} share one source; imported once as origin "${alias}"`);
      first.spec.description = mp.name ? `marketplace ${mp.name}` : first.spec.description;
    } else {
      alias = uniqueAlias(slugify(first.entry) || 'plugin');
    }
    origins.push(compact({ ...first.spec, alias }));
  }
  return { origins, warnings };
};
