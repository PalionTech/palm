import path from 'node:path';
import type { Scope } from '../core/types.js';
import { pathExists } from '../lib/fs.js';
import type { TargetLayout, TargetSpec } from './base.js';
import { type Env, envDir } from './env.js';

/** `~/.claude` honouring CLAUDE_CONFIG_DIR (global), `<project>/.claude` (project). */
export function claudeDir(scope: Scope, scopeRoot: string, env: Env): string {
  const def = path.join(scopeRoot, '.claude');
  return scope === 'project' ? def : envDir(env, 'CLAUDE_CONFIG_DIR', scopeRoot, def);
}

/** User MCP config: `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when set. */
export function claudeUserConfig(scopeRoot: string, env: Env): string {
  return env.CLAUDE_CONFIG_DIR
    ? path.join(claudeDir('global', scopeRoot, env), '.claude.json')
    : path.join(scopeRoot, '.claude.json');
}

export const claudeSpec: TargetSpec = {
  id: 'claude',
  displayName: 'Claude Code',
  layout(scope, scopeRoot, env): TargetLayout {
    const base = claudeDir(scope, scopeRoot, env);
    const mcpFile =
      scope === 'project' ? path.join(scopeRoot, '.mcp.json') : claudeUserConfig(scopeRoot, env);
    return {
      configDir: base,
      skillsDir: path.join(base, 'skills'),
      agentsDir: path.join(base, 'agents'),
      instructions: { dir: path.join(base, 'rules') },
      commands: { dir: path.join(base, 'commands') },
      hooks: { mergeFile: path.join(base, 'settings.json') },
      mcp: { json: mcpFile, pointer: '/mcpServers' },
      roots: [{ dir: base, stop: base }],
      mergedFiles: [path.join(base, 'settings.json'), mcpFile],
    };
  },
  async detect(scope, scopeRoot, env) {
    if (scope === 'project')
      return (
        (await pathExists(path.join(scopeRoot, '.claude'))) ||
        pathExists(path.join(scopeRoot, 'CLAUDE.md'))
      );
    return pathExists(claudeDir('global', scopeRoot, env));
  },
};
