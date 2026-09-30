/**
 * The CLI's one door to the layers below. Every engine operation a command runs, and the few
 * core, index and exec helpers a command needs while it runs, are imported on first use, so
 * `palm --help` loads none of them (DESIGN.md §10 "Startup"). Signatures are API.md's.
 *
 * `CliDeps` is what `CliOptions.deps` carries: the engine's own collaborators (`EngineDeps`,
 * passed through to every engine call) plus any of the operations below, which replace the real
 * ones. Tests fake the engine this way; production passes nothing.
 *
 * It lives in src/create because `create` runs an install too, and create never imports
 * src/commands (commands -> create -> ui).
 */
import type {
  AllowExec,
  CheckReport,
  EngineDeps,
  Entity,
  EntityRefSpec,
  InstallOptions,
  InstallRequest,
  InstallResult,
  LayoutDescriptor,
  LockEntry,
  LockSource,
  McpRequest,
  McpServerConfig,
  MigrateReport,
  PalmContext,
  PalmPaths,
  RemoveResult,
  Scope,
  SourceCheckout,
  SourceIndex,
  Target,
  TargetId,
  UpdatePlan,
} from '../core/types.js';
import type { Manifest } from '../domain/manifest.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import type { SourceRef } from '../domain/source.js';
import type { EntityInfo } from '../engine/query.js';
import type { ScopeState } from '../engine/scope.js';

export type { EntityInfo, ScopeState, SourceRef };

/** What `listSource` returns: the source fetched and indexed, nothing saved. */
export interface SourceListing {
  source: SourceRef;
  checkout: SourceCheckout;
  index: SourceIndex;
  declared: boolean;
  /** The source as the listing's lines name it: the key once declared, else as typed (K9, D9). */
  paste?: string;
}

export interface InstalledRow {
  entry: LockEntry;
  source: LockSource;
  layer: 'team' | 'local';
}

interface PathOwner {
  entry: LockEntry;
  match: 'file' | 'inside' | 'merged';
  file: string;
}

/** The operations the CLI runs (API.md, src/engine and the helpers named below). */
export interface EngineApi {
  openScope(ctx: PalmContext, scope: Scope, opts?: { readOnly?: boolean }): Promise<ScopeState>;
  installFromSource(
    ctx: PalmContext,
    req: InstallRequest,
    opts: InstallOptions,
    deps?: Partial<EngineDeps>,
  ): Promise<InstallResult>;
  listSource(
    ctx: PalmContext,
    input: string,
    opts: { scope: Scope; layout?: LayoutDescriptor },
    deps?: Partial<EngineDeps>,
  ): Promise<SourceListing>;
  installMcp(
    ctx: PalmContext,
    reqs: McpRequest[],
    opts: InstallOptions & { force?: boolean },
    deps?: Partial<EngineDeps>,
  ): Promise<InstallResult>;
  syncScope(
    ctx: PalmContext,
    opts: InstallOptions,
    deps?: Partial<EngineDeps>,
  ): Promise<InstallResult>;
  removeEntities(
    ctx: PalmContext,
    refs: Array<EntityRefSpec & { source?: string }>,
    opts: InstallOptions & { exclude?: boolean },
    deps?: Partial<EngineDeps>,
  ): Promise<RemoveResult>;
  planUpdate(
    ctx: PalmContext,
    sources: string[],
    opts: { scope: Scope; to?: string },
    deps?: Partial<EngineDeps>,
  ): Promise<UpdatePlan>;
  applyUpdate(
    ctx: PalmContext,
    plan: UpdatePlan,
    opts: { scope: Scope; to?: string },
    deps?: Partial<EngineDeps>,
  ): Promise<InstallResult>;
  planChanges(plan: UpdatePlan): number;
  reviewText(ctx: PalmContext, plan: UpdatePlan, deps: EngineDeps): Promise<string>;
  checkScope(
    ctx: PalmContext,
    opts: { scope: Scope },
    deps?: Partial<EngineDeps>,
  ): Promise<CheckReport>;
  migrateScope(
    ctx: PalmContext,
    opts: { scope: Scope; dryRun: boolean },
    deps?: Partial<EngineDeps>,
  ): Promise<MigrateReport>;
  listInstalled(
    ctx: PalmContext,
    scope: Scope,
    q?: { kind?: EntityRefSpec['kind']; names?: string[]; source?: string },
  ): Promise<InstalledRow[]>;
  describeEntity(
    ctx: PalmContext,
    q: EntityRefSpec & { source?: string },
    opts: { scope: Scope },
    deps?: Partial<EngineDeps>,
  ): Promise<EntityInfo>;
  ownerOfPath(ctx: PalmContext, query: string, opts: { scope: Scope }): Promise<PathOwner[]>;
  detectTargets(ctx: PalmContext, paths: ScopePaths, deps: EngineDeps): Promise<TargetId[]>;
  requestInstallStop(): void;
  resolveEngineDeps(partial?: Partial<EngineDeps>): Promise<EngineDeps>;
  /** src/exec/units.ts */
  isExecutable(entity: Entity): boolean;
  /** src/exec/consent.ts */
  parseAllowExec(text: string | undefined): AllowExec[] | 'all';
  /** src/index/mcp.ts */
  parseMcpJson(json: unknown): McpServerConfig[];
  /** src/core/paths.ts */
  enclosingProject(cwd: string, stopAt: string): string | undefined;
  /** src/core/cache.ts */
  cleanCache(paths: PalmPaths): Promise<{ removedBytes: number }>;
  /** src/domain/scope-paths.ts `new ScopePaths(...)` */
  scopePaths(scope: Scope, root: string, palmHome: string, env: NodeJS.ProcessEnv): ScopePaths;
  /** src/domain/manifest.ts `Manifest.load` */
  loadManifest(file: string): Promise<Manifest>;
}

