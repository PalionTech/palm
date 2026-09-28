/**
 * Instruction parsing:
 *  - Cursor `.mdc` rules (description, globs, alwaysApply)
 *  - Copilot `.instructions.md` (applyTo, description)
 *  - Claude `.claude/rules`-style `.md` (optional `paths:`) and plain markdown
 *  - `AGENTS.md` sections
 */

import { basename } from 'node:path';
import type { InstructionDefinition } from '../core/types.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { stemOf } from '../lib/names.js';
import { withoutUndefined } from '../lib/object.js';
import { asBool, asList, asString, toSlug } from './util.js';

/** Instruction file extensions; the file stem is the name without one of them. */
const INSTRUCTION_EXTS = ['.instructions.md', '.mdc', '.md'];

const ALWAYS_GLOBS = new Set(['**', '**/*', '*']);

export function parseInstructionFile(absPath: string, text: string): InstructionDefinition {
  const lower = absPath.toLowerCase();
  const { data, body } = parseFrontmatter(text);
  const name = toSlug(stemOf(absPath, INSTRUCTION_EXTS));
  const description = asString(data.description);

  if (lower.endsWith('.mdc')) {
    const globs = asList(data.globs);
    return withoutUndefined({
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
    return withoutUndefined({
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
  const scoped =
    paths !== undefined && paths.length > 0 && !paths.every((g) => ALWAYS_GLOBS.has(g));
  return withoutUndefined({
    name,
    description,
    globs: scoped ? paths : undefined,
    alwaysApply: asBool(data.alwaysApply) ?? !scoped,
    body,
    sourceFormat: 'md' as const,
  });
}
