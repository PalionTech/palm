/**
 * Render an InstructionDefinition.
 * - claude  `.claude/rules/<n>.md`, `paths:` list when globs exist.
 * - copilot `<n>.instructions.md`, `description?`, `applyTo: "<globs,>"` or `"**"`.
 * - cursor  `<n>.mdc`, `description`, `globs` (comma-joined, unquoted like Cursor
 *   writes it), `alwaysApply`.
 * - codex   managed block content for AGENTS.md ("Applies to: ..." line + body).
 */
import type { InstructionDefinition, TargetId } from '../core/types.js';
import { normalizeBody, withFrontmatter } from '../lib/frontmatter.js';
import { yamlScalar } from '../lib/yaml.js';

type RenderedInstruction = { fileName: string; content: string } | { managedBlock: string };

function renderClaude(def: InstructionDefinition, globs: string[]): RenderedInstruction {
  const fm = globs.length
    ? `paths:\n${globs.map((g) => `  - ${JSON.stringify(g)}`).join('\n')}`
    : '';
  return { fileName: `${def.name}.md`, content: withFrontmatter(fm, def.body) };
}

function renderCopilot(def: InstructionDefinition, globs: string[]): RenderedInstruction {
  const lines: string[] = [];
  if (def.description) lines.push(`description: ${yamlScalar(def.description)}`);
  lines.push(`applyTo: ${JSON.stringify(globs.length ? globs.join(',') : '**')}`);
  return {
    fileName: `${def.name}.instructions.md`,
    content: withFrontmatter(lines.join('\n'), def.body),
  };
}

function renderCursor(def: InstructionDefinition, globs: string[]): RenderedInstruction {
  const lines = [
    def.description ? `description: ${yamlScalar(def.description)}` : 'description:',
    globs.length ? `globs: ${globs.join(',')}` : 'globs:',
    `alwaysApply: ${def.alwaysApply ? 'true' : 'false'}`,
  ];
  return { fileName: `${def.name}.mdc`, content: withFrontmatter(lines.join('\n'), def.body) };
}

function renderCodex(def: InstructionDefinition, globs: string[]): RenderedInstruction {
  const body = normalizeBody(def.body);
  return { managedBlock: globs.length ? `Applies to: ${globs.join(', ')}\n\n${body}` : body };
}

const RENDERERS: Record<
  TargetId,
  (def: InstructionDefinition, globs: string[]) => RenderedInstruction
> = { claude: renderClaude, copilot: renderCopilot, cursor: renderCursor, codex: renderCodex };

export function renderInstruction(
  def: InstructionDefinition,
  target: TargetId,
): RenderedInstruction {
  const globs = (def.globs ?? []).filter((g) => g.trim() !== '');
  return RENDERERS[target](def, globs);
}
