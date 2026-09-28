import { hashValue } from '../core/hash.js';
import {
  type DepRef as DepRefData,
  type InstallOutcome,
  type InstallRequest,
  type InstallResult,
  KINDS,
  type Kind,
  type LockEntry,
  type Manifest as ManifestData,
  type McpManifestEntry,
  type McpServerConfig,
  type PalmContext,
  type Scope,
  type SecretPolicy,
  type TargetId,
} from '../core/types.js';
import { DepRef, sameName } from '../domain/dep-ref.js';
import { entityId } from '../domain/entity-key.js';
import { Lock } from '../domain/lock.js';
import { depMatches, isMcpManifestEntry, Manifest } from '../domain/manifest.js';
import { ScopePaths } from '../domain/scope-paths.js';
import type { EngineDeps } from './deps.js';
import { dedupeOutcomes, installEntities } from './install.js';
import { resolveTargets } from './resolve-targets.js';
import { uninstallEntities } from './uninstall.js';

/** Canonical MCP config for an ad hoc manifest entry (`command` or `url`). */
export function adhocConfig(dep: McpManifestEntry): McpServerConfig {
  const cfg: McpServerConfig = {
    name: dep.name,
    transport: dep.transport ?? (dep.url ? 'http' : 'stdio'),
  };
  if (dep.command) cfg.command = dep.command;
  if (dep.args) cfg.args = dep.args;
  if (dep.env) cfg.env = dep.env;
  if (dep.url) cfg.url = dep.url;
  if (dep.headers) cfg.headers = dep.headers;
  cfg.source = { type: 'adhoc' };
  return cfg;
}

export type ManifestDep = { kind: Kind; dep: DepRefData | McpManifestEntry };

/** Every dependency the manifest lists, kind by kind. */
export function manifestDeps(m: ManifestData | Manifest): ManifestDep[] {
  const doc = m instanceof Manifest ? m : Manifest.of(m);
  return KINDS.flatMap((kind) => doc.deps(kind).map((dep) => ({ kind, dep })));
}

/**
 * Does lock entry `e` satisfy manifest dependency `d` (ignoring refs)? Registry MCP servers
 * are listed under their registry name (`io.github.upstash/context7`) but locked under their
 * config key (`context7`); the lock entry's `path` holds the registry name.
 */
export function satisfies(e: LockEntry, d: ManifestDep): boolean {
  return depMatches(d.kind, d.dep, e);
}

/** True when the lock entry is an exact, up-to-date realisation of the manifest dependency. */
function upToDate(e: LockEntry, d: ManifestDep, targets: TargetId[]): boolean {
  if (e.via) return false; // promote to a direct install
  if (!targets.every((t) => e.targets.includes(t))) return false;
  const dep = d.dep;
  if (isMcpManifestEntry(dep)) {
    if (dep.registry) return e.origin === 'registry' && (!dep.version || e.ref === dep.version);
    if (dep.command || dep.url) {
      const { source: _s, ...cfg } = adhocConfig(dep);
      return e.origin === 'adhoc' && e.contentHash === hashValue(cfg);
    }
    return true;
  }
  if (dep.origin && !sameName(e.origin, dep.origin)) return false;
  if (dep.ref && e.ref !== dep.ref && !e.sha?.startsWith(dep.ref)) return false;
  return true;
}

function toRequest(d: ManifestDep): InstallRequest {
  const dep = d.dep;
  if (d.kind === 'mcp' && isMcpManifestEntry(dep)) {
    if (dep.registry) {
      return {
        kind: 'mcp',
        spec: DepRef.of(dep.registry, undefined, dep.version),
        registry: dep.registry,
      };
    }
    if (dep.command || dep.url) return { kind: 'mcp', spec: dep.name, adhocMcp: adhocConfig(dep) };
    return { kind: 'mcp', spec: dep.name };
  }
  return { kind: d.kind, spec: dep as DepRefData };
}

/** What a dry run would leave in the lock: outcomes replace the entries of the same entity. */
function dryRunEntries(before: Lock, outcomes: InstallOutcome[]): LockEntry[] {
  const replaced = new Set(outcomes.map((o) => entityId(o.entry)));
  return [
    ...before.entries.filter((e) => !replaced.has(entityId(e))),
    ...outcomes.map((o) => o.entry),
  ];
}

/** `palm install` with no arguments: install what the manifest lists, report (or prune) the rest. */
export async function syncManifest(
  ctx: PalmContext,
  opts: { scope: Scope; prune: boolean; targets?: TargetId[]; secretPolicy?: SecretPolicy },
  deps?: Partial<EngineDeps>,
): Promise<InstallResult & { extraneous: LockEntry[] }> {
  const paths = ScopePaths.of(ctx, opts.scope);
  const wanted = manifestDeps(await Manifest.load(paths.manifestFile));
  const lockBefore = await Lock.load(paths.lockFile);
  const targets = opts.targets?.length
    ? opts.targets
    : await resolveTargets(ctx, { scope: opts.scope }, deps);

  const outcomes: InstallOutcome[] = [];
  const requests: InstallRequest[] = [];
  const installed = lockBefore.entries;
  for (const d of wanted) {
    const present = installed.find((e) => satisfies(e, d));
    if (
      present &&
      !ctx.flags.force &&
      upToDate(present, d, targets) &&
      lockBefore.intact(present, paths)
    ) {
      outcomes.push({ entry: present, status: 'unchanged', notes: [] });
    } else {
      requests.push(toRequest(d));
    }
  }

  const result: InstallResult = requests.length
    ? await installEntities(
        ctx,
        requests,
        {
          scope: opts.scope,
          targets,
          noSave: true,
          ...(opts.secretPolicy ? { secretPolicy: opts.secretPolicy } : {}),
        },
        deps,
      )
    : { outcomes: [], warnings: [] };

  const after = ctx.flags.dryRun
    ? dryRunEntries(lockBefore, result.outcomes)
    : (await Lock.load(paths.lockFile)).entries;
  const extraneous = after.filter((e) => !e.via && !wanted.some((d) => satisfies(e, d)));

  const warnings = [...result.warnings];
  if (opts.prune && extraneous.length) {
    const r = await uninstallEntities(
      ctx,
      extraneous.map((e) => ({ kind: e.kind, name: e.name, origin: e.origin })),
      { scope: opts.scope },
      deps,
    );
    warnings.push(...r.warnings);
  }
  return { outcomes: dedupeOutcomes([...outcomes, ...result.outcomes]), warnings, extraneous };
}
