import path from 'node:path';
import { pathExists } from '../lib/fs.js';
import type { TargetLayout, TargetSpec } from './base.js';
import { sharedSkillsRoot } from './shared-skills.js';

export const codexSpec: TargetSpec = {
  id: 'codex',
  displayName: 'Codex',
  layout(paths): TargetLayout {
    const base = paths.harnessHome('codex');
    const skills = sharedSkillsRoot(paths);
    const agentsMd =
      paths.scope === 'project' ? path.join(paths.root, 'AGENTS.md') : path.join(base, 'AGENTS.md');
    return {
      configDir: base,
      skillsDir: skills.dir,
      agentsDir: path.join(base, 'agents'),
      instructions: { agentsMd },
      commands:
        paths.scope === 'project'
          ? {
              skip: 'Codex has no project-scoped custom prompts; command skipped (install with -g for ~/.codex/prompts)',
            }
          : { dir: path.join(base, 'prompts') },
      hooks: { mergeFile: path.join(base, 'hooks.json') },
      mcp: { toml: path.join(base, 'config.toml') },
      roots: [{ dir: base, stop: base }, skills],
      mergedFiles: [path.join(base, 'hooks.json'), path.join(base, 'config.toml'), agentsMd],
    };
  },
  async detect(paths) {
    if (paths.scope === 'project')
      return (
        (await pathExists(path.join(paths.root, '.codex'))) ||
        pathExists(path.join(paths.root, 'AGENTS.md'))
      );
    return pathExists(paths.harnessHome('codex'));
  },
};
