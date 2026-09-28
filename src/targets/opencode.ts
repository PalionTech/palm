/**
 * OpenCode (research R7, checked 2026-09-28 against opencode `dev`, v1.18.33).
 *
 * - Home: `~/.config/opencode`, or `$XDG_CONFIG_HOME/opencode` (ScopePaths.harnessHome). The
 *   project config is `opencode.json` at the root; palm writes it even when `opencode.jsonc`
 *   exists, "since both are loaded and merged".
 * - Instructions: one file per instruction in `.opencode/instructions/`, listed in
 *   `opencode.json#/instructions` (an absolute path in the global config). Writing `AGENTS.md`
 *   instead would shadow an existing `CLAUDE.md` ("the first `AGENTS.md`, else `CLAUDE.md`").
 * - Hooks: "No declarative hooks. Plugins are JS/TS modules", so hooks are skipped.
 * - `.opencode` is a stop dir: OpenCode writes `.gitignore`, `package.json` and `node_modules`
 *   into it.
 */
import path from 'node:path';
import type { ScopePaths } from '../domain/scope-paths.js';
import { pathExists } from '../lib/fs.js';
import type { CleanupRoot, TargetLayout, TargetSpec } from './layout.js';
import { sharedSkillsRoot } from './shared-skills.js';

/** OpenCode's boolean flags: "true" or "1" (packages/core/src/flag/flag.ts). */
function flagSet(value: string | undefined): boolean {
  const v = value?.toLowerCase();
  return v === 'true' || v === '1';
}

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

export const opencodeSpec: TargetSpec = {
  id: 'opencode',
  displayName: 'OpenCode',
  layout(paths): TargetLayout {
    const base = paths.harnessHome('opencode');
    const skills = skillsRoot(paths, base);
    const config = path.join(paths.scope === 'project' ? paths.root : base, 'opencode.json');
    return {
      configDir: base,
      skillsDir: skills.dir,
      agentsDir: path.join(base, 'agents'),
      instructions: {
        dir: path.join(base, 'instructions'),
        list: { json: config, path: ['instructions'] },
      },
      commands: { dir: path.join(base, 'commands') },
      hooks: { skip: 'hooks <name>: OpenCode hooks are JS plugins; not installed' },
      mcp: { json: config, path: ['mcp'] },
      roots: [{ dir: base, stop: base }, skills],
      mergedFiles: [config],
    };
  },
  async detect(paths) {
    if (paths.scope === 'project') {
      for (const marker of ['.opencode', 'opencode.json', 'opencode.jsonc'])
        if (await pathExists(path.join(paths.root, marker))) return true;
      return false;
    }
    return pathExists(paths.harnessHome('opencode'));
  },
};
