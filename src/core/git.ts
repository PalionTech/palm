/**
 * Sources on disk (DESIGN.md section 5): refs resolved against the remote, git sources checked
 * out once per commit in the cache, local sources used in place with their tree hash. Every git
 * call goes through git-exec.ts.
 */
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  gt,
  lt,
  major,
  minor,
  minVersion,
  prerelease,
  rcompare,
  satisfies,
  valid,
  validRange,
} from 'semver';
import { isTreeExcluded } from '../domain/ignore.js';
import { SourceRef } from '../domain/source.js';
import { validateSourceUrl } from '../domain/source-url.js';
import { cacheDir, ensureCacheDir } from './cache.js';
import {
  type CheckoutJob,
  type CheckoutRecord,
  CommitMissing,
  cachedIntent,
  cachedSha,
  commitDir,
  ensureCommit,
  FULL_SHA,
  SHORT_SHA,
} from './checkout.js';
import { deniedError, PalmError } from './errors.js';
import { git, remote, toPalmError } from './git-call.js';
import { treeHash } from './hash.js';
import type { PalmContext, Source, SourceCheckout } from './types.js';

export { withLock } from './lock-file.js';

/** Refuses unsafe URLs, refs git would read as options, and roots that leave the checkout. */
function assertSafe(source: { name?: string; url?: string; ref?: string; root?: string }): void {
  const who = source.name ? `source "${source.name}"` : 'source';
  if (source.url !== undefined) validateSourceUrl(source.url, who);
  if (source.ref?.startsWith('-'))
    throw new PalmError(
      'E_SOURCE',
      `invalid ref "${source.ref}" for ${who}`,
      'a ref is a tag, branch, sha or range such as ^1.2',
    );
  if (source.root && (source.root.split(/[\\/]+/).includes('..') || source.root.startsWith('/')))
    throw new PalmError(
      'E_SOURCE',
      `invalid root "${source.root}" for ${who}`,
      'root is a directory inside the repository, for example plugins/kit',
    );
}

// ---------------------------------------------------------------------------
// Remote refs
// ---------------------------------------------------------------------------

interface RemoteRefList {
  tags: string[];
  heads: string[];
  /** Branch → the commit it points at. */
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
  assertSafe({ url });
  let out: string;
  try {
    out = await git(['ls-remote', '--tags', '--heads', '--', url], remote(url));
  } catch (e) {
    throw toPalmError(e, 'cannot list the tags of', url);
  }
  const refs: RemoteRefList = { tags: [], heads: [], headShas: {}, tagShas: {} };
  for (const line of out.split('\n')) addRemoteRef(refs, line);
  return refs;
}

/** The branch the remote's HEAD points at (`git ls-remote --symref <url> HEAD`). */
export async function defaultBranch(url: string): Promise<string | undefined> {
  try {
    const out = await git(['ls-remote', '--symref', '--', url, 'HEAD'], remote(url));
    return /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(out)?.[1];
  } catch (e) {
    throw toPalmError(e, 'cannot read the default branch of', url);
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
    'E_SOURCE',
    `no tag of ${url} satisfies "${range}"${hint}`,
    `git ls-remote --tags ${url}`,
  );
}

/** The intent to record for a source declared without a ref: `^<major>.<minor>` of a release tag. */
function intentFor(tag: string): string {
  const v = valid(tag);
  return v && prerelease(v) === null ? `^${major(v)}.${minor(v)}` : tag;
}

function shaOf(url: string, name: string, sha: string | undefined): string {
  if (sha) return sha.toLowerCase();
  throw new PalmError('E_GIT', `${url} lists ${name} without a commit`, `git ls-remote ${url}`);
}

async function latestRef(
  url: string,
  refs: RemoteRefList,
): Promise<{ ref: string; resolved: string; sha: string }> {
  const tag = latestSemverTag(refs.tags);
  if (tag) return { ref: intentFor(tag), resolved: tag, sha: shaOf(url, tag, refs.tagShas[tag]) };
  const branch = (await defaultBranch(url)) ?? refs.heads[0];
  if (!branch)
    throw new PalmError('E_SOURCE', `${url} has no tags and no branches`, `git ls-remote ${url}`);
  return { ref: branch, resolved: branch, sha: shaOf(url, branch, refs.headShas[branch]) };
}

/**
 * Resolves a ref intent against the remote (DESIGN.md section 5 "Refs"): `ref` is the intent
 * (for none: `^<major>.<minor>` of the latest release tag, else the default branch), `resolved`
 * the tag or branch, `sha` its commit. A tag or branch named exactly like the ref wins (tags
 * before branches); a range takes the highest satisfying tag (none: E_SOURCE naming the nearest
 * tags). A full sha is its own answer without a network call; an abbreviated one is expanded
 * when the remote advertises it, else returned as given (fetchSource expands it).
 */
