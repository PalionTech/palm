import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  assertAliasFormat,
  expandTilde,
  Origin,
  SCP_LIKE,
  sanitizeAlias,
  stripGit,
  trimSlashes,
} from '../domain/origin.js';
import { PalmError } from './errors.js';
import type { LayoutDescriptor, OriginSpec } from './types.js';

// ---------------------------------------------------------------------------
// URL gate
// ---------------------------------------------------------------------------

const ALLOWED_SCHEMES = ['https', 'http', 'ssh', 'git', 'file'];

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Why `url` is refused before looking at its form, if it is. */
function basicUrlProblem(url: string): string | undefined {
  if (!url || url !== url.trim()) return 'empty or padded with whitespace';
  if (hasControlChars(url)) return 'contains control characters';
  if (url.startsWith('-')) return 'git would read it as an option';
  if (/^[A-Za-z0-9+.-]*::/.test(url) || /^[^/]*::/.test(url))
    return 'git transport helpers (ext::, fd::, …) are not allowed';
  return undefined;
}

/** Why a `<scheme>://…` URL is refused, if it is. */
function schemeProblem(url: string, scheme: string): string | undefined {
  if (!ALLOWED_SCHEMES.includes(scheme)) return `unsupported scheme ${scheme}://`;
  if (url.slice(scheme.length + 3).startsWith('-')) return 'host would be read as an option';
  return undefined;
}

/** Why a scp-like or bare-path URL is refused, if it is. */
function addressProblem(url: string): string | undefined {
  const scp = SCP_LIKE.exec(url);
  if (scp) {
    const [, , host = '', path = ''] = scp;
    return host.startsWith('-') || path.startsWith('-')
      ? 'host or path would be read as an option'
      : undefined;
  }
  return isAbsolute(url) ? undefined : 'not a URL git can fetch safely';
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
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  const problem =
    basicUrlProblem(url) ?? (scheme ? schemeProblem(url, scheme) : addressProblem(url));
  if (problem) {
    throw new PalmError(
      'E_ORIGIN',
      `Refusing ${where} URL "${url}": ${problem}`,
      'Use https://…, ssh://…, git@host:owner/repo.git or a local path.',
    );
  }
  return scheme === 'http' || scheme === 'git'
    ? { warning: `${where} ${url} uses an unencrypted transport (${scheme}://)` }
    : {};
}

// ---------------------------------------------------------------------------
// Origin input: a table of [test, parse] matchers
// ---------------------------------------------------------------------------

type ParsedOrigin = Omit<OriginSpec, 'alias'>;

/** One user-supplied origin: `raw` as typed, `body`/`ref` split at the last `#`. */
interface OriginInput {
  raw: string;
  body: string;
  ref?: string;
  cwd: string;
}

type Matcher = readonly [
  test: (input: OriginInput) => boolean,
  parse: (input: OriginInput) => ParsedOrigin,
];

const PREFIXED = /^(github|gitlab):(.+)$/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SHORTHAND = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+)((?:\/[^/\s]+)*)\/?$/;

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

function isExplicitPath(raw: string): boolean {
  return (
    isAbsolute(raw) ||
    raw === '.' ||
    raw === '..' ||
    raw.startsWith('./') ||
    raw.startsWith('../') ||
    raw === '~' ||
    raw.startsWith('~/')
  );
}

/** The directory `raw` names: explicit paths must exist; bare words only when such a dir exists. */
function localPathFor(raw: string, cwd: string): string | undefined {
  const abs = resolve(cwd, expandTilde(raw));
  if (!isExplicitPath(raw)) return isDir(abs) ? abs : undefined;
  if (!existsSync(abs)) throw new PalmError('E_ORIGIN', `Local origin path does not exist: ${abs}`);
  if (!isDir(abs)) {
    throw new PalmError(
      'E_ORIGIN',
      `Local origin must be a directory: ${abs}`,
      'For a marketplace.json file use `palm origin import <file>`.',
    );
  }
  return abs;
}

function withRef(spec: ParsedOrigin, ref: string | undefined): ParsedOrigin {
  return ref ? { ...spec, ref } : spec;
}

function withRoot(spec: ParsedOrigin, root: string | undefined): ParsedOrigin {
  return root ? { ...spec, root } : spec;
}

/** `owner/repo[/tree|blob/<ref>][/sub/dir]` on github.com. */
function githubSpec(owner: string, repo: string, rest: string[], ref?: string): ParsedOrigin {
  const [mode, treeRef, ...dirs] = rest;
  const tree = (mode === 'tree' || mode === 'blob') && !!treeRef;
  const root = tree ? dirs.join('/') : rest.join('/');
  const url = `https://github.com/${owner}/${stripGit(repo)}.git`;
  return withRoot(withRef({ type: 'git', url }, ref ?? (tree ? treeRef : undefined)), root);
}

function parseLocal({ raw, cwd }: OriginInput): ParsedOrigin {
  const path = localPathFor(raw, cwd) ?? resolve(cwd, expandTilde(raw));
  return isBareRepo(path) ? { type: 'git', url: path } : { type: 'local', path };
}

function parsePrefixed({ raw, body, ref }: OriginInput): ParsedOrigin {
  const [, host = '', rest = ''] = PREFIXED.exec(body) ?? [];
  const segs = trimSlashes(rest).split('/').filter(Boolean);
  const [owner, repo, ...sub] = segs;
  if (!owner || !repo) throw new PalmError('E_ORIGIN', `"${raw}" needs an owner and a repository`);
  if (host.toLowerCase() === 'github') return githubSpec(owner, repo, sub, ref);
  return withRef(
    { type: 'git', url: `https://gitlab.com/${segs.map(stripGit).join('/')}.git` },
    ref,
  );
}

