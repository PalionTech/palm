import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';
import { type CheckoutSlot, Origin } from '../domain/origin.js';
import { errnoCode, isEnoent, readJsonFile, writeJsonFile } from '../lib/fs.js';
import { messageOf, PalmError } from './errors.js';
import { validateOriginUrl } from './origin-input.js';
import { cacheDir } from './paths.js';
import type { OriginCheckout, OriginSpec, PalmContext } from './types.js';

/** Never let git block on a credential prompt: private repos fail fast. */
const GIT_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

const NETWORK_PATTERNS = [
  /could not resolve host/i,
  /unable to access/i,
  /network is unreachable/i,
  /connection (timed out|refused)/i,
];

class GitFailure extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

/** Local repositories (bare repo paths, file:// URLs) are the only ones allowed to use git's file transport. */
function isLocalRepoUrl(url: string | undefined): boolean {
  return !!url && (url.startsWith('/') || /^file:\/\//i.test(url));
}

/**
 * Run git with transport hardening: `ext::`/`fd::` helpers are never allowed and the file
 * transport only for local origins (`url`), so a hostile config or submodule cannot make git
 * execute commands or read local repositories.
 */
async function git(args: string[], cwd?: string, url?: string, timeout?: number): Promise<string> {
  const hardening = [
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'protocol.fd.allow=never',
    '-c',
    `protocol.file.allow=${isLocalRepoUrl(url) ? 'user' : 'never'}`,
  ];
  try {
    const r = await execa('git', [...hardening, ...args], {
      cwd,
      env: GIT_ENV,
      stdin: 'ignore',
      ...(timeout ? { timeout } : {}),
    });
    return r.stdout;
  } catch (e) {
    if (isEnoent(e))
      throw new PalmError('E_GIT', 'git is not installed or not on PATH', 'Install git and retry.');
    const err = e as { stderr?: unknown; shortMessage?: string; message: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    const detail =
      stderr
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('hint:'))
        .slice(-3)
        .join(' | ') ||
      err.shortMessage ||
      err.message;
    throw new GitFailure(
      `git ${args.find((a) => !a.startsWith('-')) ?? args[0]} failed: ${detail}`,
      detail,
    );
  }
}

function toPalmError(e: unknown, what: string, url: string): PalmError {
  if (e instanceof PalmError) return e;
  const detail = e instanceof GitFailure ? e.detail : messageOf(e);
  if (NETWORK_PATTERNS.some((p) => p.test(detail))) {
    return new PalmError(
      'E_NETWORK',
      `${what} ${url}: ${detail}`,
      'Check your network connection, or use --offline to work from the cache.',
    );
  }
  return new PalmError(
    'E_GIT',
    `${what} ${url}: ${detail}`,
    'Check the URL and ref. Private repositories need credentials configured for git (ssh key or credential helper).',
  );
}

// ---------------------------------------------------------------------------
// Tags and refs
// ---------------------------------------------------------------------------

/** Refuse unsafe URLs (see validateOriginUrl), refs git would parse as options, and roots that escape the checkout. */
function assertSafeSpec(spec: { alias?: string; url?: string; ref?: string; root?: string }): void {
  const bad = (what: string, v: string): PalmError =>
    new PalmError(
      'E_ORIGIN',
      `Invalid ${what} "${v}"${spec.alias ? ` for origin "${spec.alias}"` : ''}`,
    );
  if (spec.url !== undefined)
    validateOriginUrl(spec.url, spec.alias ? `origin "${spec.alias}"` : 'origin');
  if (spec.ref?.startsWith('-')) throw bad('ref', spec.ref);
  if (spec.root && (spec.root.split(/[\\/]+/).includes('..') || spec.root.startsWith('/')))
    throw bad('root', spec.root);
}

export async function listRemoteTags(url: string): Promise<string[]> {
  assertSafeSpec({ url });
  let out: string;
  try {
    out = await git(['ls-remote', '--tags', '--refs', '--', url], undefined, url);
  } catch (e) {
    throw toPalmError(e, 'Cannot list tags of', url);
  }
  const tags: string[] = [];
  for (const line of out.split('\n')) {
    const ref = line.split('\t')[1];
    if (ref?.startsWith('refs/tags/')) tags.push(ref.slice('refs/tags/'.length));
  }
  return tags;
}

async function remoteDefaultBranch(url: string): Promise<string | undefined> {
  try {
    const out = await git(['ls-remote', '--symref', '--', url, 'HEAD'], undefined, url);
    const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(out);
    return m?.[1];
  } catch (e) {
    throw toPalmError(e, 'Cannot read default branch of', url);
  }
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(tag: string): SemVer | undefined {
  const m = SEMVER.exec(tag);
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

/** One prerelease identifier: numeric ones numerically and below alphanumeric ones. */
function comparePreId(x: string, y: string): number {
  const nx = /^\d+$/.test(x);
  const ny = /^\d+$/.test(y);
  if (nx && ny) return Number(x) - Number(y);
  if (nx !== ny) return nx ? -1 : 1;
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

function comparePre(a: string[], b: string[]): number {
  if (!a.length || !b.length) return Math.sign(b.length - a.length); // release > prerelease
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const d = comparePreId(x, y);
    if (d) return d;
  }
  return 0;
}

function compareSemver(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePre(a.pre, b.pre);
}

/** Highest semver tag (`v1.2.3` or `1.2.3`). Prereleases only count when there is no release. */
export function latestSemverTag(tags: string[]): string | undefined {
  const parsed = tags
    .map((t) => ({ t, v: parseSemver(t) }))
    .filter((x): x is { t: string; v: SemVer } => !!x.v);
  const releases = parsed.filter((x) => x.v.pre.length === 0);
  const pool = releases.length ? releases : parsed;
  let best: { t: string; v: SemVer } | undefined;
  for (const x of pool) if (!best || compareSemver(x.v, best.v) > 0) best = x;
  return best?.t;
}

// ---------------------------------------------------------------------------
// Checkout lock: one fetch per checkout slot across palm processes
// ---------------------------------------------------------------------------

/** A lock whose mtime is older than this is abandoned, whoever holds it. */
const LOCK_STALE_MS = 10 * 60_000;
/** How often a holder refreshes its lock's mtime. */
const LOCK_HEARTBEAT_MS = 60_000;
/** How long a fetch waits for another palm process before giving up. */
const LOCK_TIMEOUT_MS = 60_000;

interface LockInfo {
  pid: number;
  host: string;
  createdAt: string;
}

export interface CheckoutLockOptions {
  /** Give up after this long (default 60 s). */
  timeoutMs?: number;
  /** Treat a lock untouched for this long as abandoned (default 10 min). */
  staleMs?: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoCode(e) === 'EPERM';
  }
}

function parseLockInfo(text: string): Partial<LockInfo> {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Partial<LockInfo>) : {};
  } catch {
    return {}; // being written right now, or garbage: judged by its mtime
  }
}

