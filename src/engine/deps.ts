import { messageOf, PalmError } from '../core/errors.js';
import type { EngineDeps, Target, TargetId } from '../core/types.js';

export type { EngineDeps } from '../core/types.js';

const DISPLAY_NAMES: Record<TargetId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
};

function unavailable(what: string, file: string, e: unknown): PalmError {
  return new PalmError('E_INTERNAL', `${what} module unavailable (${file}): ${messageOf(e)}`);
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

const lazyScan: EngineDeps['scan'] = async (root, spec) =>
  (await importScan()).scanOrigin(root, spec);
const lazyResolveRegistry: EngineDeps['resolveRegistry'] = async (name, opts) =>
  (await importRegistry()).resolveRegistry(name, opts);
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
      if (!loaded)
        throw new PalmError(
          'E_INTERNAL',
          `Target ${id} is not loaded yet; call an async method first`,
        );
      return loaded.configDir(scope, root, env);
    },
    deploy: async (input) => (await load()).deploy(input),
    undeploy: async (...args) => (await load()).undeploy(...args),
  };
}

/** Default collaborators, each dynamically imported on first use. */
function defaultEngineDeps(): EngineDeps {
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
export async function resolveEngineDeps(
  partial: Partial<EngineDeps> = {},
  opts: { targets?: boolean } = {},
): Promise<EngineDeps> {
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