/** `CliOptions.deps`: engine collaborators plus replacements for any operation. */
export type CliDeps = Partial<EngineDeps> & Partial<EngineApi>;

/** Every operation, returning a promise whether the real one is async or not. */
export type Engine = {
  [K in keyof EngineApi]: (
    ...args: Parameters<EngineApi[K]>
  ) => Promise<Awaited<ReturnType<EngineApi[K]>>>;
};

type Loaders = { [K in keyof EngineApi]: () => Promise<EngineApi[K]> };

const LOADERS: Loaders = {
  openScope: async () => (await import('../engine/scope.js')).openScope,
  installFromSource: async () => (await import('../engine/install.js')).installFromSource,
  listSource: async () => (await import('../engine/install.js')).listSource,
  installMcp: async () => (await import('../engine/install.js')).installMcp,
  requestInstallStop: async () => (await import('../engine/install.js')).requestInstallStop,
  syncScope: async () => (await import('../engine/sync.js')).syncScope,
  removeEntities: async () => (await import('../engine/remove.js')).removeEntities,
  planUpdate: async () => (await import('../engine/update.js')).planUpdate,
  applyUpdate: async () => (await import('../engine/update.js')).applyUpdate,
  planChanges: async () => (await import('../engine/update.js')).planChanges,
  reviewText: async () => (await import('../engine/update.js')).reviewText,
  checkScope: async () => (await import('../engine/check.js')).checkScope,
  migrateScope: async () => (await import('../engine/migrate.js')).migrateScope,
  listInstalled: async () => (await import('../engine/query.js')).listInstalled,
  describeEntity: async () => (await import('../engine/query.js')).describeEntity,
  ownerOfPath: async () => (await import('../engine/query.js')).ownerOfPath,
  detectTargets: async () => (await import('../engine/targets.js')).detectTargets,
  resolveEngineDeps: async () => (await import('../engine/deps.js')).resolveEngineDeps,
  isExecutable: async () => (await import('../exec/units.js')).isExecutable,
  parseAllowExec: async () => (await import('../exec/consent.js')).parseAllowExec,
  parseMcpJson: async () => (await import('../index/mcp.js')).parseMcpJson,
  enclosingProject: async () => (await import('../core/paths.js')).enclosingProject,
  cleanCache: async () => (await import('../core/cache.js')).cleanCache,
  scopePaths: async () => {
    const { ScopePaths } = await import('../domain/scope-paths.js');
    return (scope, root, palmHome, env) => new ScopePaths(scope, root, palmHome, env);
  },
  loadManifest: async () => {
    const { Manifest } = await import('../domain/manifest.js');
    return (file) => Manifest.load(file);
  },
};

const ENGINE_DEP_KEYS = [
  'scan',
  'getTarget',
  'execUnit',
  'askConsent',
  'scanSecrets',
  'decideSecret',
  'resolveSecrets',
] as const satisfies ReadonlyArray<keyof EngineDeps>;

/** The operations, each taken from `deps` when it has one, else imported on first use. */
export function engineOf(deps: CliDeps = {}): Engine {
  const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const key of Object.keys(LOADERS) as Array<keyof EngineApi>) {
    api[key] = async (...args: unknown[]) => {
      const fn = (deps[key] ?? (await LOADERS[key]())) as (...a: unknown[]) => unknown;
      return fn(...args);
    };
  }
  return api as unknown as Engine;
}

/** The engine collaborators in `deps`, to pass into engine calls. */
export function engineDepsOf(deps: CliDeps = {}): Partial<EngineDeps> {
  const picked: Partial<Record<keyof EngineDeps, unknown>> = {};
  for (const key of ENGINE_DEP_KEYS) if (deps[key]) picked[key] = deps[key];
  return picked as Partial<EngineDeps>;
}

/** The target implementation for `id`: the one in `deps`, else the engine's default. */
export async function targetOf(deps: CliDeps, id: TargetId): Promise<Target> {
  if (deps.getTarget) return deps.getTarget(id);
  return (await engineOf(deps).resolveEngineDeps(engineDepsOf(deps))).getTarget(id);
}