/** Creates `file` exclusively (O_EXCL) and returns what it wrote; undefined when it exists. */
async function tryCreateLock(file: string): Promise<LockInfo | undefined> {
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    createdAt: new Date().toISOString(),
  };
  try {
    await writeFile(file, `${JSON.stringify(info)}\n`, { flag: 'wx' });
    return info;
  } catch (e) {
    if (errnoCode(e) === 'EEXIST') return undefined;
    throw e;
  }
}

/**
 * The current holder of `file`, or undefined when the lock is gone, untouched for `staleMs`
 * (holders refresh its mtime while they work), or held by a process of this host that no longer
 * runs (a palm killed mid-fetch). Such a lock is removed.
 */
async function liveHolder(file: string, staleMs: number): Promise<Partial<LockInfo> | undefined> {
  let text: string;
  let mtimeMs: number;
  try {
    [text, { mtimeMs }] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
  } catch (e) {
    if (isEnoent(e)) return undefined;
    throw e;
  }
  const info = parseLockInfo(text);
  const dead = info.host === hostname() && typeof info.pid === 'number' && !processAlive(info.pid);
  if (!dead && Date.now() - mtimeMs <= staleMs) return info;
  await rm(file, { force: true });
  return undefined;
}

function lockTimeout(file: string, holder: Partial<LockInfo>, timeoutMs: number): PalmError {
  const by = holder.pid
    ? ` (held by pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ''})`
    : '';
  return new PalmError(
    'E_IO',
    `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for the checkout lock ${file}${by}`,
    `Another palm process is fetching this origin; retry when it is done. If none is running, delete ${file}.`,
  );
}

