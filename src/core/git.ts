import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gt, lt, minVersion, prerelease, rcompare, satisfies, valid, validRange } from 'semver';
import { type CheckoutSlot, Origin } from '../domain/origin.js';
import { errnoCode, isEnoent, readJsonFile, writeJsonFile } from '../lib/fs.js';
import { messageOf, PalmError } from './errors.js';
import { type GitCall, GitFailure, isGitTimeout, runGit } from './git-exec.js';
import { validateOriginUrl } from './origin-input.js';
import { cacheDir } from './paths.js';
import type { OriginCheckout, OriginSpec, PalmContext } from './types.js';

const NETWORK_PATTERNS = [
  /could not resolve host/i,
  /unable to access/i,
  /network is unreachable/i,
  /connection (timed out|refused)/i,
];

/** `git <args>` through the hardened runner (git-exec.ts): clean env, no prompts, timeouts. */
function git(args: string[], call: GitCall = {}): Promise<string> {
  return runGit(args, call);
}

/** Talks to `url`: ls-remote, clone, fetch (120 s timeout). */
function remote(url: string, cwd?: string): GitCall {
  return { url, cwd, network: true };
}

/** A local step in the checkout `cwd` of `url` (30 s timeout). */
function local(url: string, cwd: string): GitCall {
  return { url, cwd };
}

function timeoutError(e: GitFailure, what: string, url: string): PalmError {
  const message = `${what} ${url}: ${e.detail}`;
  if (e.opts.network)
    return new PalmError(
      'E_NETWORK',
      message,
      `The remote did not answer in time. Check your network, VPN or proxy, then retry: git ls-remote ${url}`,
    );
  return new PalmError(
    'E_GIT',
    message,
    'A local git step hung. Retry; if it keeps hanging, clear the checkouts with: palm cache clean',
  );
}

