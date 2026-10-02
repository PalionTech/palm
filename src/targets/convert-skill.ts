/**
 * A command file from a source installs as a skill (DESIGN.md section 2): `SKILL.md` with
 * `name`, `description` and the command body, at the skill locations. `$ARGUMENTS` survives as
 * written; Claude Code and Cursor expand it when the skill is invoked with arguments, the other
 * harnesses do not, and the note says so. `argument-hint` is kept where the harness reads it
 * (Claude Code, Cursor).
 */
import type { CommandAsSkill, SkillDefinition, TargetId } from '../core/types.js';
import { stringifyFrontmatter } from '../lib/frontmatter.js';
import { DISPLAY_NAMES } from './layout.js';

/** Harnesses that expand `$ARGUMENTS` (and `$1`…) in a skill's text. */
const EXPANDS_ARGUMENTS: ReadonlySet<TargetId> = new Set(['claude', 'cursor']);

const ARGUMENT_PLACEHOLDER = /\$ARGUMENTS\b|\$[1-9]\b/;

/** `SKILL.md` text for a command, and the notes for what the harness does not carry over. */
export function renderCommandAsSkill(
  def: SkillDefinition & { fromCommand: CommandAsSkill },
  target: TargetId,
): { content: string; notes: string[] } {
  const expands = EXPANDS_ARGUMENTS.has(target);
  const fm = {
    name: def.name,
    description: def.description,
    'argument-hint': expands ? def.fromCommand.argumentHint : undefined,
  };
  const notes: string[] = [];
  if (!expands && ARGUMENT_PLACEHOLDER.test(def.fromCommand.body))
    notes.push(
      `skill ${def.name} (from a command): ${DISPLAY_NAMES[target]} does not expand $ARGUMENTS in skills; the text stays as written`,
    );
  return { content: stringifyFrontmatter(fm, def.fromCommand.body), notes };
}
