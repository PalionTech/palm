/**
 * The one way palm runs git: a clean environment (nothing that redirects git to another
 * repository, index or config leaks in from the caller), transport hardening, credential
 * helpers and ssh that never prompt, and a timeout on every call.
 */
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { isEnoent } from '../lib/fs.js';
import { PalmError } from './errors.js';

/** ls-remote, clone and fetch. */
export const NETWORK_TIMEOUT_MS = 120_000;
/** Every other git call (init, checkout, clean, rev-parse, config). */
export const LOCAL_TIMEOUT_MS = 30_000;

/**
 * The caller's variables git may see: locale, identity and home (for the user's global config
 * and credential helpers), ssh agent, temp dir, proxies and CA bundles, and the user's own ssh
 * command and global-config choice. Everything else is dropped.
 */
const KEEP_ENV: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'SSH_AUTH_SOCK',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
const KEEP_ENV_PREFIXES = ['LC_'];

/**
 * Variables that would point git at another repository, index, object store or config (a palm
 * run from a git hook inherits several of them). Never passed on; listed for documentation and
 * tests, the allow list above is what enforces it.
 */
export const DROPPED_GIT_ENV: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_<n>',
  'GIT_CONFIG_VALUE_<n>',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
];

const BATCH_MODE = '-o BatchMode=yes';

/**
 * `cmd` with `-o BatchMode=yes` appended when it runs OpenSSH (first word `ssh`) and does not set
 * BatchMode already. Other programs (plink, wrapper scripts) are left as the user wrote them.
 */
export function withBatchMode(cmd: string): string {
  if (/batchmode/i.test(cmd)) return cmd;
  const program = cmd.trim().split(/\s+/)[0] ?? '';
  return /(^|\/)ssh(\.exe)?$/i.test(program) ? `${cmd.trimEnd()} ${BATCH_MODE}` : cmd;
}

/** The environment every git call runs with, built from `source` (default `process.env`). */
export function cleanGitEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (KEEP_ENV.has(name) || KEEP_ENV_PREFIXES.some((p) => name.startsWith(p))) env[name] = value;
  }
  if (env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = withBatchMode(env.GIT_SSH_COMMAND);
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

/** Local repositories (bare repo paths, file:// URLs) are the only ones allowed to use git's file transport. */
function isLocalRepoUrl(url: string | undefined): boolean {
  return !!url && (url.startsWith('/') || /^file:\/\//i.test(url));
}

/** `ssh://…`, `git+ssh://…` or scp-like `user@host:path`. */
export function isSshUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (/^(git\+)?ssh:\/\//i.test(url)) return true;
  return !url.includes('://') && !url.startsWith('/') && /^[^/]+:/.test(url);
}

const configuredSsh = new Map<string, Promise<string | undefined>>();

/** The user's global `core.sshCommand` (read once per home and config file). */
function configuredSshCommand(env: Record<string, string>): Promise<string | undefined> {
  const key = [env.HOME, env.XDG_CONFIG_HOME, env.GIT_CONFIG_GLOBAL].join('\0');
  let found = configuredSsh.get(key);
  if (!found) {
    found = execa('git', ['config', '--global', '--get', 'core.sshCommand'], {
      cwd: tmpdir(),
      env,
      extendEnv: false,
      stdin: 'ignore',
      reject: false,
      timeout: LOCAL_TIMEOUT_MS,
    })
      .then((r) => (r.exitCode === 0 && r.stdout.trim()) || undefined)
      .catch(() => undefined);
    configuredSsh.set(key, found);
  }
  return found;
}

/**
 * For an ssh remote, the `core.sshCommand` palm sets: the user's own (or plain `ssh`) with
 * BatchMode, so a missing key or unknown host fails instead of prompting. Nothing when the user
 * set `GIT_SSH_COMMAND` (it gets BatchMode in cleanGitEnv) or `GIT_SSH` (a program that takes no
 * options, left alone).
 */
async function sshCommandFor(
  url: string | undefined,
  env: Record<string, string>,
): Promise<string | undefined> {
  if (!isSshUrl(url) || env.GIT_SSH_COMMAND || env.GIT_SSH) return undefined;
  return withBatchMode((await configuredSshCommand(env)) ?? 'ssh');
}

export interface GitCall {
  cwd?: string;
  /** The remote this call talks to (or a local repo path): decides the file transport and ssh. */
  url?: string;
  /** ls-remote, clone, fetch: 120 s timeout and E_NETWORK when it expires. */
  network?: boolean;
  /** Overrides the timeout (`palm doctor` pings with 20 s). */
  timeoutMs?: number;
}

/**
 * The full argument list for `git <args>`: `ext::`/`fd::` transports never allowed and the file
 * transport only for local origins, so a hostile config or submodule cannot make git execute
 * commands or read local repositories; credential helpers told not to prompt; ssh in batch mode.
 */
export async function gitArgs(
  args: readonly string[],
  call: GitCall,
  env: Record<string, string>,
): Promise<string[]> {
  const hardening = [
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'protocol.fd.allow=never',
    '-c',
    `protocol.file.allow=${isLocalRepoUrl(call.url) ? 'user' : 'never'}`,
    '-c',
    'credential.interactive=false',
  ];
  const ssh = await sshCommandFor(call.url, env);
  if (ssh) hardening.push('-c', `core.sshCommand=${ssh}`);
  return [...hardening, ...args];
}

/** A git call that failed; `detail` is git's last stderr lines, `timedOutMs` set when it was killed. */
export class GitFailure extends Error {
  constructor(
    message: string,
    readonly detail: string,
    readonly opts: { network: boolean; timedOutMs?: number } = { network: false },
  ) {
    super(message);
  }
}

export function isGitTimeout(e: unknown): boolean {
  return e instanceof GitFailure && e.opts.timedOutMs !== undefined;
}

function stderrDetail(err: { stderr?: unknown; shortMessage?: string; message: string }): string {
  const stderr = typeof err.stderr === 'string' ? err.stderr : '';
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:'))
    .slice(-3);
  return lines.join(' | ') || err.shortMessage || err.message;
}

function seconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

function failure(e: unknown, args: readonly string[], call: GitCall, timeout: number): Error {
  if (isEnoent(e))
    return new PalmError('E_GIT', 'git is not installed or not on PATH', 'Install git and retry.');
  const err = e as { stderr?: unknown; shortMessage?: string; message: string; timedOut?: boolean };
  const sub = args.find((a) => !a.startsWith('-')) ?? args[0];
  const network = Boolean(call.network);
  if (err.timedOut) {
    const detail = `git ${sub} timed out after ${seconds(timeout)}`;
    return new GitFailure(detail, detail, { network, timedOutMs: timeout });
  }
  const detail = stderrDetail(err);
  return new GitFailure(`git ${sub} failed: ${detail}`, detail, { network });
}

/** Runs `git <args>` hardened (see gitArgs) with cleanGitEnv(process.env); resolves to stdout. */
export async function runGit(args: readonly string[], call: GitCall = {}): Promise<string> {
  const env = cleanGitEnv(process.env);
  const timeout = call.timeoutMs ?? (call.network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS);
  try {
    const r = await execa('git', await gitArgs(args, call, env), {
      cwd: call.cwd,
      env,
      extendEnv: false,
      stdin: 'ignore',
      timeout,
    });
    return r.stdout;
  } catch (e) {
    throw failure(e, args, call, timeout);
  }
}
