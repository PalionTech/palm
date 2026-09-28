import { PalmError } from '../core/errors.js';
import type { Target, TargetId } from '../core/types.js';
import { TARGET_IDS } from '../core/types.js';
import { GenericTarget, type TargetSpec } from './base.js';
import { claudeSpec } from './claude.js';
import { codexSpec } from './codex.js';
import { copilotSpec } from './copilot.js';
import { cursorSpec } from './cursor.js';

const SPECS: Record<TargetId, TargetSpec> = {
  claude: claudeSpec,
  codex: codexSpec,
  copilot: copilotSpec,
  cursor: cursorSpec,
};

/**
 * Target bound to an environment. deploy()/undeploy() resolve CLAUDE_CONFIG_DIR,
 * CODEX_HOME, COPILOT_HOME and PALM_HOME from, in order: `input.env` (deploy) or the
 * 5th undeploy argument, this `env`, then process.env.
 */
export function createTarget(id: TargetId, env?: NodeJS.ProcessEnv): GenericTarget {
  const spec = SPECS[id];
  if (!spec)
    throw new PalmError(
      'E_TARGET',
      `unknown target "${String(id)}"`,
      `valid targets: ${TARGET_IDS.join(', ')}`,
    );
  return new GenericTarget(spec, env);
}

export function getTarget(id: TargetId): Target {
  return createTarget(id);
}

export function allTargets(): Target[] {
  return TARGET_IDS.map((id) => createTarget(id));
}

export type { TargetLayout } from './base.js';
export { GenericTarget } from './base.js';
