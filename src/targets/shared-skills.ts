import path from 'node:path';
import type { ScopePaths } from '../domain/scope-paths.js';
import type { CleanupRoot } from './layout.js';

/**
 * `<root>/.agents/skills`: the skills directory Codex, Copilot, Cursor, Gemini CLI and OpenCode
 * share. Each claims it at undeploy (whichever runs first removes a skill), pruning up to
 * `.agents`.
 */
export function sharedSkillsRoot(paths: ScopePaths): CleanupRoot {
  const agents = path.join(paths.root, '.agents');
  return { dir: path.join(agents, 'skills'), stop: agents };
}
