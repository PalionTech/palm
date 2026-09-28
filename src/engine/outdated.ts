/**
 * `palm outdated`: for each directly installed entry, the ref it is locked at (current), what
 * its manifest ref resolves to on the remote now (wanted) and the newest release (latest).
 * Informational and cheap: remote refs come from `git ls-remote` (tag and branch names, the
 * default branch), never from the cache and never with a fetch.
 */
import { messageOf } from '../core/errors.js';
import { isSemverRange, latestSemverTag, maxSatisfyingTag } from '../core/git.js';
import { KINDS, type Kind, type LockEntry, type PalmContext, type Scope } from '../core/types.js';
import { Lock } from '../domain/lock.js';
import { isMcpManifestEntry, Manifest } from '../domain/manifest.js';
import type { Origin } from '../domain/origin.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { type EngineDeps, resolveEngineDeps } from './deps.js';

/** Tag and branch names of a remote, with their commits when the reader knows them. */
interface RemoteRefList {
  tags: string[];
  heads: string[];
  headShas?: Record<string, string>;
  tagShas?: Record<string, string>;
}

/** The remote queries `palm outdated` makes (core/git by default; tests pass fakes). */
export interface RemoteRefs {
  /** `git ls-remote --tags --heads`. */
  refs(url: string): Promise<RemoteRefList>;
  /** What no ref resolves to: the latest release tag, else the default branch (`resolveRef(url)`). */
  latest(url: string): Promise<string | undefined>;
}

/**
 * `current`: locked at the ref the manifest wants; `outdated`: `palm update` would move it;
 * `pinned`: at the wanted ref, but a newer release exists; `unknown`: the remote could not be
 * read or a branch head cannot be compared; `untracked`: nothing to compare (local origins,
 * ad hoc MCP servers).
 */
type OutdatedStatus = 'current' | 'outdated' | 'pinned' | 'unknown' | 'untracked';

export interface OutdatedItem {
  kind: Kind;
  name: string;
  origin: string;
  current: string;
  wanted: string;
  latest: string;
  status: OutdatedStatus;
}

export interface OutdatedReport {
  items: OutdatedItem[];
  warnings: string[];
}

/** A ref on the remote: a tag or branch name, with its commit when known. */
interface RemoteRef {
  ref: string;
  branch?: boolean;
  sha?: string;
}

/** `v1.2.0 (abc1234)`, `v1.2.0`, `abc1234`, or `?`. */
export function refLabel(r: { ref?: string | undefined; sha?: string | undefined } = {}): string {
  const short = r.sha?.slice(0, 7);
  if (!r.ref) return short ?? '?';
  return short && r.ref !== r.sha ? `${r.ref} (${short})` : r.ref;
}

function wantedLabel(r: RemoteRef | undefined): string {
  if (!r) return '?';
  return r.branch && !r.sha ? `${r.ref} (head)` : refLabel(r);
}

type Current = Pick<LockEntry, 'ref' | 'sha'>;

/**
 * Does the lock already hold `wanted`? The same commit whatever the ref is called (a moved or
 * second tag on the locked commit is not an update); else the same ref name (or the sha it
 * spells), where a branch also needs the same commit.
 */
function sameRef(current: Current, wanted: RemoteRef): boolean | undefined {
  if (current.sha && wanted.sha) return current.sha === wanted.sha;
  const named =
    current.ref === wanted.ref || (!!current.sha?.startsWith(wanted.ref) && wanted.ref.length >= 7);
  if (!named || !wanted.branch) return named;
  return undefined; // same branch, commits unknown
}

/** A newer release than `wanted` exists (a different tag on another commit). */
function newerRelease(wanted: RemoteRef, latest: RemoteRef | undefined): boolean {
  if (!latest || latest.ref === wanted.ref) return false;
  return !(latest.sha && latest.sha === wanted.sha);
}

function statusOf(current: Current, wanted?: RemoteRef, latest?: RemoteRef): OutdatedStatus {
  if (!wanted) return 'unknown';
  const same = sameRef(current, wanted);
  if (same === undefined) return 'unknown';
  if (!same) return 'outdated';
  return newerRelease(wanted, latest) ? 'pinned' : 'current';
}

async function defaultRemote(): Promise<RemoteRefs> {
  const git = await import('../core/git.js');
  return { refs: git.listRemoteRefs, latest: (url) => git.resolveRef(url, undefined) };
}

/** One origin URL's refs, read once per run. */
interface RemoteView {
  list: RemoteRefList;
  latest: RemoteRef | undefined;
}

interface Scan {
  ctx: PalmContext;
  deps: EngineDeps;
  remote: RemoteRefs;
  manifest: Manifest;
  views: Map<string, Promise<RemoteView>>;
  warnings: string[];
}

function onRemote(list: RemoteRefList, ref: string): RemoteRef {
  const branch = list.heads.includes(ref) && !list.tags.includes(ref);
  const sha = branch ? list.headShas?.[ref] : list.tagShas?.[ref];
  return { ref, ...(branch ? { branch } : {}), ...(sha ? { sha } : {}) };
}

async function readRemote(remote: RemoteRefs, url: string): Promise<RemoteView> {
  const list = await remote.refs(url);
  const latest = latestSemverTag(list.tags) ?? (await remote.latest(url));
  return { list, latest: latest === undefined ? undefined : onRemote(list, latest) };
}

