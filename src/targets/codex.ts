import path from 'node:path';
import type { ScopePaths } from '../domain/scope-paths.js';
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
  // AGENTS.md alone never marks Codex: Copilot, Cursor, Gemini CLI and OpenCode read it too.
  markers: (paths) => [paths.harnessHome('codex')],
  outputDirs: (paths) => outputDirsOf(codexLayout(paths), paths),
};