async function acquireLock(file: string, opts: CheckoutLockOptions): Promise<LockInfo> {
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(file), { recursive: true });
  for (let delay = 25; ; delay = Math.min(delay * 2, 1000)) {
    const mine = await tryCreateLock(file);
    if (mine) return mine;
    const holder = await liveHolder(file, opts.staleMs ?? LOCK_STALE_MS);
    if (holder && Date.now() >= deadline) throw lockTimeout(file, holder, timeoutMs);
    if (holder) await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
  }
}

/** Removes `file` if it is still the lock described by `mine` (it was not taken over as stale). */
async function releaseLock(file: string, mine: LockInfo): Promise<void> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const now = parseLockInfo(text);
  if (now.pid === mine.pid && now.createdAt === mine.createdAt) await rm(file, { force: true });
}

/**
 * Runs `fn` holding the advisory lock `file` (`<checkout slot>.lock`: pid, host and timestamp,
 * created with O_EXCL, its mtime refreshed every minute while `fn` runs). Waits with backoff while
 * another process holds it (default up to 60 s, then E_IO with a hint); a lock untouched for
 * 10 min, or held by a dead process on this host, is taken over.
 */
export async function withCheckoutLock<T>(
  file: string,
  fn: () => Promise<T>,
  opts: CheckoutLockOptions = {},
): Promise<T> {
  const mine = await acquireLock(file, opts);
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(file, now, now).catch(() => undefined);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await releaseLock(file, mine);
  }
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

interface CheckoutMeta {
  url: string;
  /** Ref actually checked out (tag, branch or sha); absent when the remote HEAD was cloned. */
  ref?: string;
  /** Ref that was requested by the origin spec; null = "latest". */
  requested: string | null;
  sha: string;
  fetchedAt: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
const SHORT_SHA = /^[0-9a-f]{7,39}$/i;

async function fetchSha(url: string, dir: string, sha: string): Promise<void> {
  try {
    await git(['fetch', '--depth', '1', 'origin', '--', sha], dir, url);
    await git(
      ['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', 'FETCH_HEAD'],
      dir,
      url,
    );
  } catch {
    // Servers that refuse unadvertised shas: fall back to a full fetch.
    await git(['fetch', '--tags', 'origin'], dir, url);
    await git(
      ['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', sha],
      dir,
      url,
    );
  }
}

async function freshClone(url: string, dir: string, ref: string | undefined): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  if (ref && FULL_SHA.test(ref)) {
    await git(['init', '-q', '--', dir]);
    await git(['remote', 'add', '--', 'origin', url], dir, url);
    await fetchSha(url, dir, ref);
    return;
  }
  const args = ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  try {
    await git([...args, '--', url, dir], undefined, url);
  } catch (e) {
    if (!ref || !SHORT_SHA.test(ref)) throw e;
    await rm(dir, { recursive: true, force: true });
    await git(['clone', '--quiet', '--', url, dir], undefined, url);
    await git(
      ['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', ref],
      dir,
      url,
    );
  }
}

