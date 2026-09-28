import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { execa } from 'execa';
import { isValidAlias } from '../lib/names.js';
import { isRecord, withoutUndefined } from '../lib/object.js';
import { parseYaml, writeYamlFile } from '../lib/yaml.js';
import { messageOf, PalmError } from './errors.js';
import { loadManifest, loadYaml, saveManifest } from './manifest.js';
import { configPath, manifestPath } from './paths.js';
import {
  type LayoutDescriptor,
  type OriginSpec,
  type PalmConfig,
  type PalmContext,
  type PalmPaths,
  type Scope,
  TARGET_IDS,
  type TargetId,
} from './types.js';

// ---------------------------------------------------------------------------
// config.yaml
// ---------------------------------------------------------------------------

function validTargets(v: unknown): TargetId[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter(
    (t): t is TargetId => typeof t === 'string' && (TARGET_IDS as readonly string[]).includes(t),
  );
  return out.length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Alias rules (DESIGN.md §5): every stored origin carries an explicit, unique alias
// ---------------------------------------------------------------------------

/** A problem with a stored origin's alias. Unlike other bad palm.yaml origin entries these are never skipped. */
class OriginAliasError extends PalmError {}

function aliasFormatHint(alias: string): string {
  const suggestion = sanitizeAlias(alias);
  const example = suggestion && suggestion !== alias ? ` (e.g. \`${suggestion}\`)` : '';
  return `An alias is lowercase letters, digits, ".", "_" and "-", starting with a letter or digit${example}.`;
}

/** Throws `code` unless `alias` is a valid alias (lib/names ALIAS_RE). */
function assertAliasFormat(alias: string, code: 'E_USAGE' | 'E_PARSE', where?: string): void {
  if (isValidAlias(alias)) return;
  const msg = `${where ? `${where}: ` : ''}invalid origin alias "${alias}"`;
  if (code === 'E_PARSE') throw new OriginAliasError(code, msg, aliasFormatHint(alias));
  throw new PalmError(code, msg, aliasFormatHint(alias));
}

/** No two origins of one file may share an alias. */
function assertUniqueAliases(origins: OriginSpec[], where: string): void {
  const seen = new Map<string, OriginSpec>();
  for (const o of origins) {
    const prev = seen.get(o.alias);
    if (prev) {
      throw new OriginAliasError(
        'E_PARSE',
        `${where}: origin alias "${o.alias}" is used twice (${describeOrigin(prev)} and ${describeOrigin(o)})`,
        'Give each origin its own alias.',
      );
    }
    seen.set(o.alias, o);
  }
}

/** `{ alias: x, type: git, url: … }` — a stored origin as one YAML flow mapping (for hints). */
function flowMapping(spec: OriginSpec): string {
  const parts = Object.entries(serializeOrigin(spec))
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => `${k}: ${String(v)}`);
  return `{ ${parts.join(', ')} }`;
}

/**
 * Turn a stored origin entry into a full OriginSpec. Relative local paths resolve against `baseDir`.
 * The alias is mandatory and never derived here: a string entry or a mapping without `alias` is E_PARSE.
 */
function normalizeStoredOrigin(raw: unknown, baseDir: string, where: string): OriginSpec {
  if (typeof raw === 'string') {
    const parsed = parseOriginInput(raw, { cwd: baseDir }); // an unusable URL or path is reported first
    throw new OriginAliasError(
      'E_PARSE',
      `${where}: origin ${raw} has no alias`,
      `write it as a mapping and add \`alias: ${parsed.alias}\`, e.g. \`- ${flowMapping(parsed)}\` (palm derives that name with \`palm origin add\`)`,
    );
  }
  if (!isRecord(raw))
    throw new PalmError('E_PARSE', `${where}: invalid origin entry ${JSON.stringify(raw)}`);
  const type =
    raw.type === 'local' || (raw.type === undefined && typeof raw.path === 'string' && !raw.url)
      ? 'local'
      : 'git';
  const alias =
    typeof raw.alias === 'string' || typeof raw.alias === 'number' ? String(raw.alias) : '';
  const spec: OriginSpec = { alias, type };
  if (type === 'git') {
    if (typeof raw.url !== 'string' || !raw.url)
      throw new PalmError('E_PARSE', `${where}: git origin "${spec.alias}" has no url`);
    validateOriginUrl(raw.url, `${where}: origin "${spec.alias || raw.url}"`);
    spec.url = raw.url;
  } else {
    if (typeof raw.path !== 'string' || !raw.path)
      throw new PalmError('E_PARSE', `${where}: local origin "${spec.alias}" has no path`);
    spec.path = resolve(baseDir, expandTilde(raw.path));
  }
  if (typeof raw.ref === 'string' && raw.ref) spec.ref = raw.ref;
  if (typeof raw.root === 'string' && raw.root) spec.root = trimSlashes(raw.root);
  if (isRecord(raw.layout)) spec.layout = raw.layout as LayoutDescriptor;
  if (typeof raw.description === 'string') spec.description = raw.description;
  if (!alias.trim()) {
    throw new OriginAliasError(
      'E_PARSE',
      `${where}: origin ${String(type === 'git' ? raw.url : raw.path)} has no alias`,
      `add \`alias: ${deriveAlias(spec, [])}\` (palm derives that name with \`palm origin add\`)`,
    );
  }
  assertAliasFormat(alias, 'E_PARSE', where);
  return spec;
}

