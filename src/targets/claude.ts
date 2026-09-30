import path from 'node:path';
import type { ScopePaths } from '../domain/scope-paths.js';
import { pathExists } from '../lib/fs.js';
import {
  DISPLAY_NAMES,
  envSet,
  fixedSkillsDir,
  outputDirsOf,
  type TargetLayout,
  type TargetSpec,
} from './layout.js';

/** User MCP config: `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when set. */
function claudeUserConfig(paths: ScopePaths): string {
  const dir = envSet(paths.env, 'CLAUDE_CONFIG_DIR')
    ? paths.harnessHome('claude')
    : paths.token('home');
  return path.join(dir, '.claude.json');
}

function claudeLayout(paths: ScopePaths): TargetLayout {
  const base = paths.harnessHome('claude');
  const mcpFile =
    paths.scope === 'project' ? path.join(paths.root, '.mcp.json') : claudeUserConfig(paths);
  const settings = path.join(base, 'settings.json');
  const skills = { dir: path.join(base, 'skills'), stop: base };
  return {
    configDir: base,
    skillsDir: fixedSkillsDir(skills),
    agentsDir: path.join(base, 'agents'),
    instructions: { dir: path.join(base, 'rules') },
    hooks: { mergeFile: settings },
    mcp: { json: mcpFile, path: ['mcpServers'] },
    roots: [{ dir: base, stop: base }],
    mergedFiles: [settings, mcpFile],
  };
}

export const claudeSpec: TargetSpec = {
  id: 'claude',
  displayName: DISPLAY_NAMES.claude,
  layout: claudeLayout,
  async detect(paths) {
    if (paths.scope === 'project')
      return (
        (await pathExists(path.join(paths.root, '.claude'))) ||
        pathExists(path.join(paths.root, 'CLAUDE.md'))
      );
    return pathExists(paths.harnessHome('claude'));
  },
  outputDirs: (paths) => outputDirsOf(claudeLayout(paths), paths),
};
