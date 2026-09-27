import { hashValue } from '../core/hash.js';
import { loadLock } from '../core/lockfile.js';
import { isMcpManifestEntry, listDeps, loadManifest } from '../core/manifest.js';
import { lockPath, manifestPath } from '../core/paths.js';
import {
  KINDS,
  type DepRef,
  type InstallOutcome,
  type InstallResult,
  type Kind,
  type LockEntry,
  type Manifest,
  type McpManifestEntry,
  type McpServerConfig,
  type PalmContext,
  type Scope,
  type TargetId,
} from '../core/types.js';
import { type EngineDeps } from './deps.js';
import { installEntities, type EngineInstallRequest } from './install.js';
import { resolveTargets } from './resolve-targets.js';
import { uninstallEntities } from './uninstall.js';

/** Canonical MCP config for an ad hoc manifest entry (`command` or `url`). */
export function adhocConfig(dep: McpManifestEntry): McpServerConfig {
  const cfg: McpServerConfig = { name: dep.name, transport: dep.transport ?? (dep.url ? 'http' : 'stdio') };
  if (dep.command) cfg.command = dep.command;
  if (dep.args) cfg.args = dep.args;
  if (dep.env) cfg.env = dep.env;
  if (dep.url) cfg.url = dep.url;
  if (dep.headers) cfg.headers = dep.headers;
  cfg.source = { type: 'adhoc' };
  return cfg;
}

type ManifestDep = { kind: Kind; dep: DepRef | McpManifestEntry };

function manifestDeps(m: Manifest): ManifestDep[] {
  const out: ManifestDep[] = [];
  for (const kind of KINDS) for (const dep of listDeps(m, kind)) out.push({ kind, dep });
  return out;
}

/** Does lock entry `e` satisfy manifest dependency `d` (ignoring refs)? */
function satisfies(e: LockEntry, d: ManifestDep): boolean {
  if (e.kind !== d.kind) return false;
  const name = d.dep.name.toLowerCase();
  if (e.name.toLowerCase() === name) return true;
  if (e.kind === 'mcp' && e.origin === 'registry') {
    const reg = isMcpManifestEntry(d.dep) ? d.dep.registry : d.dep.name;
    return !!reg && e.path.toLowerCase() === reg.toLowerCase();
  }
  return false;
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
  if (dep.origin && e.origin.toLowerCase() !== dep.origin.toLowerCase()) return false;
  if (dep.ref && e.ref !== dep.ref && !(e.sha && e.sha.startsWith(dep.ref))) return false;
  return true;
}

function toRequest(d: ManifestDep): EngineInstallRequest {
  const dep = d.dep;
  if (d.kind === 'mcp' && isMcpManifestEntry(dep)) {
    if (dep.registry) {
      const spec: DepRef = { name: dep.registry };
      if (dep.version) spec.ref = dep.version;
      return { kind: 'mcp', spec, registry: dep.registry };
    }
    if (dep.command || dep.url) return { kind: 'mcp', spec: dep.name, adhocMcp: adhocConfig(dep) };
    return { kind: 'mcp', spec: dep.name };
  }
  return { kind: d.kind, spec: dep as DepRef };
}

/** `palm install` with no arguments: install what the manifest lists, report (or prune) the rest. */
export async function syncManifest(
  ctx: PalmContext,
  opts: { scope: Scope; prune: boolean; targets?: TargetId[] },
  deps?: Partial<EngineDeps>,
): Promise<InstallResult & { extraneous: LockEntry[] }> {
  const manifest = await loadManifest(manifestPath(ctx.paths, opts.scope));
  const wanted = manifestDeps(manifest);
  const lockBefore = await loadLock(lockPath(ctx.paths, opts.scope));
  const targets = opts.targets?.length ? opts.targets : await resolveTargets(ctx, { scope: opts.scope }, deps);

  const outcomes: InstallOutcome[] = [];
  const requests: EngineInstallRequest[] = [];
  for (const d of wanted) {
    const present = lockBefore.entries.find((e) => satisfies(e, d));
    if (present && !ctx.flags.force && upToDate(present, d, targets)) {
      outcomes.push({ entry: present, status: 'unchanged', notes: [] });
    } else {
      requests.push(toRequest(d));
    }
  }

  const result: InstallResult = requests.length
    ? await installEntities(ctx, requests, { scope: opts.scope, targets, noSave: true }, deps)
    : { outcomes: [], warnings: [] };

  const lock = ctx.flags.dryRun
    ? { entries: [...lockBefore.entries.filter((e) => !result.outcomes.some((o) => o.entry.kind === e.kind && o.entry.name === e.name)), ...result.outcomes.map((o) => o.entry)] }
    : await loadLock(lockPath(ctx.paths, opts.scope));
  const extraneous = lock.entries.filter((e) => !e.via && !wanted.some((d) => satisfies(e, d)));

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
  return { outcomes: [...outcomes, ...result.outcomes], warnings, extraneous };
}