function viewOf(s: Scan, url: string): Promise<RemoteView> {
  let v = s.views.get(url);
  if (!v) {
    v = readRemote(s.remote, url);
    s.views.set(url, v);
  }
  return v;
}

/** What a pinned ref names now: a tag or branch as is, a semver range its highest tag. */
function wantedRef(view: RemoteView, pinned: string | undefined): RemoteRef | undefined {
  if (pinned === undefined) return view.latest;
  const { tags, heads } = view.list;
  if (tags.includes(pinned) || heads.includes(pinned) || !isSemverRange(pinned))
    return onRemote(view.list, pinned);
  const tag = maxSatisfyingTag(tags, pinned);
  return tag === undefined ? undefined : onRemote(view.list, tag);
}

type Row = Pick<OutdatedItem, 'current' | 'wanted' | 'latest' | 'status'>;

const UNTRACKED: Row = { current: '-', wanted: '-', latest: '-', status: 'untracked' };

function unknownRow(e: LockEntry): Row {
  return { current: refLabel(e), wanted: '?', latest: '?', status: 'unknown' };
}

function pinnedRef(s: Scan, e: LockEntry, origin: Origin): string | undefined {
  const dep = s.manifest.depFor(e);
  return (dep && !isMcpManifestEntry(dep) ? dep.ref : undefined) ?? origin.spec.ref;
}

async function gitRow(s: Scan, e: LockEntry, origin: Origin): Promise<Row> {
  const url = origin.spec.url;
  if (!url || s.ctx.flags.offline) return unknownRow(e);
  try {
    const view = await viewOf(s, url);
    const pinned = pinnedRef(s, e, origin);
    const wanted = wantedRef(view, pinned);
    if (!wanted) s.warnings.push(`${e.kind} ${e.name}: no tag of ${url} satisfies "${pinned}"`);
    const status = statusOf(e, wanted, view.latest);
    const row = { current: refLabel(e), wanted: wantedLabel(wanted), status };
    return { ...row, latest: wantedLabel(view.latest) };
  } catch (err) {
    s.warnings.push(`${e.kind} ${e.name}: could not read the refs of ${url}: ${messageOf(err)}`);
    return unknownRow(e);
  }
}

async function registryRow(s: Scan, e: LockEntry): Promise<Row> {
  if (s.ctx.flags.offline) return unknownRow(e);
  const dep = s.manifest.depFor(e);
  const pinned = dep && isMcpManifestEntry(dep) ? dep.version : undefined;
  try {
    const url = s.ctx.config.mcpRegistryUrl;
    const found = await s.deps.resolveRegistry(e.path, url ? { registryUrl: url } : {});
    const version = found[0]?.version;
    const latest = version ? { ref: version } : undefined;
    const wanted = pinned ? { ref: pinned } : latest;
    const status = statusOf({ ref: e.ref }, wanted, latest);
    return { current: e.ref ?? '?', wanted: wanted?.ref ?? '?', latest: version ?? '?', status };
  } catch (err) {
    s.warnings.push(`mcp ${e.name}: could not query the MCP registry: ${messageOf(err)}`);
    return unknownRow(e);
  }
}

async function rowFor(s: Scan, e: LockEntry): Promise<Row> {
  if (e.origin === 'adhoc') return UNTRACKED;
  if (e.origin === 'registry') return registryRow(s, e);
  const origin = s.ctx.origins.byAlias(e.origin);
  if (!origin) {
    s.warnings.push(
      `${e.kind} ${e.name}: origin "${e.origin}" is not registered (register it: palm install origin <spec> --alias ${e.origin})`,
    );
    return unknownRow(e);
  }
  return origin.isGit ? gitRow(s, e, origin) : UNTRACKED;
}

const byKindName = (a: LockEntry, b: LockEntry): number =>
  KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name);

/** Current / wanted / latest for every direct install of the scope (optionally one kind). */
export async function outdatedEntries(
  ctx: PalmContext,
  opts: { scope: Scope; kind?: Kind | undefined; remote?: Partial<RemoteRefs> },
  deps?: Partial<EngineDeps>,
): Promise<OutdatedReport> {
  const paths = ScopePaths.of(ctx, opts.scope);
  const lock = await Lock.load(paths.lockFile);
  const entries = lock.entries
    .filter((e) => !e.via && (!opts.kind || e.kind === opts.kind))
    .sort(byKindName);
  const s: Scan = {
    ctx,
    deps: await resolveEngineDeps(deps),
    remote: { ...(await defaultRemote()), ...opts.remote },
    manifest: await Manifest.load(paths.manifestFile),
    views: new Map(),
    warnings: ctx.flags.offline ? ['offline: remote refs were not checked'] : [],
  };
  const items: OutdatedItem[] = [];
  for (const e of entries) {
    const row = await rowFor(s, e);
    items.push({ kind: e.kind, name: e.name, origin: e.origin, ...row });
  }
  if (items.some((i) => i.status === 'unknown' && i.wanted.endsWith('(head)')))
    s.warnings.push(
      'branch-tracking entries show unknown: the locked or the remote commit is not known',
    );
  return { items, warnings: s.warnings };
}
