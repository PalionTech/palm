import { getIndex } from '../core/cache.js';
import { findOrigin } from '../core/config.js';
import { messageOf, PalmError } from '../core/errors.js';
import type {
  InstallOutcome,
  InstallRequest,
  InstallResult,
  Kind,
  LockEntry,
  OriginSpec,
  PalmContext,
  Scope,
} from '../core/types.js';
import { DepRef } from '../domain/dep-ref.js';
import { lockId } from '../domain/entity-key.js';
import { Lock } from '../domain/lock.js';
import { isMcpManifestEntry, Manifest, type ManifestDep } from '../domain/manifest.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { type EngineDeps, resolveEngineDeps } from './deps.js';
import { dedupeOutcomes, installEntities } from './install.js';

/**
 * The entries to refresh: the named ones (all direct installs when none are named), each
 * replaced by the root of its `via` chain, since dependencies are refreshed through the
 * entity that pulled them in.
 */
function selectRoots(lock: Lock, refs: Array<{ kind?: Kind; name: string }>): LockEntry[] {
  const selected = refs.length
    ? refs.flatMap((ref) => {
        const matches = lock.select(ref);
        if (matches.length) return matches;
        throw new PalmError(
          'E_NOT_FOUND',
          `${ref.kind ?? 'Nothing'} named "${ref.name}" is ${ref.kind ? 'not ' : ''}installed`,
          'See `palm list`.',
        );
      })
    : lock.entries.filter((e) => !e.via);
  const roots = new Map<string, LockEntry>();
  for (const e of selected) {
    const root = lock.rootOf(e);
    roots.set(lockId(root), root);
  }
  return [...roots.values()];
}

type Refresh = (spec: OriginSpec, ref: string | undefined) => Promise<void>;

/** The reinstall request for a root entry, or the outcome when it cannot be updated. */
async function requestFor(
  ctx: PalmContext,
  e: LockEntry,
  pinned: ManifestDep | undefined,
  refresh: Refresh,
): Promise<{ request: InstallRequest } | { outcome: InstallOutcome; warning?: string }> {
  if (e.origin === 'adhoc') {
    const note = 'ad hoc MCP server: edit palm.yaml and run `palm install` to change it';
    return { outcome: { entry: e, status: 'unchanged', notes: [note] } };
  }
  if (e.origin === 'registry') {
    const version = pinned && isMcpManifestEntry(pinned) ? pinned.version : undefined;
    return {
      request: { kind: 'mcp', spec: DepRef.of(e.path, undefined, version), registry: e.path },
    };
  }
  const spec = findOrigin(ctx, e.origin);
  if (!spec) {
    return {
      outcome: { entry: e, status: 'skipped', notes: [`origin "${e.origin}" not registered`] },
      warning: `${e.kind} ${e.name}: origin "${e.origin}" is no longer registered; skipped`,
    };
  }
  const ref = pinned && !isMcpManifestEntry(pinned) ? pinned.ref : undefined;
  await refresh(spec, ref);
  return { request: { kind: e.kind, spec: DepRef.of(e.name, e.origin, ref) } };
}

/** Refetch origins and reinstall the selected entries whose content changed. */
export async function updateEntities(
  ctx: PalmContext,
  refs: Array<{ kind?: Kind; name: string }>,
  opts: { scope: Scope },
  depsIn?: Partial<EngineDeps>,
): Promise<InstallResult> {
  const deps = await resolveEngineDeps(depsIn, { targets: true });
  const paths = ScopePaths.of(ctx, opts.scope);
  const lock = await Lock.load(paths.lockFile);
  const manifest = await Manifest.load(paths.manifestFile);

  const outcomes: InstallOutcome[] = [];
  const warnings: string[] = [];
  const refreshed = new Set<string>();
  const refresh: Refresh = async (spec, ref) => {
    const key = `${spec.alias}#${ref ?? ''}`;
    if (refreshed.has(key)) return;
    refreshed.add(key);
    try {
      await getIndex(ctx, ref ? { ...spec, ref } : spec, { refresh: true, scan: deps.scan });
    } catch (err) {
      warnings.push(`could not refresh origin "${spec.alias}": ${messageOf(err)}`);
    }
  };

  const groups = new Map<string, { targets: LockEntry['targets']; requests: InstallRequest[] }>();
  for (const e of selectRoots(lock, refs)) {
    const r = await requestFor(ctx, e, manifest.depFor(e), refresh);
    if ('outcome' in r) {
      if (r.warning) warnings.push(r.warning);
      outcomes.push(r.outcome);
      continue;
    }
    const gk = e.targets.join(',');
    const g = groups.get(gk) ?? { targets: e.targets, requests: [] };
    g.requests.push(r.request);
    groups.set(gk, g);
  }

  for (const g of groups.values()) {
    const r = await installEntities(
      ctx,
      g.requests,
      { scope: opts.scope, targets: g.targets, noSave: true },
      deps,
    );
    outcomes.push(...r.outcomes);
    warnings.push(...r.warnings);
  }
  return { outcomes: dedupeOutcomes(outcomes), warnings: [...new Set(warnings)] };
}
