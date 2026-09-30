/**
 * The checkout store (DESIGN.md section 5 "Cache ids and checkouts"): one work tree per commit
 * in `<cache>/<sourceId>/sha-<sha>/`, fetched once under a lock, with `sha-<sha>.json` beside it
 * recording the URL and the ref intents that resolved to that commit.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SourceRef } from '../domain/source.js';
import { comparableUrl } from '../domain/source-url.js';
import { readJsonFile, walkFiles, writeJsonFile } from '../lib/fs.js';
import { isRecord } from '../lib/object.js';
import { deniedError, PalmError } from './errors.js';
import { git, isFinal, local, remote, toPalmError } from './git-call.js';
import { GitFailure, isGitTimeout } from './git-exec.js';
import { withLock } from './lock-file.js';
import type { PalmContext } from './types.js';

export const FULL_SHA = /^[0-9a-f]{40}$/i;
export const SHORT_SHA = /^[0-9a-f]{7,39}$/i;

/** What `sha-<sha>.json` records beside a checkout. */
export interface CheckoutRecord {
  url: string;
  sha: string;
  fetchedAt: string;
  /** Ref intents that resolved to this commit (`''` = none given) → the tag or branch, and when. */
  refs: Record<string, { resolved?: string; at: string }>;
}

/** One git source being made available in the cache. */
export interface CheckoutJob {
  ref: SourceRef;
  url: string;
  cache: string;
}

/** Where a commit's work tree lives. */
export function commitDir(job: CheckoutJob, sha: string): string {
  return job.ref.checkoutDir(job.cache, sha);
}

async function readRecord(dir: string): Promise<CheckoutRecord | undefined> {
  if (!existsSync(join(dir, '.git'))) return undefined;
  const rec = await readJsonFile<unknown>(`${dir}.json`).catch(() => undefined);
  return isRecord(rec) && typeof rec.sha === 'string' && isRecord(rec.refs)
    ? (rec as unknown as CheckoutRecord)
    : undefined;
}

/** Every complete checkout of the job's source that was fetched from its URL. */
async function records(job: CheckoutJob): Promise<CheckoutRecord[]> {
  const dir = join(job.cache, job.ref.id);
  const names = await readdir(dir).catch(() => [] as string[]);
  const found = await Promise.all(
    names.filter((n) => /^sha-[0-9a-f]+$/i.test(n)).map((n) => readRecord(join(dir, n))),
  );
  const url = comparableUrl(job.url);
  return found.filter((r): r is CheckoutRecord => !!r && comparableUrl(r.url) === url);
}

/** The cached checkout of `sha` (a full sha, or a prefix of at least 7). */
export async function cachedSha(
  job: CheckoutJob,
  sha: string,
): Promise<CheckoutRecord | undefined> {
  const lower = sha.toLowerCase();
  return (await records(job)).find((r) => r.sha.startsWith(lower));
}

/** The newest cached checkout that the intent `requested` resolved to (a full sha is its own intent). */
export async function cachedIntent(
  job: CheckoutJob,
  requested: string | undefined,
): Promise<{ record: CheckoutRecord; resolved?: string } | undefined> {
  if (requested && FULL_SHA.test(requested)) {
    const record = await cachedSha(job, requested);
    return record && { record, resolved: requested };
  }
  const key = requested ?? '';
  let best: { record: CheckoutRecord; resolved?: string; at: string } | undefined;
  for (const record of await records(job)) {
    const hit = record.refs[key];
    if (hit && (!best || hit.at > best.at)) best = { record, resolved: hit.resolved, at: hit.at };
  }
  return best && { record: best.record, resolved: best.resolved };
}

/** Records that `requested` resolved to this checkout. */
async function noteIntent(
  dir: string,
  rec: CheckoutRecord,
  intent: Intent,
): Promise<CheckoutRecord> {
  const at = new Date().toISOString();
  const entry = intent.resolved ? { resolved: intent.resolved, at } : { at };
  const next: CheckoutRecord = { ...rec, refs: { ...rec.refs, [intent.requested ?? '']: entry } };
  await writeJsonFile(`${dir}.json`, next);
  return next;
}

