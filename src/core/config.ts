import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { execa } from 'execa';
import { parse as parseYaml } from 'yaml';
import { PalmError } from './errors.js';
import { loadManifest, readYamlFile, saveManifest, writeYamlPreserving } from './manifest.js';
import { configPath, manifestPath } from './paths.js';
import {
  TARGET_IDS,
  type LayoutDescriptor,
  type OriginSpec,
  type PalmConfig,
  type PalmContext,
  type PalmPaths,
  type Scope,
  type TargetId,
} from './types.js';

// ---------------------------------------------------------------------------
// config.yaml
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validTargets(v: unknown): TargetId[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((t): t is TargetId => typeof t === 'string' && (TARGET_IDS as readonly string[]).includes(t));
  return out.length ? out : undefined;
}

/** Turn a stored origin entry (object or string) into a full OriginSpec. Relative local paths resolve against `baseDir`. */
function normalizeStoredOrigin(raw: unknown, baseDir: string, where: string): OriginSpec {
  if (typeof raw === 'string') return parseOriginInput(raw, { cwd: baseDir });
  if (!isObject(raw)) throw new PalmError('E_PARSE', `${where}: invalid origin entry ${JSON.stringify(raw)}`);
  const type = raw.type === 'local' || (raw.type === undefined && typeof raw.path === 'string' && !raw.url) ? 'local' : 'git';
  const spec: OriginSpec = { alias: typeof raw.alias === 'string' ? raw.alias : '', type };
  if (type === 'git') {
    if (typeof raw.url !== 'string' || !raw.url) throw new PalmError('E_PARSE', `${where}: git origin "${spec.alias}" has no url`);
    validateOriginUrl(raw.url, `${where}: origin "${spec.alias || raw.url}"`);
    spec.url = raw.url;
  } else {
    if (typeof raw.path !== 'string' || !raw.path) throw new PalmError('E_PARSE', `${where}: local origin "${spec.alias}" has no path`);
    spec.path = resolve(baseDir, expandTilde(raw.path));
  }
  if (typeof raw.ref === 'string' && raw.ref) spec.ref = raw.ref;
  if (typeof raw.root === 'string' && raw.root) spec.root = trimSlashes(raw.root);
  if (isObject(raw.layout)) spec.layout = raw.layout as LayoutDescriptor;
  if (typeof raw.description === 'string') spec.description = raw.description;
  if (!spec.alias) spec.alias = deriveAlias(spec, []);
  return spec;
}

export async function loadConfig(paths: PalmPaths): Promise<PalmConfig> {
  const file = configPath(paths);
  const data = await readYamlFile(file);
  if (data === undefined || data === null) return { origins: [] };
  if (!isObject(data)) throw new PalmError('E_PARSE', `${file} must be a YAML mapping`);
  const cfg: PalmConfig = { ...(data as object), origins: [] } as PalmConfig;
  const targets = validTargets(data.targets);
  if (targets) cfg.targets = targets;
  else delete cfg.targets;
  if (Array.isArray(data.origins)) {
    cfg.origins = data.origins.map((o) => normalizeStoredOrigin(o, paths.palmHome, file));
  }
  return cfg;
}

function serializeOrigin(spec: OriginSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['alias', 'type', 'url', 'path', 'ref', 'root', 'layout', 'description'] as const) {
    if (spec[k] !== undefined) out[k] = spec[k];
  }
  return out;
}

