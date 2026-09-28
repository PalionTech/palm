import path from 'node:path';
import type { TargetLayout, TargetSpec } from './base.js';
import { type Env, envDir } from './env.js';
import { pathExists } from './fs-utils.js';

/** Copilot CLI home: `$COPILOT_HOME` or `~/.copilot`. */
export function copilotHome(scopeRoot: string, env: Env): string {
  return envDir(env, 'COPILOT_HOME', scopeRoot, path.join(scopeRoot, '.copilot'));
}

export const copilotSpec: TargetSpec = {
  id: 'copilot',
  displayName: 'GitHub Copilot',
  layout(scope, scopeRoot, env): TargetLayout {
    const agentsRoot = path.join(scopeRoot, '.agents');
    const skillsRoot = { dir: path.join(agentsRoot, 'skills'), stop: agentsRoot };
    if (scope === 'project') {
      const gh = path.join(scopeRoot, '.github');
      const mcpFile = path.join(scopeRoot, '.vscode', 'mcp.json');
      const sub = (name: string): string => path.join(gh, name);
      return {
        configDir: gh,
        skillsDir: skillsRoot.dir,
        agentsDir: sub('agents'),
        instructions: { dir: sub('instructions') },
        commands: { dir: sub('prompts') },
        hooks: { dir: sub('hooks') },
        mcp: { json: mcpFile, pointer: '/servers' },
        roots: [
          ...['agents', 'instructions', 'prompts', 'hooks'].map((n) => ({ dir: sub(n), stop: gh })),
          skillsRoot,
        ],
        mergedFiles: [mcpFile],
      };
    }
    const home = copilotHome(scopeRoot, env);
    const mcpFile = path.join(home, 'mcp-config.json');
    return {
      configDir: home,
      skillsDir: skillsRoot.dir,
      agentsDir: path.join(home, 'agents'),
      instructions: { dir: path.join(home, 'instructions') },
      commands: {
        skip: 'Copilot has no user-level prompt files; command skipped (install without -g for .github/prompts)',
      },
      hooks: { dir: path.join(home, 'hooks') },
      mcp: { json: mcpFile, pointer: '/mcpServers' },
      roots: [{ dir: home, stop: home }, skillsRoot],
      mergedFiles: [mcpFile],
    };
  },
  async detect(scope, scopeRoot, env) {
    if (scope === 'project') {
      for (const p of ['.github/copilot-instructions.md', '.github/agents', '.vscode/mcp.json']) {
        if (await pathExists(path.join(scopeRoot, p))) return true;
      }
      return false;
    }
    return pathExists(copilotHome(scopeRoot, env));
  },
};
