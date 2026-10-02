/**
 * OpenCode (research R7, checked 2026-09-28 against opencode `dev`, v1.18.33).
 *
 * - Home: `~/.config/opencode`, or `$XDG_CONFIG_HOME/opencode` (ScopePaths.harnessHome). The
 *   project config is `opencode.json` at the root; palm writes it even when `opencode.jsonc`
 *   exists, "since both are loaded and merged".
 * - Instructions: one file per instruction in `.opencode/instructions/`, listed in
 *   `opencode.json#/instructions`. Writing `AGENTS.md` instead would shadow an existing
 *   `CLAUDE.md` ("the first `AGENTS.md`, else `CLAUDE.md`").
 * - Hooks: "No declarative hooks. Plugins are JS/TS modules", so hooks are skipped.
 * - `.opencode` is a stop dir: OpenCode writes `.gitignore`, `package.json` and `node_modules`
 *   into it.
 */
import path from 'node:path';
import type { ScopePaths } from '../domain/scope-paths.js';
import {
  type CleanupRoot,
  DISPLAY_NAMES,
  fixedSkillsDir,
  flagSet,
  outputDirsOf,
  sharedSkillsRoot,
  type TargetLayout,
  type TargetSpec,
} from './layout.js';

/**
 * OpenCode reads `.agents/skills` (up to the worktree) and `~/.agents/skills`, so the shared
 * directory serves it; `OPENCODE_DISABLE_EXTERNAL_SKILLS` turns those external directories off,
 * and palm then writes to OpenCode's own `.opencode/skills` / `~/.config/opencode/skills`.
 */
function skillsRoot(paths: ScopePaths, base: string): CleanupRoot {
  if (flagSet(paths.env.OPENCODE_DISABLE_EXTERNAL_SKILLS))
    return { dir: path.join(base, 'skills'), stop: base };
  return sharedSkillsRoot(paths);
}

function opencodeLayout(paths: ScopePaths): TargetLayout {
  const base = paths.harnessHome('opencode');
  const skills = skillsRoot(paths, base);
  const config = path.join(paths.scope === 'project' ? paths.root : base, 'opencode.json');
  return {
    configDir: base,
    skillsDir: fixedSkillsDir(skills),
    agentsDir: path.join(base, 'agents'),
    instructions: {
      dir: path.join(base, 'instructions'),
      list: { json: config, path: ['instructions'] },
    },
    hooks: { skip: 'OpenCode hooks are JS plugins; hook <name> not installed' },
    mcp: { json: config, path: ['mcp'] },
    roots: [{ dir: base, stop: base }, skills],
    mergedFiles: [config],
  };
}

export const opencodeSpec: TargetSpec = {
  id: 'opencode',
  displayName: DISPLAY_NAMES.opencode,
  layout: opencodeLayout,
  markers: (paths) =>
    paths.scope === 'project'
      ? ['.opencode', 'opencode.json', 'opencode.jsonc'].map((m) => path.join(paths.root, m))
      : [paths.harnessHome('opencode')],
  outputDirs: (paths) => outputDirsOf(opencodeLayout(paths), paths),
};
