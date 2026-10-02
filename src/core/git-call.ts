/** Calling git for sources: the hardened runner (git-exec.ts) plus palm's error mapping. */
import { messageOf, PalmError } from './errors.js';
import { type GitCall, GitFailure, isGitTimeout, runGit } from './git-exec.js';

const NETWORK_PATTERNS = [
  /could not resolve host/i,
  /unable to access/i,
  /network is unreachable/i,
  /connection (timed out|refused)/i,
];

/** `git <args>` through the hardened runner: clean env, no prompts, timeouts. */
export function git(args: string[], call: GitCall = {}): Promise<string> {
  return runGit(args, call);
}

/** Talks to `url`: ls-remote, clone, fetch (120 s timeout). */
export function remote(url: string, cwd?: string): GitCall {
  return { url, cwd, network: true };
}

/** A local step in the checkout `cwd` of `url` (30 s timeout). */
export function local(url: string, cwd: string): GitCall {
  return { url, cwd };
}

function timeoutError(e: GitFailure, what: string, url: string): PalmError {
  const message = `${what} ${url}: ${e.detail}`;
  if (e.opts.network)
    return new PalmError(
      'E_NETWORK',
      message,
      `the remote did not answer in time; check the network, VPN or proxy, then try: git ls-remote ${url}`,
    );
  return new PalmError(
    'E_GIT',
    message,
    'a local git step hung; clear the checkouts with: palm cache clean',
  );
}

/**
 * What git says for a repository that does not exist or needs credentials palm does not pass
 * (GitHub answers a missing repository with a password prompt, which palm disables).
 */
const MISSING_PATTERNS = [
  /could not read (Username|Password)/i,
  /unable to get password/i,
  /terminal prompts disabled/i,
  /repository .*not found/i,
  /authentication failed/i,
  /does not appear to be a git repository/i,
  /could not read from remote repository/i,
];

/** "repository not found or private": git's own words stay out (PALM_DEBUG shows them). */
function missingRepository(url: string): PalmError {
  return new PalmError(
    'E_SOURCE',
    `repository not found or private: ${url}`,
    `check the name, then try: git ls-remote ${url}`,
  );
}

/**
 * A git failure as a PalmError: E_NETWORK for timeouts and unreachable hosts, E_SOURCE for a
 * repository that is missing or private, else E_GIT.
 */
export function toPalmError(e: unknown, what: string, url: string): PalmError {
  if (e instanceof PalmError) return e;
  if (e instanceof GitFailure && isGitTimeout(e)) return timeoutError(e, what, url);
  const detail = e instanceof GitFailure ? e.detail : messageOf(e);
  if (MISSING_PATTERNS.some((p) => p.test(detail))) return missingRepository(url);
  if (NETWORK_PATTERNS.some((p) => p.test(detail))) {
    return new PalmError(
      'E_NETWORK',
      `${what} ${url}: ${detail}`,
      'check your network connection, or run the command again with --offline to use the cache',
    );
  }
  return new PalmError(
    'E_GIT',
    `${what} ${url}: ${detail}`,
    `check the URL and ref (git ls-remote ${url}); private repositories need git credentials (an ssh key or a credential helper)`,
  );
}

/** A failure a retry cannot fix (timeout, git missing): never worth a second clone. */
export function isFinal(e: unknown): boolean {
  return e instanceof PalmError || isGitTimeout(e);
}