function toPalmError(e: unknown, what: string, url: string): PalmError {
  if (e instanceof PalmError) return e;
  if (e instanceof GitFailure && isGitTimeout(e)) return timeoutError(e, what, url);
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

/** A failure a retry cannot fix (timeout, git missing): never worth a second clone. */
function isFinal(e: unknown): boolean {
  return e instanceof PalmError || isGitTimeout(e);
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

interface RemoteRefList {
  tags: string[];
  heads: string[];
  /** Branch → the commit it points at (what ls-remote prints next to it). */
  headShas: Record<string, string>;
  /** Tag → the commit it names (annotated tags peeled). */
  tagShas: Record<string, string>;
}

/** One `git ls-remote` line into `refs` (`<sha>\t<ref>`; `^{}` lines peel annotated tags). */
function addRemoteRef(refs: RemoteRefList, line: string): void {
  const [sha = '', ref = ''] = line.split('\t');
  if (ref.startsWith('refs/heads/')) {
    const head = ref.slice('refs/heads/'.length);
    refs.heads.push(head);
    refs.headShas[head] = sha;
    return;
  }
  if (!ref.startsWith('refs/tags/')) return;
  const name = ref.slice('refs/tags/'.length);
  if (name.endsWith('^{}')) {
    refs.tagShas[name.slice(0, -3)] = sha; // the commit behind an annotated tag
    return;
  }
  refs.tags.push(name);
  refs.tagShas[name] ??= sha;
}

/** Branch and tag names of a remote with their commits (`git ls-remote --tags --heads`). */
export async function listRemoteRefs(url: string): Promise<RemoteRefList> {
  assertSafeSpec({ url });
  let out: string;
  try {
    out = await git(['ls-remote', '--tags', '--heads', '--', url], remote(url));
  } catch (e) {
    throw toPalmError(e, 'Cannot list tags of', url);
  }
  const refs: RemoteRefList = { tags: [], heads: [], headShas: {}, tagShas: {} };
  for (const line of out.split('\n')) addRemoteRef(refs, line);
  return refs;
}

export async function listRemoteTags(url: string): Promise<string[]> {
  return (await listRemoteRefs(url)).tags;
}

async function remoteDefaultBranch(url: string): Promise<string | undefined> {
  try {
    const out = await git(['ls-remote', '--symref', '--', url, 'HEAD'], remote(url));
    const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(out);
    return m?.[1];
  } catch (e) {
    throw toPalmError(e, 'Cannot read default branch of', url);
  }
}

interface TagVersion {
  tag: string;
  version: string;
}

/** Tags that name a semver version (`v1.2.3` or `1.2.3`, prereleases and build metadata allowed). */
function tagVersions(tags: readonly string[]): TagVersion[] {
  return tags.flatMap((tag) => {
    const version = /^v?\d/.test(tag) ? valid(tag) : null;
    return version ? [{ tag, version }] : [];
  });
}

/** The highest version; on a tie (`1.0.0` and `1.0.0+build`) the first listed wins. */
function highest(list: readonly TagVersion[]): TagVersion | undefined {
  let best: TagVersion | undefined;
  for (const x of list) if (!best || gt(x.version, best.version)) best = x;
  return best;
}

/** Highest semver tag (`v1.2.3` or `1.2.3`). Prereleases only count when there is no release. */
export function latestSemverTag(tags: string[]): string | undefined {
  const all = tagVersions(tags);
  const releases = all.filter((x) => prerelease(x.version) === null);
  return highest(releases.length ? releases : all)?.tag;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
const SHORT_SHA = /^[0-9a-f]{7,39}$/i;

/**
 * True when `ref` is a semver range (`^1.2`, `~1.2`, `>=1.2 <2`, `1.x`, `v1`) rather than one
 * exact version, branch or sha. resolveRef still prefers a branch or tag of exactly that name.
 */
export function isSemverRange(ref: string): boolean {
  if (FULL_SHA.test(ref) || SHORT_SHA.test(ref) || valid(ref) !== null) return false;
  return validRange(ref) !== null;
}

/** The highest semver tag satisfying `range` (prereleases only when the range names one). */
export function maxSatisfyingTag(tags: readonly string[], range: string): string | undefined {
  return highest(tagVersions(tags).filter((x) => satisfies(x.version, range)))?.tag;
}

/**
 * Whether what the lock holds (`ref`, `sha`) still answers a requested ref: the same name, a sha
 * prefix, or, for a semver range, a locked tag inside the range (`^1.2` is satisfied by `v1.3.0`).
 */
export function refSatisfies(wanted: string, locked: { ref?: string; sha?: string }): boolean {
  if (locked.ref === wanted || locked.sha?.startsWith(wanted.toLowerCase())) return true;
  return (
    isSemverRange(wanted) && !!locked.ref && maxSatisfyingTag([locked.ref], wanted) !== undefined
  );
}

/** Up to five semver tags around the lowest version `range` allows, highest first. */
function nearestTags(tags: readonly string[], range: string): string[] {
  const all = tagVersions(tags).sort((a, b) => rcompare(a.version, b.version));
  const floor = minVersion(range)?.version;
  if (!floor) return all.slice(0, 5).map((x) => x.tag);
  const below = all.filter((x) => lt(x.version, floor)).slice(0, 3);
  const above = all.filter((x) => !lt(x.version, floor));
  return [...above.slice(Math.max(0, above.length - (5 - below.length))), ...below].map(
    (x) => x.tag,
  );
}

function noMatchingTag(url: string, range: string, tags: readonly string[]): PalmError {
  const near = nearestTags(tags, range);
  const hint = near.length ? ` (nearest: ${near.join(', ')})` : ' (it has no semver tags)';
  return new PalmError(
    'E_ORIGIN',
    `No tag of ${url} satisfies "${range}"${hint}`,
    `List every tag with: git ls-remote --tags ${url}`,
  );
}

/**
 * The ref to check out for a requested one. None: the latest release tag, else the default
 * branch. A semver range (isSemverRange): a branch or tag of exactly that name, else the highest
 * satisfying tag (E_ORIGIN naming the nearest tags when none does). A tag, branch or sha: as is,
 * without a network call.
 */
export async function resolveRef(
  url: string,
  ref: string | undefined,
): Promise<string | undefined> {
  if (ref === undefined)
    return latestSemverTag(await listRemoteTags(url)) ?? (await remoteDefaultBranch(url));
  if (!isSemverRange(ref)) return ref;
  const { tags, heads } = await listRemoteRefs(url);
  if (tags.includes(ref) || heads.includes(ref)) return ref;
  const tag = maxSatisfyingTag(tags, ref);
  if (!tag) throw noMatchingTag(url, ref, tags);
  return tag;
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
  /** Ref that was requested by the origin spec (a tag, branch, sha or semver range); null = "latest". */
  requested: string | null;
  sha: string;
  fetchedAt: string;
}

const DETACHED = ['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach'];

async function fetchSha(url: string, dir: string, sha: string): Promise<void> {
  try {
    await git(['fetch', '--depth', '1', 'origin', '--', sha], remote(url, dir));
    await git([...DETACHED, 'FETCH_HEAD'], local(url, dir));
  } catch (e) {
    if (isFinal(e)) throw e;
    // Servers that refuse unadvertised shas: fall back to a full fetch.
    await git(['fetch', '--tags', 'origin'], remote(url, dir));
    await git([...DETACHED, sha], local(url, dir));
  }
}

async function freshClone(url: string, dir: string, ref: string | undefined): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  if (ref && FULL_SHA.test(ref)) {
    await git(['init', '-q', '--', dir]);
    await git(['remote', 'add', '--', 'origin', url], local(url, dir));
    await fetchSha(url, dir, ref);
    return;
  }
  const args = ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  try {
    await git([...args, '--', url, dir], remote(url));
  } catch (e) {
    if (isFinal(e) || !ref || !SHORT_SHA.test(ref)) throw e;
    await rm(dir, { recursive: true, force: true });
    await git(['clone', '--quiet', '--', url, dir], remote(url));
    await git([...DETACHED, ref], local(url, dir));
  }
}

async function updateCheckout(url: string, dir: string, ref: string | undefined): Promise<void> {
  await git(['remote', 'set-url', '--', 'origin', url], local(url, dir));
  if (ref && FULL_SHA.test(ref)) {
    await fetchSha(url, dir, ref);
  } else {
    await git(
      ['fetch', '--quiet', '--depth', '1', 'origin', '--', ref ?? 'HEAD'],
      remote(url, dir),
    );
    await git([...DETACHED, 'FETCH_HEAD'], local(url, dir));
  }
  await git(['clean', '-ffdxq'], local(url, dir));
}

/** `git ls-remote --exit-code <url> HEAD` through the validator and the hardened wrapper (used by `palm doctor`). */
export async function pingRemote(url: string): Promise<void> {
  validateOriginUrl(url);
  try {
    await git(['ls-remote', '--exit-code', '--', url, 'HEAD'], {
      ...remote(url),
      timeoutMs: 20_000,
    });
  } catch (e) {
    throw toPalmError(e, 'Cannot reach', url);
  }
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

/** The slot's checkout when it already holds the requested ref (same url, same requested ref). */
async function reuseCached(job: CheckoutJob): Promise<CheckoutMeta | undefined> {
  const meta = await readMeta(job.slot);
  return meta?.url === job.url && meta.requested === job.requested ? meta : undefined;
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
 * Clones or updates the slot at the wanted ref (resolveRef: ranges become a tag) and records it.
 * The old metadata is removed first, so a fetch that dies half-way leaves "no usable checkout"
 * rather than a stale sha; the new one is written atomically once the work tree is complete.
 */
async function fetchInto(ctx: PalmContext, job: CheckoutJob, have: boolean): Promise<CheckoutMeta> {
  const { url, slot, requested } = job;
  const wanted = await resolveRef(url, requested ?? undefined);
  ctx.log.debug(`fetching ${url}${wanted ? `#${wanted}` : ''}`);
  await rm(slot.metaFile, { force: true });
  if (have) {
    try {
      await updateCheckout(url, slot.repoDir, wanted);
    } catch (e) {
      if (isFinal(e)) throw e;
      ctx.log.debug(`update of cached ${job.origin.alias} failed (${messageOf(e)}); re-cloning`);
      await freshClone(url, slot.repoDir, wanted);
    }
  } else {
    await freshClone(url, slot.repoDir, wanted);
  }
  const sha = (await git(['rev-parse', 'HEAD'], local(url, slot.repoDir))).trim();
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
async function refreshCheckout(
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
  const cached = refresh ? undefined : await reuseCached(job);
  if (cached) return checkoutResult(job, cached);
  return withCheckoutLock(job.slot.lockFile, () => refreshCheckout(ctx, job, { refresh, since }));
}

function localCheckout(origin: Origin): OriginCheckout {
  const { spec } = origin;
  if (!spec.path) throw new PalmError('E_ORIGIN', `Local origin "${spec.alias}" has no path`);
  const root = spec.root ? join(spec.path, spec.root) : spec.path;
  if (!existsSync(root)) {
    throw new PalmError(
      'E_ORIGIN',
      `Local origin "${spec.alias}" not found at ${root}`,
      `Fix the path, or remove the origin: palm uninstall origin ${spec.alias}`,
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

/** The git origin's checkout job: its slot under `<palmHome>/cache` and the requested ref. */
function checkoutSlot(ctx: PalmContext, origin: Origin): CheckoutJob {
  const { spec } = origin;
  if (!spec.url) throw new PalmError('E_ORIGIN', `Git origin "${spec.alias}" has no url`);
  return {
    origin,
    url: spec.url,
    slot: origin.checkoutSlot(cacheDir(ctx.paths)),
    requested: spec.ref ?? null,
  };
}

/**
 * Make an origin available on disk. Local origins are used in place; git origins are cloned into
 * their checkout slot `<palmHome>/cache/<originId>/{repo|ref-<ref>}` (Origin.checkoutSlot) at the
 * wanted ref (resolveRef). Aliases of one repo + root + ref share the slot, and a per-slot lock
 * file keeps two palm processes (or two aliases in one) from fetching into it at the same time
 * (gitCheckout).
 */
export async function fetchOrigin(
  ctx: PalmContext,
  spec: OriginSpec,
  opts: { refresh?: boolean } = {},
): Promise<OriginCheckout> {
  assertSafeSpec(spec);
  const origin = new Origin(spec);
  if (origin.isLocal) return localCheckout(origin);
  const job = checkoutSlot(ctx, origin);
  const result = await gitCheckout(ctx, job, opts.refresh);
  if (spec.root && !existsSync(result.root)) {
    throw new PalmError(
      'E_ORIGIN',
      `Subdirectory "${spec.root}" not found in ${job.url}${result.ref ? `@${result.ref}` : ''}`,
      `Check the origin's root: palm describe origin ${spec.alias}`,
    );
  }
  return result;
}
