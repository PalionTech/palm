/**
 * Git URL strings: the one validator every source URL passes (DESIGN.md section 5, "Running
 * git") and the small parsers source identity and CLI input share. Re-exported by
 * core/source-input; domain keeps it so `normalizeSource` can validate manifest URLs.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PalmError } from '../core/errors.js';

/** scp-like git address `user@host:path` (groups: user, host, path). */
export const SCP_LIKE = /^([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+):(.+)$/;

/** `<scheme>://` at the start of a string. */
export const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A GitHub repository written `owner/repo` (the manifest key form). */
export const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

export function stripGit(s: string): string {
  return s.replace(/\.git$/i, '');
}

/** `~` and `~/…` against the OS home directory (`$HOME`); anything else unchanged. */
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

/** `url` lower-cased without a trailing slash or `.git`, for "same repository" comparisons. */
export function comparableUrl(url: string): string {
  return stripGit(url.trim().replace(/\/+$/, '')).toLowerCase();
}

/** `owner/repo` when `url` is a github.com HTTPS clone URL of exactly that repository. */
export function githubRepoOf(url: string): string | undefined {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
    url,
  );
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The HTTPS clone URL of the GitHub repository `owner/repo`. */
export function githubUrl(repo: string): string {
  return `https://github.com/${stripGit(repo)}.git`;
}

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
 * The one gate for git source URLs (CLI input and palm.yaml). Allowed: `https://`, `http://`
 * (warning), `ssh://`, `git://` (warning), `file://`, scp-like `user@host:path`, and absolute
 * paths (bare repositories). Refused with E_SOURCE: anything git could read as an option
 * (leading `-`), transport helpers (`ext::`, `fd::`, any `<name>::`), other schemes and control
 * characters. Returns a warning for plain-text transports.
 */
export function validateSourceUrl(url: string, where = 'source'): { warning?: string } {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  const problem =
    basicUrlProblem(url) ?? (scheme ? schemeProblem(url, scheme) : addressProblem(url));
  if (problem) {
    throw new PalmError(
      'E_SOURCE',
      `refusing the URL "${url}" of ${where}: ${problem}`,
      'write it as https://host/owner/repo.git, ssh://git@host/owner/repo.git, git@host:owner/repo.git or a path',
    );
  }
  return scheme === 'http' || scheme === 'git'
    ? { warning: `${where} ${url} uses an unencrypted transport (${scheme}://)` }
    : {};
}
