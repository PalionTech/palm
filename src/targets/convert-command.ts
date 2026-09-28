/**
 * Render a CommandDefinition.
 * - claude/cursor `<n>.md` with `description` / `argument-hint` frontmatter.
 * - copilot `<n>.prompt.md` with the same keys.
 * - codex `<n>.md` plain markdown (global `~/.codex/prompts` only).
 * Argument placeholders ($ARGUMENTS, $1, ${input:x}) are passed through unchanged.
 */
import type { CommandDefinition, TargetId } from '../core/types.js';
import { normalizeBody, stringifyFrontmatter } from '../lib/frontmatter.js';

export function renderCommand(
  def: CommandDefinition,
  target: TargetId,
): { fileName: string; content: string } {
  const fm = { description: def.description, 'argument-hint': def.argumentHint };
  switch (target) {
    case 'claude':
    case 'cursor':
      return { fileName: `${def.name}.md`, content: stringifyFrontmatter(fm, def.body) };
    case 'copilot':
      return { fileName: `${def.name}.prompt.md`, content: stringifyFrontmatter(fm, def.body) };
    case 'codex':
      return { fileName: `${def.name}.md`, content: normalizeBody(def.body) };
  }
}