export async function resolveRef(
  url: string,
  ref: string | undefined,
): Promise<{ ref: string; resolved: string; sha: string }> {
  assertSafe({ url, ref });
  if (ref && FULL_SHA.test(ref)) return { ref, resolved: ref, sha: ref.toLowerCase() };
  const refs = await listRemoteRefs(url);
  if (ref === undefined) return latestRef(url, refs);
  if (refs.tags.includes(ref))
    return { ref, resolved: ref, sha: shaOf(url, ref, refs.tagShas[ref]) };
  if (refs.heads.includes(ref))
    return { ref, resolved: ref, sha: shaOf(url, ref, refs.headShas[ref]) };
  if (isSemverRange(ref)) {
    const tag = maxSatisfyingTag(refs.tags, ref);
    if (!tag) throw noMatchingTag(url, ref, refs.tags);
    return { ref, resolved: tag, sha: shaOf(url, tag, refs.tagShas[tag]) };
  }
  if (SHORT_SHA.test(ref)) {
    const all = [...Object.values(refs.tagShas), ...Object.values(refs.headShas)];
    return {
      ref,
      resolved: ref,
      sha: all.find((s) => s.startsWith(ref.toLowerCase())) ?? ref.toLowerCase(),
    };
  }
  throw new PalmError(
    'E_SOURCE',
    `${url} has no tag or branch "${ref}"`,
    `git ls-remote --tags --heads ${url}`,
  );
}

// ---------------------------------------------------------------------------
// Checkouts
// ---------------------------------------------------------------------------

function checkoutOf(job: CheckoutJob, rec: CheckoutRecord, resolved?: string): SourceCheckout {
  const { source } = job.ref;
  const repoDir = commitDir(job, rec.sha);
  const out: SourceCheckout = {
    source,
    sourceId: job.ref.id,
    root: source.root ? join(repoDir, source.root) : repoDir,
    repoDir,
    sha: rec.sha,
  };
  if (resolved) out.ref = resolved;
  return out;
}

function notCached(job: CheckoutJob, what: string): PalmError {
  return new PalmError(
    'E_NETWORK',
    `source "${job.ref.name}"${what} is not in the cache and --offline is set`,
    'run the command again without --offline to fetch it',
  );
}

/**
 * V4': the locked commit is gone from the remote (history rewritten, a force push). Moving the
 * source to what its ref names now is the way on.
 */
function goneError(job: CheckoutJob, sha: string): PalmError {
  return new PalmError(
    'E_SOURCE',
    `commit ${sha.slice(0, 7)} is gone from ${job.url} (history rewritten?)`,
    `palm update ${job.ref.name}`,
  );
}

/** R9': a ref (a sha or its abbreviation) the source does not have, in palm's words. */
function refNotFound(job: CheckoutJob, ref: string): PalmError {
  return new PalmError(
    'E_SOURCE',
    `ref ${ref} not found in ${job.ref.name}`,
    `git ls-remote --tags --heads ${job.url}`,
  );
}

/** `fn`, with a missing commit reported by `name(sha)` instead. */
async function namingMissing<T>(fn: () => Promise<T>, name: (sha: string) => PalmError) {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof CommitMissing ? name(e.sha) : e;
  }
}

/**
 * A locked sha: from the cache, else fetched (never re-resolved); a commit the remote no longer
 * has is named as gone (V4'). `resolved` is the tag or branch a fresh resolution just found for
 * it (the one resolution of a new source, K8).
 */
async function checkoutSha(
  ctx: PalmContext,
  job: CheckoutJob,
  pin: { sha: string; resolved?: string },
): Promise<SourceCheckout> {
  const { sha, resolved } = pin;
  const requested = job.ref.source.ref;
  const intent = { requested, ...(resolved ? { resolved } : {}) };
  const cached = await cachedSha(job, sha);
  if (cached && resolved)
    return checkoutOf(job, await ensureCommit(ctx, job, cached.sha, intent), resolved);
  if (cached) return checkoutOf(job, cached, requested && cached.refs[requested]?.resolved);
  if (ctx.flags.offline) throw notCached(job, ` at ${sha.slice(0, 7)}`);
  const fetch = () => ensureCommit(ctx, job, sha, intent);
  return checkoutOf(job, await namingMissing(fetch, () => goneError(job, sha)), resolved);
}

/** The ref intent: a cache hit (no network) unless `refresh`, else resolved and fetched. */
async function checkoutIntent(
  ctx: PalmContext,
  job: CheckoutJob,
  refresh: boolean,
): Promise<SourceCheckout> {
  const requested = job.ref.source.ref;
  const cached = refresh && !ctx.flags.offline ? undefined : await cachedIntent(job, requested);
  if (cached) return checkoutOf(job, cached.record, cached.resolved);
  if (ctx.flags.offline) throw notCached(job, requested ? ` at ${requested}` : '');
  const r = await resolveRef(job.url, requested);
  const fetch = () => ensureCommit(ctx, job, r.sha, { requested, resolved: r.resolved });
  const rec = await namingMissing(fetch, (sha) => refNotFound(job, requested ?? sha));
  return checkoutOf(job, rec, r.resolved);
}