async function updateCheckout(url: string, dir: string, ref: string | undefined): Promise<void> {
  await git(['remote', 'set-url', '--', 'origin', url], dir, url);
  if (ref && FULL_SHA.test(ref)) {
    await fetchSha(url, dir, ref);
  } else {
    await git(['fetch', '--quiet', '--depth', '1', 'origin', '--', ref ?? 'HEAD'], dir, url);
    await git(
      ['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', 'FETCH_HEAD'],
      dir,
      url,
    );
  }
  await git(['clean', '-ffdxq'], dir, url);
}

/** `git ls-remote --exit-code <url> HEAD` through the validator and the hardened wrapper (used by `palm doctor`). */
export async function pingRemote(url: string): Promise<void> {
  validateOriginUrl(url);
  try {
    await git(['ls-remote', '--exit-code', '--', url, 'HEAD'], undefined, url, 20_000);
  } catch (e) {
    throw toPalmError(e, 'Cannot reach', url);
  }
}

/** The ref to check out when the spec pins none: latest semver tag, else the default branch. */
async function resolveLatestRef(url: string): Promise<string | undefined> {
  const tag = latestSemverTag(await listRemoteTags(url));
  return tag ?? (await remoteDefaultBranch(url));
}

/** One git origin being made available in its checkout slot. */
interface CheckoutJob {
  origin: Origin;
  url: string;
  slot: CheckoutSlot;
  /** `spec.ref`, or null for "latest". */
  requested: string | null;
}

function checkoutResult(job: CheckoutJob, meta: CheckoutMeta): OriginCheckout {
  const { spec } = job.origin;
  const { repoDir } = job.slot;
  const out: OriginCheckout = {
    spec,
    originId: job.origin.id,
    root: spec.root ? join(repoDir, spec.root) : repoDir,
    repoDir,
    sha: meta.sha,
    fetchedAt: meta.fetchedAt,
  };
  if (meta.ref) out.ref = meta.ref;
  return out;
}

/** The slot's checkout metadata; an unreadable or corrupt checkout.json means "no usable checkout". */
async function readMeta(slot: CheckoutSlot): Promise<CheckoutMeta | undefined> {
  if (!existsSync(join(slot.repoDir, '.git'))) return undefined;
  return readJsonFile<CheckoutMeta>(slot.metaFile).catch(() => undefined);
}

/** --offline: the cached checkout if it holds the requested ref, else E_NETWORK. */
async function offlineCheckout(ctx: PalmContext, job: CheckoutJob): Promise<OriginCheckout> {
  const meta = await readMeta(job.slot);
  const want = job.origin.spec.ref;
  const usable =
    meta?.url === job.url &&
    (!want ||
      meta.ref === want ||
      meta.requested === want ||
      meta.sha.startsWith(want.toLowerCase()));
  if (!usable) {
    throw new PalmError(
      'E_NETWORK',
      `Origin "${job.origin.alias}"${want ? ` at ${want}` : ''} is not in the cache and --offline is set`,
      'Run the command once without --offline to fetch it.',
    );
  }
  if (meta.requested !== job.requested)
    ctx.log.debug(
      `offline: using cached checkout of ${job.origin.alias} at ${meta.ref ?? meta.sha}`,
    );
  return checkoutResult(job, meta);
}

/**
 * Clones or updates the slot at the wanted ref and records it. The old metadata is removed first,
 * so a fetch that dies half-way leaves "no usable checkout" rather than a stale sha; the new one
 * is written atomically once the work tree is complete.
 */
