import path from 'node:path';
import { pathExists } from '../lib/fs.js';
import type { TargetLayout, TargetSpec } from './layout.js';
import { sharedSkillsRoot } from './shared-skills.js';

export const cursorSpec: TargetSpec = {
  id: 'cursor',
  displayName: 'Cursor',
  layout(paths): TargetLayout {
    const base = paths.harnessHome('cursor');
    const skills = sharedSkillsRoot(paths);
    return {
      configDir: base,
      skillsDir: skills.dir,
      agentsDir: path.join(base, 'agents'),
      instructions:
        paths.scope === 'project'
          ? { dir: path.join(base, 'rules') }
          : {
              skip: 'Cursor user rules live in Cursor Settings → Rules, not in files; instruction skipped (for .cursor/rules: `palm install instruction <name>` without -g)',
            },
      commands: { dir: path.join(base, 'commands') },
      hooks: { mergeFile: path.join(base, 'hooks.json'), versioned: true },
      mcp: { json: path.join(base, 'mcp.json'), path: ['mcpServers'] },
      roots: [{ dir: base, stop: base }, skills],
      mergedFiles: [path.join(base, 'hooks.json'), path.join(base, 'mcp.json')],
    };
  },
  async detect(paths) {
    return pathExists(paths.harnessHome('cursor'));
  },
};
