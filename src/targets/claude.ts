import path from 'node:path';
import type { ScopePaths } from '../domain/scope-paths.js';
import { pathExists } from '../lib/fs.js';
import type { TargetLayout, TargetSpec } from './layout.js';

/** User MCP config: `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when set. */
function claudeUserConfig(paths: ScopePaths): string {
  return path.join(paths.harnessOverride('claude') ?? paths.root, '.claude.json');
}

export const claudeSpec: TargetSpec = {
  id: 'claude',
  displayName: 'Claude Code',
  layout(paths): TargetLayout {
    const base = paths.harnessHome('claude');
    const mcpFile =
      paths.scope === 'project' ? path.join(paths.root, '.mcp.json') : claudeUserConfig(paths);
    return {
      configDir: base,
      skillsDir: path.join(base, 'skills'),
      agentsDir: path.join(base, 'agents'),
      instructions: { dir: path.join(base, 'rules') },
      commands: { dir: path.join(base, 'commands') },
      hooks: { mergeFile: path.join(base, 'settings.json') },
      mcp: { json: mcpFile, path: ['mcpServers'] },
      roots: [{ dir: base, stop: base }],
      mergedFiles: [path.join(base, 'settings.json'), mcpFile],
    };
  },
  async detect(paths) {
    if (paths.scope === 'project')
      return (
        (await pathExists(path.join(paths.root, '.claude'))) ||
        pathExists(path.join(paths.root, 'CLAUDE.md'))
      );
    return pathExists(paths.harnessHome('claude'));
  },
};
