import path from 'node:path';
import type { Scope } from '../core/types.js';
import { pathExists } from '../lib/fs.js';
import type { TargetLayout, TargetSpec } from './base.js';
import { type Env, envDir } from './env.js';

/** `~/.codex` honouring CODEX_HOME (global), `<project>/.codex` (project). */
export function codexDir(scope: Scope, scopeRoot: string, env: Env): string {
  const def = path.join(scopeRoot, '.codex');
  return scope === 'project' ? def : envDir(env, 'CODEX_HOME', scopeRoot, def);
}

export const codexSpec: TargetSpec = {
  id: 'codex',
  displayName: 'Codex',
  layout(scope, scopeRoot, env): TargetLayout {
    const base = codexDir(scope, scopeRoot, env);
    const agentsRoot = path.join(scopeRoot, '.agents');
    const agentsMd =
      scope === 'project' ? path.join(scopeRoot, 'AGENTS.md') : path.join(base, 'AGENTS.md');
    return {
      configDir: base,
      skillsDir: path.join(agentsRoot, 'skills'),
      agentsDir: path.join(base, 'agents'),
      instructions: { agentsMd },
      commands:
        scope === 'project'
          ? {
              skip: 'Codex has no project-scoped custom prompts; command skipped (install with -g for ~/.codex/prompts)',
            }
          : { dir: path.join(base, 'prompts') },
      hooks: { mergeFile: path.join(base, 'hooks.json') },
      mcp: { toml: path.join(base, 'config.toml') },
      roots: [
        { dir: base, stop: base },
        { dir: path.join(agentsRoot, 'skills'), stop: agentsRoot },
      ],
      mergedFiles: [path.join(base, 'hooks.json'), path.join(base, 'config.toml'), agentsMd],
    };
  },
  async detect(scope, scopeRoot, env) {
    if (scope === 'project')
      return (
        (await pathExists(path.join(scopeRoot, '.codex'))) ||
        pathExists(path.join(scopeRoot, 'AGENTS.md'))
      );
    return pathExists(codexDir('global', scopeRoot, env));
  },
};