/** The ref a commit was asked for (`requested`, the manifest intent) and the tag or branch it came from. */
export interface Intent {
  requested?: string;
  resolved?: string;
}

const DETACHED = ['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach'];

/** Fetches `sha` by the tag or branch it came from; false when that name no longer points at it. */
async function fetchByName(url: string, dir: string, name: string, sha: string): Promise<boolean> {
  try {
    await git(['fetch', '--quiet', '--depth', '1', 'origin', '--', name], remote(url, dir));
    const head = (await git(['rev-parse', 'FETCH_HEAD^{commit}'], local(url, dir))).trim();
    if (head.toLowerCase() !== sha.toLowerCase()) return false;
    await git([...DETACHED, 'FETCH_HEAD'], local(url, dir));
    return true;
  } catch (e) {
    if (isFinal(e)) throw e;
    return false;
  }
}

/**
 * A commit the remote does not have: git.ts names it as gone from the remote (a locked sha,
 * V4') or as a ref not found in the source (a typed one, R9'), never with git's own words.
 */
export class CommitMissing extends PalmError {
  constructor(
    readonly sha: string,
    readonly url: string,
  ) {
    super('E_SOURCE', `commit ${sha.slice(0, 7)} is not in ${url}`, `git ls-remote ${url}`);
  }
}

/** The full sha `sha` (full or abbreviated) names in the repository at `dir`, if it has it. */
async function commitIn(url: string, dir: string, sha: string): Promise<string | undefined> {
  try {
    const out = await git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], local(url, dir));
    return out.trim().toLowerCase() || undefined;
  } catch (e) {
    if (isFinal(e)) throw e;
    return undefined;
  }
}

/**
 * Checks out `sha` in the repository at `dir`; CommitMissing when it is not there. The step
 * talks to the remote: a partial clone fetches the commit's files on checkout.
 */
async function checkoutCommit(url: string, dir: string, sha: string): Promise<string> {
  const full = await commitIn(url, dir, sha);
  if (!full) throw new CommitMissing(sha, url);
  await git([...DETACHED, full], remote(url, dir));
  return full;
}

/**
 * Fetches `sha` alone (`git fetch --depth 1 origin <sha>`, T3); only a server that refuses an
 * unadvertised commit gets a full fetch, after which a commit still missing is CommitMissing.
 */
async function fetchSha(url: string, dir: string, sha: string): Promise<void> {
  try {
    await git(['fetch', '--quiet', '--depth', '1', 'origin', '--', sha], remote(url, dir));
  } catch (e) {
    if (isFinal(e)) throw e;
    await git(['fetch', '--quiet', '--tags', 'origin'], remote(url, dir));
    await checkoutCommit(url, dir, sha);
    return;
  }
  await git([...DETACHED, 'FETCH_HEAD'], local(url, dir));
}

/** A fresh repository at `tmp` holding the commit `sha` (by name first, when one is known). */
async function fetchCommitInto(
  url: string,
  tmp: string,
  sha: string,
  name?: string,
): Promise<void> {
  await git(['init', '-q', '--', tmp], { cwd: dirname(tmp) });
  await git(['remote', 'add', '--', 'origin', url], local(url, tmp));
  if (!(name && (await fetchByName(url, tmp, name, sha)))) await fetchSha(url, tmp, sha);
}

/**
 * A clone at `tmp` checked out at the abbreviated `short`; returns the full sha. Only git can
 * expand an abbreviation, so the history comes along, but without file contents
 * (`--filter=blob:none`, T3): the checkout fetches the files of that one commit.
 */
async function cloneShort(url: string, tmp: string, short: string): Promise<string> {
  const clone = ['clone', '--quiet', '--no-checkout', '--filter=blob:none', '--', url, tmp];
  await git(clone, remote(url, dirname(tmp)));
  return checkoutCommit(url, tmp, short);
}

/** Moves the finished `tmp` into place as the checkout of `sha` and writes its record. */
async function install(
  job: CheckoutJob,
  tmp: string,
  sha: string,
  intent: Intent,
): Promise<CheckoutRecord> {
  const dir = commitDir(job, sha);
  const have = await readRecord(dir);
  if (have) {
    await rm(tmp, { recursive: true, force: true });
    return noteIntent(dir, have, intent);
  }
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  const rec: CheckoutRecord = { url: job.url, sha, fetchedAt: new Date().toISOString(), refs: {} };
  return noteIntent(dir, rec, intent);
}

