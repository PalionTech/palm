import path from 'node:path';
import type { ScopePaths } from '../domain/scope-paths.js';
import { pathExists } from '../lib/fs.js';
import {
  DISPLAY_NAMES,
  fixedSkillsDir,
  outputDirsOf,
  sharedSkillsRoot,
  type TargetLayout,
  type TargetSpec,
} from './layout.js';

function codexLayout(paths: ScopePaths): TargetLayout {
  const base = paths.harnessHome('codex');
  const skills = sharedSkillsRoot(paths);
  const agentsMd = path.join(paths.scope === 'project' ? paths.root : base, 'AGENTS.md');
  const hooks = path.join(base, 'hooks.json');
  const config = path.join(base, 'config.toml');
  return {
    configDir: base,
    skillsDir: fixedSkillsDir(skills),
    agentsDir: path.join(base, 'agents'),
    instructions: { blockFile: agentsMd },
    hooks: { mergeFile: hooks },
    mcp: { toml: config },
    roots: [{ dir: base, stop: base }, skills],
    mergedFiles: [hooks, config, agentsMd],
  };
}

export const codexSpec: TargetSpec = {
  id: 'codex',
  displayName: DISPLAY_NAMES.codex,
  layout: codexLayout,
  async detect(paths) {
    if (paths.scope === 'project')
      return (
        (await pathExists(path.join(paths.root, '.codex'))) ||
        pathExists(path.join(paths.root, 'AGENTS.md'))
      );
    return pathExists(paths.harnessHome('codex'));
  },
  outputDirs: (paths) => outputDirsOf(codexLayout(paths), paths),
};
