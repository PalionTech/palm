import { loadConfig } from './config.js';
import { resolvePaths } from './paths.js';
import type { Logger, PalmContext, UI } from './types.js';

export interface ContextInit {
  cwd: string;
  env: NodeJS.ProcessEnv;
  ui: UI;
  log: Logger;
  flags: PalmContext['flags'];
}

/** Build the context for one command. Reads config (defaults when missing); writes nothing. */
export async function createContext(init: ContextInit): Promise<PalmContext> {
  const paths = resolvePaths(init.cwd, init.env);
  const config = await loadConfig(paths);
  return { paths, config, ui: init.ui, log: init.log, env: init.env, flags: { ...init.flags } };
}
