/**
 * Command files beside a skill of the same name (ruling Y11'): palm installs a command as a skill,
 * so after adopting `.cursor/commands/*.md` the originals left in place answer to the same
 * `/name` as the new skills, and the harness lists both. `check` warns, like two agents with one
 * name (ruling Y14).
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { commandName, isCommandFile } from './commands.js';

/** Where each harness reads command files in a project (palm never writes there). */
const HARNESS_COMMAND_DIRS: readonly string[] = [
  '.claude/commands',
  '.cursor/commands',
  '.opencode/command',
  '.opencode/commands',
  '.github/prompts',
  '.gemini/commands',
];

/** One command file answering to the name of an installed skill. */
export interface CommandSkillClash {
  name: string;
  /** Path of the command file relative to `root`. */
  file: string;
}

/**
 * Command files directly inside the harness command folders under `root` whose name is one of
 * `skills` (the installed skill names), sorted by path.
 */
export async function commandSkillClashes(
  root: string,
  skills: ReadonlySet<string>,
  dirs: readonly string[] = HARNESS_COMMAND_DIRS,
): Promise<CommandSkillClash[]> {
  const out: CommandSkillClash[] = [];
  for (const dir of dirs) {
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile() || !isCommandFile(e.name)) continue;
      const name = commandName(e.name);
      if (skills.has(name)) out.push({ name, file: `${dir}/${e.name}` });
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}
