/**
 * Instruction parsing, with the activation the source format implies (DESIGN §5):
 *  - Cursor `.mdc` rules: `alwaysApply: true` → always; `globs` → paths; a description without
 *    globs → on-request; neither → manual
 *  - Copilot `.instructions.md`: `applyTo` → paths (an everything-glob → always), else always
 *  - Claude `.claude/rules`-style `.md` and plain markdown: `paths:` → paths, else always; without
 *    Cursor or Copilot keys it is `claude-md`, which claude installs byte-identical (ruling B12)
 *  - `AGENTS.md` sections: always
 */

import { basename } from 'node:path';
import type { Activation, InstructionDefinition } from '../core/types.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { isSafeName, stemOf } from '../lib/names.js';
import { withoutUndefined } from '../lib/object.js';
import { asBool, asList, asString, toSlug } from './util.js';

/** Instruction file extensions; the file stem is the name without one of them. */
const INSTRUCTION_EXTS = ['.instructions.md', '.mdc', '.md'];

const ALWAYS_GLOBS = new Set(['**', '**/*', '*']);

type Frontmatter = Record<string, unknown>;

interface Parts {
  name: string;
  description?: string;
  globs?: string[];
  activation: Activation;
  body: string;
  sourceFormat: NonNullable<InstructionDefinition['sourceFormat']>;
  fileName?: string;
}

/** Frontmatter keys Claude Code does not read on a rule; a file with one is converted, not copied. */
const NON_CLAUDE_KEYS = ['globs', 'applyTo', 'alwaysApply'];

function definition(parts: Parts): InstructionDefinition {
  const globs = parts.globs && parts.globs.length > 0 ? parts.globs : undefined;
  return withoutUndefined({ ...parts, globs, alwaysApply: parts.activation === 'always' });
}

/** Globs that scope a rule; undefined when absent or when every glob matches everything. */
function scopingGlobs(value: unknown): string[] | undefined {
  const globs = asList(value);
  if (!globs || globs.length === 0 || globs.every((g) => ALWAYS_GLOBS.has(g))) return undefined;
  return globs;
}

function mdcActivation(data: Frontmatter, description: string | undefined): Activation {
  if (asBool(data.alwaysApply) === true) return 'always';
  if ((asList(data.globs) ?? []).length > 0) return 'paths';
  return description === undefined ? 'manual' : 'on-request';
}

/**
 * Claude rules: `paths:` scopes the rule, otherwise it is always on. Cursor-style keys are read
 * too, and an explicit `alwaysApply: false` is never widened to always-on (PLAN §4.5 item 17).
 */
function markdownActivation(data: Frontmatter, scoped: boolean, description?: string): Activation {
  if (scoped) return 'paths';
  if (asBool(data.alwaysApply) !== false) return 'always';
  return description === undefined ? 'manual' : 'on-request';
}

export function parseInstructionFile(absPath: string, text: string): InstructionDefinition {
  const lower = absPath.toLowerCase();
  const { data, body } = parseFrontmatter(text);
  const name = toSlug(stemOf(absPath, INSTRUCTION_EXTS));
  const description = asString(data.description);
  const head = { name, description, body };

  if (lower.endsWith('.mdc')) {
    const activation = mdcActivation(data, description);
    return definition({ ...head, globs: asList(data.globs), activation, sourceFormat: 'mdc' });
  }
  if (lower.endsWith('.instructions.md')) {
    const globs = scopingGlobs(data.applyTo);
    const activation = globs ? 'paths' : 'always';
    return definition({ ...head, globs, activation, sourceFormat: 'instructions-md' });
  }
  if (basename(lower) === 'agents.md') {
    return definition({ name, body, activation: 'always', sourceFormat: 'agents-md' });
  }
  const globs = scopingGlobs(data.paths ?? data.globs ?? data.applyTo);
  const activation = markdownActivation(data, globs !== undefined, description);
  if (NON_CLAUDE_KEYS.some((k) => k in data))
    return definition({ ...head, globs, activation, sourceFormat: 'md' });
  const base = basename(absPath);
  const fileName = base === `${name}.md` || !isSafeName(base) ? undefined : base;
  return definition({ ...head, globs, activation, sourceFormat: 'claude-md', fileName });
}
