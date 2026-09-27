/**
 * Instruction parsing:
 *  - Cursor `.mdc` rules (description, globs, alwaysApply)
 *  - Copilot `.instructions.md` (applyTo, description)
 *  - Claude `.claude/rules`-style `.md` (optional `paths:`) and plain markdown
 *  - `AGENTS.md` sections
 */

import { basename } from 'node:path';
import type { InstructionDefinition } from '../core/types.js';
import { parseFrontmatter } from './frontmatter.js';
import { toSlug } from './slug.js';
import { asBool, asList, asString, compact } from './util.js';

export function instructionStem(fileName: string): string {
  const b = basename(fileName);
  for (const ext of ['.instructions.md', '.mdc', '.md']) {
    if (b.toLowerCase().endsWith(ext)) return b.slice(0, -ext.length);
  }
  return b;
}

const ALWAYS_GLOBS = new Set(['**', '**/*', '*']);

export function parseInstructionFile(absPath: string, text: string): InstructionDefinition {
  const lower = absPath.toLowerCase();
  const { data, body } = parseFrontmatter(text);
  const name = toSlug(instructionStem(absPath));
  const description = asString(data.description);

  if (lower.endsWith('.mdc')) {
    const globs = asList(data.globs);
    return compact({
      name,
      description,
      globs: globs && globs.length > 0 ? globs : undefined,
      alwaysApply: asBool(data.alwaysApply) ?? false,
      body,
      sourceFormat: 'mdc' as const,
    });
  }

  if (lower.endsWith('.instructions.md')) {
    const applyTo = asList(data.applyTo);
    const always = applyTo !== undefined && applyTo.some((g) => ALWAYS_GLOBS.has(g));
    return compact({
      name,
      description,
      globs: applyTo && applyTo.length > 0 && !always ? applyTo : undefined,
      alwaysApply: always,
      body,
      sourceFormat: 'instructions-md' as const,
    });
  }

  if (basename(lower) === 'agents.md') {
    return { name, alwaysApply: true, body, sourceFormat: 'agents-md' };
  }

  // Claude rules: `paths:` scopes the rule; otherwise it is always on. Cursor-style keys are honoured too.
  const paths = asList(data.paths ?? data.globs ?? data.applyTo);
  const scoped = paths !== undefined && paths.length > 0 && !paths.every((g) => ALWAYS_GLOBS.has(g));
  return compact({
    name,
    description,
    globs: scoped ? paths : undefined,
    alwaysApply: asBool(data.alwaysApply) ?? !scoped,
    body,
    sourceFormat: 'md' as const,
  });
}
