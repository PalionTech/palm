import path from 'node:path';
import type { TargetLayout, TargetSpec } from './base.js';
import { pathExists } from './fs-utils.js';

export const cursorSpec: TargetSpec = {
  id: 'cursor',
  displayName: 'Cursor',
  layout(scope, scopeRoot): TargetLayout {
    const base = path.join(scopeRoot, '.cursor');
    const agentsRoot = path.join(scopeRoot, '.agents');
    return {
      configDir: base,
      skillsDir: path.join(agentsRoot, 'skills'),
      agentsDir: path.join(base, 'agents'),
      instructions:
        scope === 'project'
          ? { dir: path.join(base, 'rules') }
          : {
              skip: 'Cursor user rules live in Cursor Settings → Rules, not in files; instruction skipped (install without -g for .cursor/rules)',
            },
      commands: { dir: path.join(base, 'commands') },
      hooks: { mergeFile: path.join(base, 'hooks.json'), versioned: true },
      mcp: { json: path.join(base, 'mcp.json'), pointer: '/mcpServers' },
      roots: [
        { dir: base, stop: base },
        { dir: path.join(agentsRoot, 'skills'), stop: agentsRoot },
      ],
      mergedFiles: [path.join(base, 'hooks.json'), path.join(base, 'mcp.json')],
    };
  },
  async detect(_scope, scopeRoot) {
    return pathExists(path.join(scopeRoot, '.cursor'));
  },
};