async function fetchInto(ctx: PalmContext, job: CheckoutJob, have: boolean): Promise<CheckoutMeta> {
  const { url, slot, requested } = job;
  const wanted = requested ?? (await resolveLatestRef(url));
  ctx.log.debug(`fetching ${url}${wanted ? `#${wanted}` : ''}`);
  await rm(slot.metaFile, { force: true });
  if (have) {
    try {
      await updateCheckout(url, slot.repoDir, wanted);
    } catch (e) {
      ctx.log.debug(`update of cached ${job.origin.alias} failed (${messageOf(e)}); re-cloning`);
      await freshClone(url, slot.repoDir, wanted);
    }
  } else {
    await freshClone(url, slot.repoDir, wanted);
  }
  const sha = (await git(['rev-parse', 'HEAD'], slot.repoDir, url)).trim();
  const next: CheckoutMeta = { url, requested, sha, fetchedAt: new Date().toISOString() };
  if (wanted) next.ref = wanted;
  await writeJsonFile(slot.metaFile, next);
  return next;
}

/**
 * Under the slot lock: reuse the checkout when it holds the requested ref (another process or
 * alias fetched it while this call waited; with `refresh`, only when that fetch finished after
 * this call started), else fetch.
 */
async function lockedCheckout(
  ctx: PalmContext,
  job: CheckoutJob,
  opts: { refresh?: boolean; since: number },
): Promise<OriginCheckout> {
  const meta = await readMeta(job.slot);
  const have = meta?.url === job.url;
  const current = have && meta.requested === job.requested;
  if (current && (!opts.refresh || Date.parse(meta.fetchedAt) > opts.since))
    return checkoutResult(job, meta);
  try {
    return checkoutResult(job, await fetchInto(ctx, job, have));
  } catch (e) {
    throw toPalmError(e, `Cannot fetch origin "${job.origin.alias}" from`, job.url);
  }
}

/**
 * A cache hit (the slot holds the requested ref) is read without the lock or the network, as is
 * everything under --offline; anything that fetches runs under the slot lock.
 */
async function gitCheckout(
  ctx: PalmContext,
  job: CheckoutJob,
  refresh: boolean | undefined,
): Promise<OriginCheckout> {
  if (ctx.flags.offline) return offlineCheckout(ctx, job);
  const since = Date.now();
  if (!refresh) {
    const meta = await readMeta(job.slot);
    if (meta?.url === job.url && meta.requested === job.requested) return checkoutResult(job, meta);
  }
  return withCheckoutLock(job.slot.lockFile, () => lockedCheckout(ctx, job, { refresh, since }));
}

function localCheckout(origin: Origin): OriginCheckout {
  const { spec } = origin;
  if (!spec.path) throw new PalmError('E_ORIGIN', `Local origin "${spec.alias}" has no path`);
  const root = spec.root ? join(spec.path, spec.root) : spec.path;
  if (!existsSync(root)) {
    throw new PalmError(
      'E_ORIGIN',
      `Local origin "${spec.alias}" not found at ${root}`,
      `Fix or remove it: palm origin remove ${spec.alias}`,
    );
  }
  return {
    spec,
    originId: origin.id,
    root,
    repoDir: spec.path,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Make an origin available on disk. Local origins are used in place; git origins are cloned into
 * their checkout slot `<palmHome>/cache/<originId>/{repo|ref-<ref>}` (Origin.checkoutSlot) at the
 * wanted ref. Aliases of one repo + root + ref share the slot, and a per-slot lock file keeps two
 * palm processes (or two aliases in one) from fetching into it at the same time (gitCheckout).
 */
export async function fetchOrigin(
  ctx: PalmContext,
  spec: OriginSpec,
  opts: { refresh?: boolean } = {},
): Promise<OriginCheckout> {
  assertSafeSpec(spec);
  const origin = new Origin(spec);
  if (origin.isLocal) return localCheckout(origin);
  const url = spec.url;
  if (!url) throw new PalmError('E_ORIGIN', `Git origin "${spec.alias}" has no url`);
  const job: CheckoutJob = {
    origin,
    url,
    slot: origin.checkoutSlot(cacheDir(ctx.paths)),
    requested: spec.ref ?? null,
  };
  const result = await gitCheckout(ctx, job, opts.refresh);
  if (spec.root && !existsSync(result.root)) {
    throw new PalmError(
      'E_ORIGIN',
      `Subdirectory "${spec.root}" not found in ${url}${result.ref ? `@${result.ref}` : ''}`,
    );
  }
  return result;
}
