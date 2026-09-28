/**
 * Render an InstructionDefinition.
 * - claude  `.claude/rules/<n>.md`, `paths:` list when globs exist.
 * - copilot `<n>.instructions.md`, `description?`, `applyTo: "<globs,>"` or `"**"`.
 * - cursor  `<n>.mdc`, `description`, `globs` (comma-joined, unquoted like Cursor
 *   writes it), `alwaysApply`.
 * - codex   managed block content for AGENTS.md ("Applies to: ..." line + body).
 */
import type { InstructionDefinition, TargetId } from '../core/types.js';
import { normalizeBody, withFrontmatter, yamlScalar } from './frontmatter.js';

export function renderInstruction(
  def: InstructionDefinition,
  target: TargetId,
): { fileName: string; content: string } | { managedBlock: string } {
  const globs = (def.globs ?? []).filter((g) => g.trim() !== '');
  switch (target) {
    case 'claude': {
      const fm = globs.length
        ? 'paths:\n' + globs.map((g) => `  - ${JSON.stringify(g)}`).join('\n')
        : '';
      return { fileName: `${def.name}.md`, content: withFrontmatter(fm, def.body) };
    }
    case 'copilot': {
      const lines: string[] = [];
      if (def.description) lines.push(`description: ${yamlScalar(def.description)}`);
      lines.push(`applyTo: ${JSON.stringify(globs.length ? globs.join(',') : '**')}`);
      return {
        fileName: `${def.name}.instructions.md`,
        content: withFrontmatter(lines.join('\n'), def.body),
      };
    }
    case 'cursor': {
      const lines = [
        def.description ? `description: ${yamlScalar(def.description)}` : 'description:',
        globs.length ? `globs: ${globs.join(',')}` : 'globs:',
        `alwaysApply: ${def.alwaysApply ? 'true' : 'false'}`,
      ];
      return { fileName: `${def.name}.mdc`, content: withFrontmatter(lines.join('\n'), def.body) };
    }
    case 'codex': {
      const body = normalizeBody(def.body);
      const managedBlock = globs.length ? `Applies to: ${globs.join(', ')}\n\n${body}` : body;
      return { managedBlock };
    }
  }
}