async function localCheckout(
  ref: SourceRef,
  exclude: ReadonlySet<string>,
): Promise<SourceCheckout> {
  const { source } = ref;
  const base = source.path ?? '';
  const dir = source.root ? join(base, source.root) : base;
  if (!base || !existsSync(dir)) {
    throw new PalmError(
      'E_SOURCE',
      `source ${ref.name} is not at ${dir || '(no path)'}`,
      `restore the directory, or rename the source in palm.yaml to where it is now`,
    );
  }
  const root = await realpath(dir);
  const { tree } = await treeHash(root, { skip: (rel) => isTreeExcluded(rel) || exclude.has(rel) });
  return { source, sourceId: ref.id, root, repoDir: await realpath(base), tree };
}

/**
 * A git source's checkout: the locked sha, else the ref intent. A write the filesystem refuses
 * (a read-only PALM_HOME, an unwritable cache) is E_IO naming the path (B6).
 */
async function gitCheckout(
  ctx: PalmContext,
  job: CheckoutJob,
  opts: { sha?: string; resolved?: string; refresh?: boolean },
): Promise<SourceCheckout> {
  try {
    await ensureCacheDir(job.cache);
    if (!opts.sha) return await checkoutIntent(ctx, job, !!opts.refresh);
    const pin = { sha: opts.sha, ...(opts.resolved ? { resolved: opts.resolved } : {}) };
    return await checkoutSha(ctx, job, pin);
  } catch (e) {
    const hint = `set PALM_HOME to a writable directory, or check the permissions: ls -ld ${job.cache}`;
    throw deniedError(e, job.cache, hint) ?? e;
  }
}

/**
 * Makes a source available on disk. Local: used in place, with its tree hash (DESIGN.md section
 * 4; `exclude` adds source-relative paths to leave out, the lock-owned paths of a source at
 * `.`). Git: `opts.sha` (the locked commit) is taken as is; otherwise the ref intent is a cache
 * hit when an earlier fetch resolved it, and is resolved against the remote when not or with
 * `refresh`. Each commit is fetched once into `<cache>/<id>/sha-<sha>`. `--offline` never
 * touches the network (E_NETWORK when the cache lacks it).
 */
export async function fetchSource(
  ctx: PalmContext,
  source: Source,
  opts: { sha?: string; resolved?: string; refresh?: boolean; exclude?: ReadonlySet<string> } = {},
): Promise<SourceCheckout> {
  assertSafe(source);
  const ref = SourceRef.of(source);
  if (ref.isLocal) return localCheckout(ref, opts.exclude ?? new Set());
  if (!source.url)
    throw new PalmError(
      'E_SOURCE',
      `source "${source.name}" has no url`,
      `add url: under sources."${source.name}" in palm.yaml`,
    );
  const job: CheckoutJob = { ref, url: source.url, cache: cacheDir(ctx.paths) };
  const result = await gitCheckout(ctx, job, opts);
  if (source.root && !existsSync(result.root)) {
    throw new PalmError(
      'E_SOURCE',
      `${source.url} has no directory "${source.root}" at ${result.ref ?? result.sha?.slice(0, 7)}`,
      `check root: under sources."${source.name}" in palm.yaml`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reading a checkout
// ---------------------------------------------------------------------------

const ANY_SHA = /^[0-9a-f]{7,40}$/i;

/** The author date (ISO 8601) of `sha` in the checkout, for the consent header; undefined when unknown. */
export async function commitDate(checkoutDir: string, sha: string): Promise<string | undefined> {
  if (!ANY_SHA.test(sha)) return undefined;
  try {
    const out = await git(['log', '-1', '--format=%aI', sha, '--'], { cwd: checkoutDir });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** True when `rel` is a plain relative path inside a tree (no option, no `..`, not absolute). */
function isTreePath(rel: string): boolean {
  return !!rel && !rel.startsWith('-') && !rel.startsWith('/') && !rel.split('/').includes('..');
}

/**
 * The content of `rel` at `sha` (`git show <sha>:<rel>`), for the script viewer and diffs;
 * undefined when the commit or path does not exist.
 */
export async function fileAtSha(
  checkoutDir: string,
  sha: string,
  rel: string,
): Promise<string | undefined> {
  if (!ANY_SHA.test(sha) || !isTreePath(rel)) return undefined;
  const object = `${sha}:${rel}`;
  try {
    const [text, size] = await Promise.all([
      git(['show', object], { cwd: checkoutDir }),
      git(['cat-file', '-s', object], { cwd: checkoutDir }),
    ]);
    // The runner strips one final newline; put it back when the blob had one.
    const missing = Number(size.trim()) - Buffer.byteLength(text);
    if (missing === 2) return `${text}\r\n`;
    return missing === 1 ? `${text}\n` : text;
  } catch {
    return undefined;
  }
}