export async function loadConfig(paths: PalmPaths): Promise<PalmConfig> {
  const file = configPath(paths);
  const data = await loadYaml(file);
  if (data === undefined || data === null) return { origins: [] };
  if (!isRecord(data)) throw new PalmError('E_PARSE', `${file} must be a YAML mapping`);
  const cfg: PalmConfig = { ...(data as object), origins: [] } as PalmConfig;
  const targets = validTargets(data.targets);
  if (targets) cfg.targets = targets;
  else delete cfg.targets;
  if (Array.isArray(data.origins)) {
    cfg.origins = data.origins.map((o) => normalizeStoredOrigin(o, paths.palmHome, file));
    assertUniqueAliases(cfg.origins, file);
  }
  return cfg;
}

/** A stored origin: its known fields in a fixed order, undefined ones left out. */
function serializeOrigin(spec: OriginSpec): Record<string, unknown> {
  const { alias, type, url, path, ref, root, layout, description } = spec;
  return withoutUndefined({ alias, type, url, path, ref, root, layout, description });
}

export async function saveConfig(paths: PalmPaths, cfg: PalmConfig): Promise<void> {
  const { targets, origins, ...rest } = cfg;
  const out = withoutUndefined({ targets, origins: origins.map(serializeOrigin), ...rest });
  // config.yaml is user-private (0600), like the harness configs palm writes secrets into.
  await writeYamlFile(configPath(paths), out, { flowKeys: ['targets'], mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Origin spec parsing
// ---------------------------------------------------------------------------

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function stripGit(s: string): string {
  return s.replace(/\.git$/i, '');
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isBareRepo(p: string): boolean {
  return existsSync(join(p, 'HEAD')) && isDir(join(p, 'objects')) && !existsSync(join(p, '.git'));
}

const SHORTHAND = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+)((?:\/[^/\s]+)*)\/?$/;
const SCP_LIKE = /^([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+):(.+)$/;

type ParsedOrigin = Omit<OriginSpec, 'alias'>;

function githubSpec(owner: string, repo: string, rest: string[], ref?: string): ParsedOrigin {
  let root: string | undefined;
  let treeRef: string | undefined;
  if ((rest[0] === 'tree' || rest[0] === 'blob') && rest[1]) {
    treeRef = rest[1];
    root = rest.slice(2).join('/') || undefined;
  } else if (rest.length) {
    root = rest.join('/');
  }
  const spec: ParsedOrigin = {
    type: 'git',
    url: `https://github.com/${owner}/${stripGit(repo)}.git`,
  };
  const r = ref ?? treeRef;
  if (r) spec.ref = r;
  if (root) spec.root = root;
  return spec;
}

function parseUrlSpec(body: string, ref: string | undefined): ParsedOrigin {
  let u: URL;
  try {
    u = new URL(body);
  } catch {
    throw new PalmError('E_ORIGIN', `Invalid origin URL "${body}"`);
  }
  if (u.protocol === 'file:') {
    const spec: ParsedOrigin = { type: 'git', url: body };
    if (ref) spec.ref = ref;
    return spec;
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (
    (host === 'github.com' || host === 'www.github.com') &&
    !u.username &&
    (u.protocol === 'https:' || u.protocol === 'http:')
  ) {
    if (segs.length < 2)
      throw new PalmError('E_ORIGIN', `GitHub URL "${body}" needs an owner and a repository`);
    return githubSpec(segs[0]!, segs[1]!, segs.slice(2), ref);
  }
  // Other hosts: GitLab-style "/-/tree/<ref>/<dir>" is understood; everything else is the repo path.
  let url = body.replace(/\/+$/, '');
  let root: string | undefined;
  let treeRef: string | undefined;
  const dash = segs.indexOf('-');
  if (dash > 0 && (segs[dash + 1] === 'tree' || segs[dash + 1] === 'blob') && segs[dash + 2]) {
    treeRef = segs[dash + 2];
    root = segs.slice(dash + 3).join('/') || undefined;
    url = `${u.protocol}//${u.host}/${segs.slice(0, dash).join('/')}`;
  }
  if (host === 'gitlab.com' && !/\.git$/i.test(url)) url = `${url}.git`;
  const spec: ParsedOrigin = { type: 'git', url };
  const r = ref ?? treeRef;
  if (r) spec.ref = r;
  if (root) spec.root = root;
  return spec;
}

function localPathFor(raw: string, cwd: string): string | undefined {
  const explicit =
    isAbsolute(raw) ||
    raw === '.' ||
    raw === '..' ||
    raw.startsWith('./') ||
    raw.startsWith('../') ||
    raw === '~' ||
    raw.startsWith('~/');
  const abs = resolve(cwd, expandTilde(raw));
  if (explicit) {
    if (!existsSync(abs)) {
      throw new PalmError('E_ORIGIN', `Local origin path does not exist: ${abs}`);
    }
    if (!isDir(abs)) {
      throw new PalmError(
        'E_ORIGIN',
        `Local origin must be a directory: ${abs}`,
        'For a marketplace.json file use `palm origin import <file>`.',
      );
    }
    return abs;
  }
  return isDir(abs) ? abs : undefined;
}

/**
 * The one gate for git origin URLs (CLI input, config.yaml, palm.yaml, marketplace imports).
 * Allowed: `https://`, `http://` (warning), `ssh://`, `git://` (warning), `file://`,
 * scp-like `user@host:path`, and absolute local paths (bare repositories). Refused: anything
 * git could read as an option (leading `-`), transport helpers (`ext::`, `fd::`, `file::`,
 * any `<name>::`), other schemes, and control characters. Returns a warning for plain-text
 * transports.
 */
export function validateOriginUrl(url: string, where = 'origin'): { warning?: string } {
  const bad = (why: string): PalmError =>
    new PalmError(
      'E_ORIGIN',
      `Refusing ${where} URL "${url}": ${why}`,
      'Use https://…, ssh://…, git@host:owner/repo.git or a local path.',
    );
  if (!url || url !== url.trim()) throw bad('empty or padded with whitespace');
  if (/[\u0000-\u001f\u007f]/.test(url)) throw bad('contains control characters');
  if (url.startsWith('-')) throw bad('git would read it as an option');
  if (/^[A-Za-z0-9+.-]*::/.test(url) || /^[^/]*::/.test(url))
    throw bad('git transport helpers (ext::, fd::, …) are not allowed');
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  if (scheme) {
    if (!['https', 'http', 'ssh', 'git', 'file'].includes(scheme))
      throw bad(`unsupported scheme ${scheme}://`);
    const rest = url.slice(scheme.length + 3);
    if (rest.startsWith('-')) throw bad('host would be read as an option');
    return scheme === 'http' || scheme === 'git'
      ? { warning: `${where} ${url} uses an unencrypted transport (${scheme}://)` }
      : {};
  }
  const scp = SCP_LIKE.exec(url);
  if (scp) {
    if (scp[2]!.startsWith('-') || scp[3]!.startsWith('-'))
      throw bad('host or path would be read as an option');
    return {};
  }
  if (isAbsolute(url)) return {};
  throw bad('not a URL git can fetch safely');
}

export interface ParseOriginOptions {
  alias?: string;
  ref?: string;
  root?: string;
  layout?: LayoutDescriptor;
  /** Base for relative local paths (default: process.cwd()). */
  cwd?: string;
}

/**
 * Parse a user-supplied origin: `owner/repo[/sub/dir][#ref]`, `github:owner/repo`,
 * `https://…[#ref]`, `git@host:owner/repo.git[#ref]`, or a local directory.
 */
export function parseOriginInput(input: string, opts: ParseOriginOptions = {}): OriginSpec {
  const raw = input.trim();
  if (!raw) throw new PalmError('E_USAGE', 'Empty origin spec');
  const cwd = opts.cwd ?? process.cwd();

  let parsed: ParsedOrigin | undefined;
  const local = localPathFor(raw, cwd);
  if (local) {
    parsed = isBareRepo(local) ? { type: 'git', url: local } : { type: 'local', path: local };
  } else {
    let body = raw;
    let ref: string | undefined;
    const h = raw.lastIndexOf('#');
    if (h >= 0) {
      ref = raw.slice(h + 1).trim() || undefined;
      body = raw.slice(0, h);
    }
    const prefixed = /^(github|gitlab):(.+)$/i.exec(body);
    if (prefixed) {
      const host = prefixed[1]!.toLowerCase();
      const segs = trimSlashes(prefixed[2]!).split('/').filter(Boolean);
      if (segs.length < 2)
        throw new PalmError('E_ORIGIN', `"${raw}" needs an owner and a repository`);
      if (host === 'github') parsed = githubSpec(segs[0]!, segs[1]!, segs.slice(2), ref);
      else {
        parsed = { type: 'git', url: `https://gitlab.com/${segs.map(stripGit).join('/')}.git` };
        if (ref) parsed.ref = ref;
      }
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(body)) {
      parsed = parseUrlSpec(body, ref);
    } else if (SCP_LIKE.test(body)) {
      const m = SCP_LIKE.exec(body)!;
      const host = m[2]!.toLowerCase();
      const segs = trimSlashes(m[3]!).split('/').filter(Boolean);
      if (host === 'github.com' && segs.length >= 2) {
        const repo = stripGit(segs[1]!);
        parsed = { type: 'git', url: `${m[1]}@github.com:${segs[0]}/${repo}.git` };
        if (segs.length > 2) parsed.root = segs.slice(2).join('/');
      } else {
        parsed = { type: 'git', url: body };
      }
      if (ref) parsed.ref = ref;
    } else if (SHORTHAND.test(body)) {
      const m = SHORTHAND.exec(body)!;
      const rest = (m[3] ?? '').split('/').filter(Boolean);
      parsed = githubSpec(m[1]!, m[2]!, rest, ref);
    } else {
      throw new PalmError(
        'E_ORIGIN',
        `Unrecognised origin "${raw}"`,
        'Use owner/repo, owner/repo/sub/dir, github:owner/repo, a git URL (https:// or git@…), or a local directory path.',
      );
    }
  }

  const spec: OriginSpec = { alias: '', ...parsed };
  if (spec.type === 'git') validateOriginUrl(spec.url ?? '', `origin "${raw}"`);
  if (opts.ref) spec.ref = opts.ref;
  if (opts.root) spec.root = trimSlashes(opts.root);
  if (spec.root === '') delete spec.root;
  if (opts.layout) spec.layout = opts.layout;
  if (opts.alias !== undefined) assertAliasFormat(opts.alias, 'E_USAGE');
  spec.alias = opts.alias ?? deriveAlias(spec, []);
  return spec;
}

// ---------------------------------------------------------------------------
// Aliases and ids
// ---------------------------------------------------------------------------

/** host + path segments of a git URL, scp-like address, or local path. */
function urlParts(url: string): { host: string; segs: string[] } {
  const scp = SCP_LIKE.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return { host: scp[2]!.toLowerCase(), segs: trimSlashes(scp[3]!).split('/').filter(Boolean) };
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

function repoParts(spec: OriginSpec): { owner?: string; repo: string } {
  if (spec.type === 'local') {
    const p = spec.path ?? '';
    const owner = basename(dirname(p));
    return { owner: owner && owner !== '/' ? owner : undefined, repo: basename(p) || 'local' };
  }
  const { segs } = urlParts(spec.url ?? '');
  const repo = stripGit(segs[segs.length - 1] ?? 'origin');
  const owner = segs.length >= 2 ? segs[segs.length - 2] : undefined;
  return { owner, repo };
}

function sanitizeAlias(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|-+$/g, ''); // ALIAS_RE: starts with a letter or digit
}

/**
 * Repository names that say what a repo contains, not whose it is: `mattpocock/skills`,
 * `anthropics/skills` and `openai/skills` are told apart by their owner.
 */
const GENERIC_REPO_NAMES = new Set([
  'skills',
  'agent-skills',
  'claude-skills',
  'plugins',
  'claude-plugins',
  'agents',
  'subagents',
  'prompts',
  'rules',
  'commands',
  'hooks',
  'mcp',
  'mcp-servers',
  'extensions',
  'instructions',
  'dotfiles',
  'config',
  'configs',
]);

/** Default alias for an origin that does not collide with `existing` (DESIGN.md §5). */
export function deriveAlias(spec: OriginSpec, existing: OriginSpec[]): string {
  const { owner, repo } = repoParts(spec);
  const base =
    owner && spec.type === 'git' && GENERIC_REPO_NAMES.has(repo.toLowerCase()) ? owner : repo;
  const last = spec.root ? trimSlashes(spec.root).split('/').pop() : undefined;
  const raw = last
    ? [last, `${base}-${last}`, owner ? `${owner}-${repo}-${last}` : undefined]
    : [base, owner ? `${owner}-${repo}` : undefined];
  const candidates = [
    ...new Set(
      raw
        .filter((c): c is string => !!c)
        .map(sanitizeAlias)
        .filter(Boolean),
    ),
  ];
  if (candidates.length === 0) candidates.push('origin');
  const taken = new Set(existing.map((o) => o.alias.toLowerCase()));
  for (const c of candidates) if (!taken.has(c)) return c;
  const fallback = candidates[candidates.length - 1]!;
  for (let n = 2; ; n++) {
    const c = `${fallback}-${n}`;
    if (!taken.has(c)) return c;
  }
}

function sanitizeId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

/**
 * Cache directory name for an origin: `<host>__<owner>__<repo>[__<root>]`, or
 * `local__<path>-<hash>` (the short hash of the raw path keeps `a/b` and `a-b` apart).
 */
export function originId(spec: OriginSpec): string {
  const rootSegs = spec.root ? trimSlashes(spec.root).split('/').filter(Boolean) : [];
  if (spec.type === 'local') {
    const segs = (spec.path ?? '').split(/[\\/]+/).filter(Boolean);
    const raw = `${spec.path ?? ''}\0${spec.root ?? ''}`;
    return `${['local', ...segs, ...rootSegs].map(sanitizeId).join('__')}-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
  }
  const { host, segs } = urlParts(spec.url ?? '');
  const path = segs.map((s, i) => (i === segs.length - 1 ? stripGit(s) : s));
  return [host, ...path, ...rootSegs].map(sanitizeId).join('__');
}

// ---------------------------------------------------------------------------
// Origin registry (config + project manifest)
// ---------------------------------------------------------------------------

/** Origins declared in the project manifest (read synchronously; the file is small). */
export function projectOrigins(ctx: PalmContext): OriginSpec[] {
  const file = manifestPath(ctx.paths, 'project');
  if (!existsSync(file)) return [];
  let data: unknown;
  try {
    data = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    ctx.log.warn(`Ignoring origins in ${file}: ${messageOf(e)}`);
    return [];
  }
  if (!isRecord(data) || !Array.isArray(data.origins)) return [];
  const out: OriginSpec[] = [];
  for (const raw of data.origins) {
    try {
      out.push(normalizeStoredOrigin(raw, ctx.paths.projectRoot, file));
    } catch (e) {
      // A refused URL or missing path skips the entry; a missing or invalid alias is a hard error.
      if (e instanceof OriginAliasError) throw e;
      ctx.log.warn(messageOf(e));
    }
  }
  assertUniqueAliases(out, file);
  return out;
}

export function allOrigins(ctx: PalmContext): OriginSpec[] {
  const byAlias = new Map<string, OriginSpec>();
  for (const o of ctx.config.origins) byAlias.set(o.alias.toLowerCase(), o);
  for (const o of projectOrigins(ctx)) byAlias.set(o.alias.toLowerCase(), o);
  return [...byAlias.values()];
}

export function findOrigin(ctx: PalmContext, alias: string): OriginSpec | undefined {
  const lower = alias.toLowerCase();
  return allOrigins(ctx).find((o) => o.alias.toLowerCase() === lower);
}

function describeOrigin(o: OriginSpec): string {
  return o.type === 'local' ? (o.path ?? '') : `${o.url ?? ''}${o.root ? ` (${o.root})` : ''}`;
}

// ---------------------------------------------------------------------------
// Origin queries (`-o/--origin` on list, search and info)
// ---------------------------------------------------------------------------

function comparableUrl(url: string): string {
  return stripGit(url.trim().replace(/\/+$/, '')).toLowerCase();
}

/** `owner/repo` forms of a remote git origin: the full repository path and its last two segments. */
function repoPaths(spec: OriginSpec): string[] {
  if (spec.type !== 'git' || !spec.url) return [];
  const { host, segs } = urlParts(spec.url);
  if (host === 'file' || segs.length < 2) return [];
  const clean = segs.map((s, i) => (i === segs.length - 1 ? stripGit(s) : s).toLowerCase());
  return [...new Set([clean.join('/'), clean.slice(-2).join('/')])];
}

/**
 * How well `query` names `spec`: 3 = alias; 2 = exactly this origin (`owner/repo[/root]`, URL or
 * path including its root); 1 = its repository or directory but not its `root`; 0 = no match.
 */
function originMatchRank(spec: OriginSpec, query: string): 0 | 1 | 2 | 3 {
  const q = query.trim();
  if (!q) return 0;
  if (spec.alias.toLowerCase() === q.toLowerCase()) return 3;
  const root = spec.root ? trimSlashes(spec.root).toLowerCase() : '';
  let rank: 0 | 1 | 2 = 0;
  const hit = (exact: boolean): void => {
    rank = Math.max(rank, exact ? 2 : 1) as 1 | 2;
  };
  const lower = q.replace(/\/+$/, '').toLowerCase();
  for (const p of repoPaths(spec)) {
    if (lower === p) hit(!root);
    if (root && lower === `${p}/${root}`) hit(true);
  }
  if (spec.type === 'git' && spec.url && comparableUrl(spec.url) === comparableUrl(q)) hit(!root);
  const dir =
    spec.type === 'local' ? spec.path : spec.url && isAbsolute(spec.url) ? spec.url : undefined;
  if (dir && (isAbsolute(q) || q === '~' || q.startsWith('~/'))) {
    const abs = resolve(expandTilde(q));
    if (abs === resolve(dir)) hit(!root);
    if (root && abs === resolve(dir, spec.root!)) hit(true);
  }
  return rank;
}

/**
 * Whether `query` names `spec`: its alias (case-insensitive), `owner/repo` or `owner/repo/root`
 * of a git origin's URL + root, the full URL, or the local path (absolute or `~/…`).
 */
export function matchOrigin(spec: OriginSpec, query: string): boolean {
  return originMatchRank(spec, query) > 0;
}

/**
 * The one registered origin `query` names (see matchOrigin). An alias wins over everything else,
 * and a query naming an origin exactly (root included) wins over one naming only its repository.
 * Throws E_NOT_FOUND (listing the registered aliases) or E_AMBIGUOUS.
 */
export function resolveOriginQuery(ctx: PalmContext, query: string): OriginSpec {
  const origins = allOrigins(ctx);
  const ranked = origins
    .map((o) => ({ o, rank: originMatchRank(o, query) }))
    .filter((r) => r.rank > 0);
  if (ranked.length === 0) {
    const aliases = origins.map((o) => o.alias).sort();
    throw new PalmError(
      'E_NOT_FOUND',
      `No origin matches "${query}"`,
      aliases.length
        ? `Registered origins: ${aliases.join(', ')}. Use an alias, owner/repo[/root], the URL or the local path.`
        : 'No origins are registered; add one with `palm origin add owner/repo`.',
    );
  }
  const top = Math.max(...ranked.map((r) => r.rank));
  const best = ranked.filter((r) => r.rank === top).map((r) => r.o);
  if (best.length > 1) {
    throw new PalmError(
      'E_AMBIGUOUS',
      `"${query}" matches ${best.length} origins: ${best.map((o) => `${o.alias} (${describeOrigin(o)})`).join(', ')}`,
      `Use the alias instead, e.g. -o ${best[0]!.alias}.`,
    );
  }
  return best[0]!;
}

export async function addOrigin(
  ctx: PalmContext,
  spec: OriginSpec,
  opts: { scope?: Scope } = {},
): Promise<OriginSpec> {
  const scope = opts.scope ?? 'global';
  assertAliasFormat(spec.alias, 'E_USAGE');
  const all = allOrigins(ctx);
  let next = { ...spec };
  const clash = all.find((o) => o.alias.toLowerCase() === next.alias.toLowerCase());
  const replacing = !!clash && originId(clash) === originId(next);
  if (clash && !replacing) {
    if (next.alias === deriveAlias(next, [])) {
      next.alias = deriveAlias(next, all);
    } else {
      throw new PalmError(
        'E_CONFLICT',
        `Origin alias "${next.alias}" is already used by ${describeOrigin(clash)}`,
        'Pick another alias with --alias <name>, or remove the existing one with `palm origin remove`.',
      );
    }
  }

  if (scope === 'global') {
    const idx = ctx.config.origins.findIndex(
      (o) => o.alias.toLowerCase() === next.alias.toLowerCase(),
    );
    if (idx >= 0) ctx.config.origins[idx] = next;
    else ctx.config.origins.push(next);
    await saveConfig(ctx.paths, ctx.config);
  } else {
    const file = manifestPath(ctx.paths, 'project');
    const m = await loadManifest(file);
    const origins = [...(m.origins ?? [])];
    const idx = origins.findIndex((o) => {
      try {
        return (
          normalizeStoredOrigin(o, ctx.paths.projectRoot, file).alias.toLowerCase() ===
          next.alias.toLowerCase()
        );
      } catch {
        return false;
      }
    });
    const stored = serializeOrigin(next) as unknown as OriginSpec;
    if (idx >= 0) origins[idx] = stored;
    else origins.push(stored);
    await saveManifest(file, { ...m, origins });
  }
  return next;
}

export async function removeOrigin(ctx: PalmContext, alias: string): Promise<void> {
  const lower = alias.toLowerCase();
  const idx = ctx.config.origins.findIndex((o) => o.alias.toLowerCase() === lower);
  let removed = false;
  if (idx >= 0) {
    ctx.config.origins.splice(idx, 1);
    await saveConfig(ctx.paths, ctx.config);
    removed = true;
  }
  const file = manifestPath(ctx.paths, 'project');
  if (existsSync(file)) {
    const m = await loadManifest(file);
    const origins = m.origins ?? [];
    const kept = origins.filter((o) => {
      try {
        return normalizeStoredOrigin(o, ctx.paths.projectRoot, file).alias.toLowerCase() !== lower;
      } catch {
        return true;
      }
    });
    if (kept.length !== origins.length) {
      await saveManifest(file, { ...m, origins: kept });
      removed = true;
    }
  }
  if (!removed)
    throw new PalmError(
      'E_NOT_FOUND',
      `No origin with alias "${alias}"`,
      'See `palm origin list`.',
    );
}

const MINE_README = `# mine

Your own palm resources. \`palm create\` writes here; this directory is registered
as the local origin \`mine\`, so everything in it can be installed with
\`palm install <kind> <name>@mine\`.

- skills/<name>/SKILL.md
- agents/<name>.md
- instructions/<name>.md
- commands/<name>.md
`;

export async function ensureMineOrigin(ctx: PalmContext): Promise<OriginSpec> {
  const dir = join(ctx.paths.palmHome, 'mine');
  for (const sub of ['skills', 'agents', 'instructions', 'commands']) {
    await mkdir(join(dir, sub), { recursive: true });
  }
  const readme = join(dir, 'README.md');
  if (!existsSync(readme)) await writeFile(readme, MINE_README, 'utf8');
  if (!existsSync(join(dir, '.git'))) {
    try {
      await execa('git', ['init', '-q', dir], { env: { GIT_TERMINAL_PROMPT: '0' } });
    } catch {
      ctx.log.debug('git init of the mine origin failed; continuing without version control');
    }
  }
  const existing = ctx.config.origins.find((o) => o.alias === 'mine');
  if (existing) return existing;
  const spec: OriginSpec = {
    alias: 'mine',
    type: 'local',
    path: dir,
    description: 'Your own resources (palm create)',
  };
  ctx.config.origins.push(spec);
  await saveConfig(ctx.paths, ctx.config);
  return spec;
}