function tmpDirFor(job: CheckoutJob): string {
  return join(job.cache, job.ref.id, `tmp-${randomBytes(6).toString('hex')}`);
}

/** Bytes of the files below `dir` (0 when it is gone). */
async function bytesBelow(dir: string): Promise<number> {
  const { files } = await walkFiles(dir).catch(() => ({ files: [] as Array<{ size: number }> }));
  return files.reduce((n, f) => n + f.size, 0);
}

/** `412 MB`, `1.2 GB`: a download size as people read it. */
function megabytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${Math.round((mb / 1024) * 10) / 10} GB`;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${Math.round(mb * 10) / 10} MB`;
}

const GIT_DENIED = /permission denied|read-only file system|operation not permitted/i;

/** B6: git could not write the cache (a read-only PALM_HOME): E_IO naming the cache directory. */
function cacheDenied(job: CheckoutJob, e: unknown): PalmError | undefined {
  const hint = `set PALM_HOME to a writable directory, or check the permissions: ls -ld ${job.cache}`;
  const denied = deniedError(e, job.cache, hint);
  if (denied || !(e instanceof GitFailure) || !GIT_DENIED.test(e.detail)) return denied;
  return new PalmError('E_IO', `cannot write the palm cache ${job.cache}: ${e.detail}`, hint);
}

/**
 * The error a failed fetch ends with: a refused write as E_IO (B6), a timeout with how much
 * arrived before it (T3: a large repository), else git's failure in palm's words.
 */
export function fetchError(job: CheckoutJob, e: unknown, received: number): PalmError {
  const denied = cacheDenied(job, e);
  if (denied) return denied;
  const err = toPalmError(e, `cannot fetch source "${job.ref.name}" from`, job.url);
  if (!received) return err;
  return new PalmError(
    err.code,
    `${err.message} (${megabytes(received)} received: a large repository)`,
    `a tag or a full 40-character commit fetches that commit alone; pin one (#v1.2.0), or check the network and run it again`,
  );
}

/** Runs a fetch into a temporary directory, removing it on failure and naming the source. */
async function fetching<T>(job: CheckoutJob, fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = tmpDirFor(job);
  try {
    return await fn(tmp);
  } catch (e) {
    const received = isGitTimeout(e) ? await bytesBelow(tmp) : 0;
    await rm(tmp, { recursive: true, force: true });
    throw fetchError(job, e, received);
  }
}

/**
 * The checkout of `sha` (full, or an abbreviation git expands), fetched into the cache once:
 * under the lock `sha-<sha>.lock` a present checkout is reused, else it is fetched into a
 * temporary directory and moved into place. `intent` is recorded for later cache hits.
 */
export async function ensureCommit(
  ctx: PalmContext,
  job: CheckoutJob,
  sha: string,
  intent: Intent,
): Promise<CheckoutRecord> {
  const full = FULL_SHA.test(sha);
  const lockName = full ? `sha-${sha.toLowerCase()}.lock` : `ref-${sha.toLowerCase()}.lock`;
  return withLock(join(job.cache, job.ref.id, lockName), async () => {
    const have = full
      ? await readRecord(commitDir(job, sha.toLowerCase()))
      : await cachedSha(job, sha);
    if (have) return noteIntent(commitDir(job, have.sha), have, intent);
    ctx.log.debug(`fetching ${job.url} at ${sha}`);
    return fetching(job, async (tmp) => {
      if (!full) return install(job, tmp, await cloneShort(job.url, tmp, sha), intent);
      await fetchCommitInto(job.url, tmp, sha.toLowerCase(), intent.resolved);
      const head = (await git(['rev-parse', 'HEAD'], local(job.url, tmp))).trim();
      if (head.toLowerCase() !== sha.toLowerCase())
        throw new PalmError(
          'E_GIT',
          `fetched ${head} from ${job.url}, expected ${sha}`,
          'palm cache clean',
        );
      return install(job, tmp, head.toLowerCase(), intent);
    });
  });
}
