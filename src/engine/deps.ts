import { PalmError } from '../core/errors.js';
import type {
  DeployInput,
  LockEntry,
  McpServerConfig,
  PalmContext,
  ResolveRegistryFn,
  ScanOriginFn,
  Scope,
  SecretPolicy,
  Target,
  TargetId,
} from '../core/types.js';

/**
 * `Target.undeploy` with the optional environment the targets module accepts as a
 * 5th argument (not yet part of the core contract).
 */
export type UndeployWithEnv = (
  entry: LockEntry,
  scope: Scope,
  scopeRoot: string,
  dryRun: boolean,
  env?: NodeJS.ProcessEnv,
) => Promise<void>;

/** DeployInput plus the environment used for CLAUDE_CONFIG_DIR / CODEX_HOME resolution. */
export type DeployInputWithEnv = DeployInput & { env?: NodeJS.ProcessEnv };

/** Undeploy through a target, passing the context environment along. */
export async function undeployWithEnv(
  target: Target,
  entry: LockEntry,
  scope: Scope,
  scopeRoot: string,
  dryRun: boolean,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await (target.undeploy as UndeployWithEnv).call(target, entry, scope, scopeRoot, dryRun, env);
}

/** Collaborators the engine calls into; tests replace them with fakes. */
export interface EngineDeps {
  scan: ScanOriginFn;
  getTarget: (id: TargetId) => Target;
  resolveRegistry: ResolveRegistryFn;
  resolveSecrets: (
    ctx: PalmContext,
    cfg: McpServerConfig,
    policy: SecretPolicy,
  ) => Promise<{ values: Record<string, string>; envRefs: string[] }>;
}

const DISPLAY_NAMES: Record<TargetId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
};

function unavailable(what: string, file: string, e: unknown): PalmError {
  return new PalmError('E_INTERNAL', `${what} module unavailable (${file}): ${(e as Error).message}`);
}

async function importScan() {
  try {
    return await import('../index/scan.js');
  } catch (e) {
    throw unavailable('Scanner', 'src/index/scan.ts', e);
  }
}

async function importTargets() {
  try {
    return await import('../targets/index.js');
  } catch (e) {
    throw unavailable('Targets', 'src/targets/index.ts', e);
  }
}

async function importRegistry() {
  try {
    return await import('../mcp/registry.js');
  } catch (e) {
    throw unavailable('MCP registry', 'src/mcp/registry.ts', e);
  }
}

async function importSecrets() {
  try {
    return await import('../mcp/secrets.js');
  } catch (e) {
    throw unavailable('MCP secrets', 'src/mcp/secrets.ts', e);
  }
}

const lazyScan: ScanOriginFn = async (root, spec) => (await importScan()).scanOrigin(root, spec);
const lazyResolveRegistry: ResolveRegistryFn = async (name, opts) => (await importRegistry()).resolveRegistry(name, opts);
const lazyResolveSecrets: EngineDeps['resolveSecrets'] = async (ctx, cfg, policy) =>
  (await importSecrets()).resolveSecrets(ctx, cfg, policy);

/** A Target whose implementation is imported on first async use. `configDir` needs the module loaded first. */
function lazyTarget(id: TargetId): Target {
  let loaded: Target | undefined;
  const load = async (): Promise<Target> => (loaded ??= (await importTargets()).getTarget(id));
  return {
    id,
    displayName: DISPLAY_NAMES[id],
    detect: async (scope, root, env) => (await load()).detect(scope, root, env),
    configDir: (scope, root, env) => {
      if (!loaded) throw new PalmError('E_INTERNAL', `Target ${id} is not loaded yet; call an async method first`);
      return loaded.configDir(scope, root, env);
    },
    deploy: async (input) => (await load()).deploy(input),
    undeploy: (async (entry: LockEntry, scope: Scope, root: string, dryRun: boolean, env?: NodeJS.ProcessEnv) =>
      undeployWithEnv(await load(), entry, scope, root, dryRun, env ?? process.env)) as Target['undeploy'],
  };
}

/** Default collaborators, each dynamically imported on first use. */
export function defaultEngineDeps(): EngineDeps {
  return {
    scan: lazyScan,
    getTarget: lazyTarget,
    resolveRegistry: lazyResolveRegistry,
    resolveSecrets: lazyResolveSecrets,
  };
}

/**
 * Merge caller-supplied collaborators over the defaults. With `targets: true`
 * the real targets module is loaded up front (so `configDir` works synchronously).
 */
export async function resolveEngineDeps(partial: Partial<EngineDeps> = {}, opts: { targets?: boolean } = {}): Promise<EngineDeps> {
  const defaults = defaultEngineDeps();
  let getTarget = partial.getTarget;
  if (!getTarget && opts.targets) getTarget = (await importTargets()).getTarget;
  return {
    scan: partial.scan ?? defaults.scan,
    getTarget: getTarget ?? defaults.getTarget,
    resolveRegistry: partial.resolveRegistry ?? defaults.resolveRegistry,
    resolveSecrets: partial.resolveSecrets ?? defaults.resolveSecrets,
  };
}
