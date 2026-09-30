/**
 * Cursor reads `.claude/skills` and `.agents/skills` and dedupes by name, so with claude active
 * a project skill is written once, into `.claude/skills`; otherwise into the shared
 * `.agents/skills`. At global scope Cursor's skills go to `<agents>/skills`.
 */
import path from 'node:path';
import type { TargetId } from '../core/types.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import {
  type CleanupRoot,
  DISPLAY_NAMES,
  outputDirsOf,
  sharedSkillsRoot,
  type TargetLayout,
  type TargetSpec,
} from './layout.js';

/** `.claude/skills` inside the project: where cursor writes when claude is active. */
function claudeSkillsRoot(paths: ScopePaths): CleanupRoot {
  const claude = paths.harnessHome('claude');
  return { dir: path.join(claude, 'skills'), stop: claude };
}

const GLOBAL_RULES_NOTE =
  'Cursor keeps user rules in Cursor Settings, not in files; instruction <name> skipped at global scope (install it in a project for .cursor/rules)';

function cursorLayout(paths: ScopePaths): TargetLayout {
  const base = paths.harnessHome('cursor');
  const shared = sharedSkillsRoot(paths);
  const project = paths.scope === 'project';
  const viaClaude = project ? [claudeSkillsRoot(paths)] : [];
  const hooks = path.join(base, 'hooks.json');
  const mcp = path.join(base, 'mcp.json');
  return {
    configDir: base,
    skillsDir: (active: readonly TargetId[]) =>
      project && active.includes('claude') ? claudeSkillsRoot(paths).dir : shared.dir,
    agentsDir: path.join(base, 'agents'),
    instructions: project ? { dir: path.join(base, 'rules') } : { skip: GLOBAL_RULES_NOTE },
    hooks: { mergeFile: hooks, versioned: true },
    mcp: { json: mcp, path: ['mcpServers'] },
    roots: [{ dir: base, stop: base }, shared, ...viaClaude],
    mergedFiles: [hooks, mcp],
  };
}

export const cursorSpec: TargetSpec = {
  id: 'cursor',
  displayName: DISPLAY_NAMES.cursor,
  layout: cursorLayout,
  markers: (paths) => [paths.harnessHome('cursor')],
  outputDirs: (paths) => outputDirsOf(cursorLayout(paths), paths),
};