/** Non-GitHub URLs: GitLab-style `/-/tree/<ref>/<dir>` is understood; anything else is the repo. */
function otherHostSpec(u: URL, body: string, segs: string[], ref?: string): ParsedOrigin {
  let url = body.replace(/\/+$/, '');
  let root: string | undefined;
  let treeRef: string | undefined;
  const dash = segs.indexOf('-');
  const mode = segs[dash + 1];
  if (dash > 0 && (mode === 'tree' || mode === 'blob') && segs[dash + 2]) {
    treeRef = segs[dash + 2];
    root = segs.slice(dash + 3).join('/');
    url = `${u.protocol}//${u.host}/${segs.slice(0, dash).join('/')}`;
  }
  if (u.hostname.toLowerCase() === 'gitlab.com' && !/\.git$/i.test(url)) url = `${url}.git`;
  return withRoot(withRef({ type: 'git', url }, ref ?? treeRef), root);
}

function parseUrl({ body, ref }: OriginInput): ParsedOrigin {
  let u: URL;
  try {
    u = new URL(body);
  } catch {
    throw new PalmError('E_ORIGIN', `Invalid origin URL "${body}"`);
  }
  if (u.protocol === 'file:') return withRef({ type: 'git', url: body }, ref);
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const host = u.hostname.toLowerCase();
  const githubWeb =
    (host === 'github.com' || host === 'www.github.com') &&
    !u.username &&
    (u.protocol === 'https:' || u.protocol === 'http:');
  if (!githubWeb) return otherHostSpec(u, body, segs, ref);
  const [owner, repo, ...rest] = segs;
  if (!owner || !repo)
    throw new PalmError('E_ORIGIN', `GitHub URL "${body}" needs an owner and a repository`);
  return githubSpec(owner, repo, rest, ref);
}

function parseScp({ body, ref }: OriginInput): ParsedOrigin {
  const [, user = '', host = '', path = ''] = SCP_LIKE.exec(body) ?? [];
  const [owner, repo, ...sub] = trimSlashes(path).split('/').filter(Boolean);
  if (host.toLowerCase() !== 'github.com' || !owner || !repo)
    return withRef({ type: 'git', url: body }, ref);
  const url = `${user}@github.com:${owner}/${stripGit(repo)}.git`;
  return withRef(withRoot({ type: 'git', url }, sub.join('/')), ref);
}

function parseShorthand({ body, ref }: OriginInput): ParsedOrigin {
  const [, owner = '', repo = '', rest = ''] = SHORTHAND.exec(body) ?? [];
  return githubSpec(owner, repo, rest.split('/').filter(Boolean), ref);
}

/** First match wins: an existing local directory, `github:`/`gitlab:`, a URL, scp-like, `owner/repo`. */
const MATCHERS: readonly Matcher[] = [
  [({ raw, cwd }) => localPathFor(raw, cwd) !== undefined, parseLocal],
  [({ body }) => PREFIXED.test(body), parsePrefixed],
  [({ body }) => URL_SCHEME.test(body), parseUrl],
  [({ body }) => SCP_LIKE.test(body), parseScp],
  [({ body }) => SHORTHAND.test(body), parseShorthand],
];

function splitInput(raw: string, cwd: string): OriginInput {
  const h = raw.lastIndexOf('#');
  if (h < 0) return { raw, body: raw, cwd };
  return { raw, body: raw.slice(0, h), ref: raw.slice(h + 1).trim() || undefined, cwd };
}

function parseLocation(input: OriginInput): ParsedOrigin {
  const matcher = MATCHERS.find(([test]) => test(input));
  if (!matcher) {
    throw new PalmError(
      'E_ORIGIN',
      `Unrecognised origin "${input.raw}"`,
      'Use owner/repo, owner/repo/sub/dir, github:owner/repo, a git URL (https:// or git@…), or a local directory path.',
    );
  }
  return matcher[1](input);
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
  const spec: OriginSpec = {
    alias: '',
    ...parseLocation(splitInput(raw, opts.cwd ?? process.cwd())),
  };
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
// Default aliases
// ---------------------------------------------------------------------------

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

/** Alias candidates, best first: root dir, repo (owner for generic repo names), qualified forms. */
function aliasCandidates(spec: OriginSpec): string[] {
  const { owner, repo } = new Origin(spec).repoParts();
  const generic = !!owner && spec.type === 'git' && GENERIC_REPO_NAMES.has(repo.toLowerCase());
  const base = generic && owner ? owner : repo;
  const last = spec.root ? trimSlashes(spec.root).split('/').pop() : undefined;
  const raw = last
    ? [last, `${base}-${last}`, owner ? `${owner}-${repo}-${last}` : undefined]
    : [base, owner ? `${owner}-${repo}` : undefined];
  const out = raw
    .filter((c): c is string => !!c)
    .map(sanitizeAlias)
    .filter(Boolean);
  return out.length ? [...new Set(out)] : ['origin'];
}

/** Default alias for an origin that does not collide with `existing` (DESIGN.md §5). */
export function deriveAlias(spec: OriginSpec, existing: readonly OriginSpec[]): string {
  const candidates = aliasCandidates(spec);
  const taken = new Set(existing.map((o) => o.alias.toLowerCase()));
  const free = candidates.find((c) => !taken.has(c));
  if (free) return free;
  const fallback = candidates[candidates.length - 1] ?? 'origin';
  for (let n = 2; ; n++) {
    const c = `${fallback}-${n}`;
    if (!taken.has(c)) return c;
  }
}
