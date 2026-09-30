/**
 * Sources to checkouts and indexes (DESIGN §5), and a plugin's members in an index. Which
 * commit a run fetches (`pinOf`): the locked one while palm.yaml's ref equals the lock's, else
 * the ref resolved fresh against the remote (K8: a listing, a first install and an update never
 * trust a cached resolution). Declaring sources is declare.ts; matching names is match.ts.
 */

import { getIndex } from '../core/cache.js';
import { isPalmError, PalmError } from '../core/errors.js';
import { fetchSource, isSemverRange } from '../core/git.js';
import type {
  EngineDeps,
  Entity,
  LockSource,
  PalmContext,
  Scope,
  Source,
  SourceCheckout,
  SourceIndex,
} from '../core/types.js';
import { sameName } from '../domain/entity-ref.js';
import type { SourceRef } from '../domain/source.js';
import { localPathOf, type ScopeState } from './scope.js';

export interface Resolved {
  checkout: SourceCheckout;
  index: SourceIndex;
}

/** Which commit to fetch: `sha` (and the tag it came from), or the intent resolved fresh. */
export interface Pin {
  sha?: string;
  resolved?: string;
  refresh?: boolean;
}

const resolved = new WeakMap<ScopeState, Map<string, Promise<Resolved>>>();

/**
 * Fetches (git) or hashes (local) a source and indexes it: at the locked sha when `sha` is
 * given (bare install), else at the source's ref intent. One fetch per source and sha per run.
 */
export interface ResolveJob extends Pin {
  ctx: PalmContext;
  deps: EngineDeps;
  state: ScopeState;
  ref: SourceRef;
}

export async function resolveSource(job: ResolveJob): Promise<Resolved> {
  const { ctx, deps, state, ref } = job;
  const opts: Pin = {
    ...(job.sha ? { sha: job.sha } : {}),
    ...(job.sha && job.resolved ? { resolved: job.resolved } : {}),
    ...(job.refresh ? { refresh: true } : {}),
  };
  const memo = resolved.get(state) ?? new Map<string, Promise<Resolved>>();
  resolved.set(state, memo);
  const key = `${ref.name}\0${opts.sha ?? ref.source.ref ?? ''}\0${opts.refresh ? 1 : 0}`;
  let pending = memo.get(key);
  if (!pending) {
    pending = fetchAndIndex(ctx, deps, ref, {
      ...opts,
      exclude: await ownedInside(state, ref),
    }).catch((e: unknown) => {
      throw scopedHint(e, state.paths.scope);
    });
    memo.set(key, pending);
    pending.catch(() => memo.delete(key));
  }
  return pending;
}

/**
 * A local source at the scope root holds palm's own outputs: its tree (the index cache key)
 * leaves out every path the lock owns. Other sources hold none (overlap rule).
 */
async function ownedInside(state: ScopeState, ref: SourceRef): Promise<Set<string> | undefined> {
  if (!ref.isLocal || !ref.source.path) return undefined;
  const { paths } = state;
  const [src, root] = await Promise.all([
    paths.realInside(ref.source.path),
    paths.realInside(paths.root),
  ]);
  if (src.real !== root.real) return undefined;
  return new Set(state.lock.entries.flatMap((e) => e.files));
}

/** V4': the `palm update <source>` hint core builds without the scope gets `-g` under -g. */
function scopedHint(e: unknown, scope: Scope): unknown {
  if (scope !== 'global' || !isPalmError(e) || !e.hint?.startsWith('palm update ')) return e;
  if (e.hint.split(' ').includes('-g')) return e;
  return new PalmError(e.code, e.message, `${e.hint} -g`);
}

async function fetchAndIndex(
  ctx: PalmContext,
  deps: EngineDeps,
  ref: SourceRef,
  opts: Pin & { exclude?: Set<string> | undefined },
): Promise<Resolved> {
  const fetchOpts = {
    ...(opts.sha ? { sha: opts.sha } : {}),
    ...(opts.resolved ? { resolved: opts.resolved } : {}),
    ...(opts.refresh ? { refresh: true } : {}),
    ...(opts.exclude ? { exclude: opts.exclude } : {}),
  };
  const checkout = await fetchSource(ctx, ref.source, fetchOpts);
  const index = await getIndex(ctx, checkout, {
    scan: deps.scan,
    ...(opts.refresh ? { refresh: true } : {}),
  });
  return { checkout, index };
}

/**
 * The lock's record of a resolved source: enough to rebuild its index anywhere (DESIGN §4).
 * At the locked sha, the tag a range resolved to is kept as the lock has it. A local source
 * records its path only: each entry's `content` is its drift signal (B3; no tree hash).
 */
export function lockSourceOf(state: ScopeState, ref: SourceRef, r: Resolved): LockSource {
  const { source } = ref;
  const out: LockSource = {};
  if (ref.isLocal && source.path) out.path = localPathOf(state, source.path);
  else Object.assign(out, gitLockFields(source, r.checkout, state.lock.source(ref.name)));
  if (source.layout) out.layout = source.layout;
  out.descriptor = r.index.detected;
  return out;
}

function gitLockFields(
  source: Source,
  checkout: SourceCheckout,
  previous?: LockSource,
): LockSource {
  const out: LockSource = {};
  if (source.url) out.url = source.url;
  if (source.root) out.root = source.root;
  if (source.ref) out.ref = source.ref;
  const same = previous?.sha !== undefined && previous.sha === checkout.sha;
  const tag = same ? (previous?.resolved ?? checkout.ref) : checkout.ref;
  if (source.ref && isSemverRange(source.ref) && tag) out.resolved = tag;
  if (checkout.sha) out.sha = checkout.sha;
  return out;
}

/**
 * The commit a run fetches (K8): the locked one while palm.yaml's ref and url equal the lock's;
 * otherwise the ref intent resolved fresh against the remote (a first install, an edited ref).
 * Only the entries of an already locked source share the locked commit; nothing else trusts a
 * cached resolution. A local source is read from the working tree.
 */
export function pinOf(state: ScopeState, ref: SourceRef): Pin {
  if (ref.isLocal) return {};
  const ls = state.lock.source(ref.name);
  const sameUrl = !ls?.url || !ref.source.url || ls.url === ref.source.url;
  if (ls?.sha && ls.ref === ref.source.ref && sameUrl) return { sha: ls.sha };
  return { refresh: true };
}

/** The index entities a plugin declares (a member found through this plugin wins). */
export function membersOf(index: SourceIndex, plugin: Entity): Entity[] {
  if (plugin.def.kind !== 'plugin') return [];
  const out: Entity[] = [];
  for (const m of plugin.def.members) {
    const cands = index.entities.filter((e) => e.kind === m.kind && sameName(e.name, m.name));
    const pick = cands.find((e) => e.plugin === plugin.name) ?? cands[0];
    if (pick) out.push(pick);
  }
  return out;
}