export async function saveConfig(paths: PalmPaths, cfg: PalmConfig): Promise<void> {
  const out: Record<string, unknown> = {};
  if (cfg.targets) out.targets = cfg.targets;
  out.origins = cfg.origins.map(serializeOrigin);
  for (const [k, v] of Object.entries(cfg)) {
    if (!(k in out) && v !== undefined && k !== 'origins' && k !== 'targets') out[k] = v;
  }
  // config.yaml is user-private (0600), like the harness configs palm writes secrets into.
  await writeYamlPreserving(configPath(paths), out, { flowKeys: ['targets'], mode: 0o600 });
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
  const spec: ParsedOrigin = { type: 'git', url: `https://github.com/${owner}/${stripGit(repo)}.git` };
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
  if ((host === 'github.com' || host === 'www.github.com') && !u.username && (u.protocol === 'https:' || u.protocol === 'http:')) {
    if (segs.length < 2) throw new PalmError('E_ORIGIN', `GitHub URL "${body}" needs an owner and a repository`);
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
    isAbsolute(raw) || raw === '.' || raw === '..' || raw.startsWith('./') || raw.startsWith('../') || raw === '~' || raw.startsWith('~/');
  const abs = resolve(cwd, expandTilde(raw));
  if (explicit) {
    if (!existsSync(abs)) {
      throw new PalmError('E_ORIGIN', `Local origin path does not exist: ${abs}`);
    }
    if (!isDir(abs)) {
      throw new PalmError('E_ORIGIN', `Local origin must be a directory: ${abs}`, 'For a marketplace.json file use `palm origin import <file>`.');
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
    new PalmError('E_ORIGIN', `Refusing ${where} URL "${url}": ${why}`, 'Use https://…, ssh://…, git@host:owner/repo.git or a local path.');
  if (!url || url !== url.trim()) throw bad('empty or padded with whitespace');
  if (/[\u0000-\u001f\u007f]/.test(url)) throw bad('contains control characters');
  if (url.startsWith('-')) throw bad('git would read it as an option');
  if (/^[A-Za-z0-9+.-]*::/.test(url) || /^[^/]*::/.test(url)) throw bad('git transport helpers (ext::, fd::, …) are not allowed');
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  if (scheme) {
    if (!['https', 'http', 'ssh', 'git', 'file'].includes(scheme)) throw bad(`unsupported scheme ${scheme}://`);
    const rest = url.slice(scheme.length + 3);
    if (rest.startsWith('-')) throw bad('host would be read as an option');
    return scheme === 'http' || scheme === 'git' ? { warning: `${where} ${url} uses an unencrypted transport (${scheme}://)` } : {};
  }
  const scp = SCP_LIKE.exec(url);
  if (scp) {
    if (scp[2]!.startsWith('-') || scp[3]!.startsWith('-')) throw bad('host or path would be read as an option');
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
      if (segs.length < 2) throw new PalmError('E_ORIGIN', `"${raw}" needs an owner and a repository`);
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
    if (u.protocol === 'file:') return { host: 'file', segs: decodeURIComponent(u.pathname).split('/').filter(Boolean) };
    return { host: u.hostname.toLowerCase() || u.protocol.replace(':', ''), segs: u.pathname.split('/').filter(Boolean).map(decodeURIComponent) };
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
    .replace(/^[-.]+|-+$/g, '');
}

/**
 * Repository names that say what a repo contains, not whose it is: `mattpocock/skills`,
 * `anthropics/skills` and `openai/skills` are told apart by their owner.
 */
const GENERIC_REPO_NAMES = new Set([
  'skills', 'agent-skills', 'claude-skills', 'plugins', 'claude-plugins', 'agents', 'subagents', 'prompts',
  'rules', 'commands', 'hooks', 'mcp', 'mcp-servers', 'extensions', 'instructions', 'dotfiles', 'config', 'configs',
]);

/** Default alias for an origin that does not collide with `existing` (DESIGN.md §5). */
export function deriveAlias(spec: OriginSpec, existing: OriginSpec[]): string {
  const { owner, repo } = repoParts(spec);
  const base = owner && spec.type === 'git' && GENERIC_REPO_NAMES.has(repo.toLowerCase()) ? owner : repo;
  const last = spec.root ? trimSlashes(spec.root).split('/').pop() : undefined;
  const raw = last
    ? [last, `${base}-${last}`, owner ? `${owner}-${repo}-${last}` : undefined]
    : [base, owner ? `${owner}-${repo}` : undefined];
  const candidates = [...new Set(raw.filter((c): c is string => !!c).map(sanitizeAlias).filter(Boolean))];
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
    ctx.log.warn(`Ignoring origins in ${file}: ${(e as Error).message}`);
    return [];
  }
  if (!isObject(data) || !Array.isArray(data.origins)) return [];
  const out: OriginSpec[] = [];
  for (const raw of data.origins) {
    try {
      out.push(normalizeStoredOrigin(raw, ctx.paths.projectRoot, file));
    } catch (e) {
      ctx.log.warn((e as Error).message);
    }
  }
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

export async function addOrigin(ctx: PalmContext, spec: OriginSpec, opts: { scope?: Scope } = {}): Promise<OriginSpec> {
  const scope = opts.scope ?? 'global';
  const all = allOrigins(ctx);
  let next = { ...spec };
  const clash = all.find((o) => o.alias.toLowerCase() === next.alias.toLowerCase());
  const replacing = !!clash && originId(clash) === originId(next);
  if (clash && !replacing) {
    if (next.alias === deriveAlias(next, [])) {
      next.alias = deriveAlias(next, all);
    } else {
      throw new PalmError(
        'E_ORIGIN',
        `Origin alias "${next.alias}" is already used by ${describeOrigin(clash)}`,
        'Pick another alias with --alias <name>, or remove the existing one with `palm origin remove`.',
      );
    }
  }

  if (scope === 'global') {
    const idx = ctx.config.origins.findIndex((o) => o.alias.toLowerCase() === next.alias.toLowerCase());
    if (idx >= 0) ctx.config.origins[idx] = next;
    else ctx.config.origins.push(next);
    await saveConfig(ctx.paths, ctx.config);
  } else {
    const file = manifestPath(ctx.paths, 'project');
    const m = await loadManifest(file);
    const origins = [...(m.origins ?? [])];
    const idx = origins.findIndex((o) => {
      try {
        return normalizeStoredOrigin(o, ctx.paths.projectRoot, file).alias.toLowerCase() === next.alias.toLowerCase();
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
  if (!removed) throw new PalmError('E_NOT_FOUND', `No origin with alias "${alias}"`, 'See `palm origin list`.');
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
  const spec: OriginSpec = { alias: 'mine', type: 'local', path: dir, description: 'Your own resources (palm create)' };
  ctx.config.origins.push(spec);
  await saveConfig(ctx.paths, ctx.config);
  return spec;
}
