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

function projectLayout(paths: ScopePaths): TargetLayout {
  const gh = path.join(paths.root, '.github');
  const mcpFile = path.join(paths.root, '.vscode', 'mcp.json');
  const sub = (name: string): string => path.join(gh, name);
  const skills = sharedSkillsRoot(paths);
  return {
    configDir: gh,
    skillsDir: fixedSkillsDir(skills),
    agentsDir: sub('agents'),
    instructions: { dir: sub('instructions') },
    hooks: { dir: sub('hooks') },
    mcp: { json: mcpFile, path: ['servers'] },
    roots: [...['agents', 'instructions', 'hooks'].map((n) => ({ dir: sub(n), stop: gh })), skills],
    mergedFiles: [mcpFile],
  };
}

function globalLayout(paths: ScopePaths): TargetLayout {
  const home = paths.harnessHome('copilot');
  const mcpFile = path.join(home, 'mcp-config.json');
  const skills = sharedSkillsRoot(paths);
  return {
    configDir: home,
    skillsDir: fixedSkillsDir(skills),
    agentsDir: path.join(home, 'agents'),
    instructions: { dir: path.join(home, 'instructions') },
    hooks: { dir: path.join(home, 'hooks') },
    mcp: { json: mcpFile, path: ['mcpServers'] },
    roots: [{ dir: home, stop: home }, skills],
    mergedFiles: [mcpFile],
  };
}

function copilotLayout(paths: ScopePaths): TargetLayout {
  return paths.scope === 'project' ? projectLayout(paths) : globalLayout(paths);
}

export const copilotSpec: TargetSpec = {
  id: 'copilot',
  displayName: DISPLAY_NAMES.copilot,
  layout: copilotLayout,
  markers: (paths) =>
    paths.scope === 'project'
      ? ['.github/copilot-instructions.md', '.github/agents', '.vscode/mcp.json'].map((p) =>
          path.join(paths.root, p),
        )
      : [paths.harnessHome('copilot')],
  outputDirs: (paths) => outputDirsOf(copilotLayout(paths), paths),
};
