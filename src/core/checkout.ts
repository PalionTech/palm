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
import { readJsonFile, writeJsonFile } from '../lib/fs.js';
import { isRecord } from '../lib/object.js';
import { PalmError } from './errors.js';
import { git, isFinal, local, remote, toPalmError } from './git-call.js';
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

/** Fetches `sha` shallowly; servers that refuse unadvertised shas get a full fetch. */
async function fetchSha(url: string, dir: string, sha: string): Promise<void> {
  try {
    await git(['fetch', '--quiet', '--depth', '1', 'origin', '--', sha], remote(url, dir));
    await git([...DETACHED, 'FETCH_HEAD'], local(url, dir));
  } catch (e) {
    if (isFinal(e)) throw e;
    await git(['fetch', '--quiet', '--tags', 'origin'], remote(url, dir));
    await git([...DETACHED, sha], local(url, dir));
  }
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

/** A full clone at `tmp` checked out at the abbreviated `short`; returns the full sha. */
async function cloneShort(url: string, tmp: string, short: string): Promise<string> {
  await git(['clone', '--quiet', '--', url, tmp], remote(url, dirname(tmp)));
  await git([...DETACHED, short], local(url, tmp));
  return (await git(['rev-parse', 'HEAD'], local(url, tmp))).trim();
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

/** Runs a fetch into a temporary directory, removing it on failure and naming the source. */
async function fetching<T>(job: CheckoutJob, fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = tmpDirFor(job);
  try {
    return await fn(tmp);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw toPalmError(e, `cannot fetch source "${job.ref.name}" from`, job.url);
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
