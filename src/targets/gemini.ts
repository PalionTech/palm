/**
 * Gemini CLI (research R7, checked 2026-09-28 against gemini-cli `main`, release v0.61.0).
 *
 * - Home: `~/.gemini`; `GEMINI_CLI_HOME` replaces the home, so the config dir becomes
 *   `$GEMINI_CLI_HOME/.gemini` (ScopePaths.harnessHome).
 * - Instructions: "Only `GEMINI.md` files load" and "there is no `.gemini/rules/` or
 *   instructions directory", so each instruction is a managed block in `GEMINI.md` (project
 *   root) or `~/.gemini/GEMINI.md`, like Codex's AGENTS.md.
 * - Hooks and MCP servers share `settings.json` (`hooks`, `mcpServers`).
 * - Plugins stay loose files: extensions install only into `~/.gemini/extensions` through
 *   Gemini's own installer, with no project scope.
 * Workspace settings, commands, skills, agents and MCP servers load only in trusted folders.
 */
import path from 'node:path';
import type { ScopePaths } from '../domain/scope-paths.js';
import { pathExists } from '../lib/fs.js';
import type { CleanupRoot, TargetLayout, TargetSpec } from './layout.js';
import { sharedSkillsRoot } from './shared-skills.js';

/**
 * Gemini reads the shared `.agents/skills` and `~/.agents/skills` ("the `.agents/skills/` alias
 * takes precedence over the `.gemini/skills/` directory", docs/cli/skills.md). With
 * `GEMINI_CLI_HOME` set it reads `$GEMINI_CLI_HOME/.agents/skills` instead of palm's
 * `~/.agents/skills`, so global skills then go to `$GEMINI_CLI_HOME/.gemini/skills`.
 */
function skillsRoot(paths: ScopePaths, base: string): CleanupRoot {
  if (paths.scope === 'global' && paths.harnessOverride('gemini'))
    return { dir: path.join(base, 'skills'), stop: base };
  return sharedSkillsRoot(paths);
}

export const geminiSpec: TargetSpec = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  layout(paths): TargetLayout {
    const base = paths.harnessHome('gemini');
    const skills = skillsRoot(paths, base);
    const settings = path.join(base, 'settings.json');
    const contextFile = path.join(paths.scope === 'project' ? paths.root : base, 'GEMINI.md');
    return {
      configDir: base,
      skillsDir: skills.dir,
      agentsDir: path.join(base, 'agents'),
      instructions: { blockFile: contextFile },
      commands: { dir: path.join(base, 'commands') },
      hooks: { mergeFile: settings },
      mcp: { json: settings, path: ['mcpServers'] },
      roots: [{ dir: base, stop: base }, skills],
      mergedFiles: [settings, contextFile],
    };
  },
  async detect(paths) {
    if (paths.scope === 'project')
      return (
        (await pathExists(path.join(paths.root, '.gemini'))) ||
        pathExists(path.join(paths.root, 'GEMINI.md'))
      );
    return pathExists(paths.harnessHome('gemini'));
  },
};
