/**
 * Command (prompt template) parsing:
 *  - Claude Code / OpenCode `.md` (description, argument-hint)
 *  - Copilot `.prompt.md`
 *  - Gemini `.toml` (prompt, description)
 */

import { basename } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { messageOf, PalmError } from '../core/errors.js';
import type { CommandDefinition } from '../core/types.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { stemOf } from '../lib/names.js';
import { withoutUndefined } from '../lib/object.js';
import { asString, toSlug } from './util.js';

/** Command file extensions; the file stem is the name without one of them. */
const COMMAND_EXTS = ['.prompt.md', '.md', '.toml'];

export function parseCommandFile(absPath: string, text: string): CommandDefinition {
  const lower = absPath.toLowerCase();
  const name = toSlug(stemOf(absPath, COMMAND_EXTS));

  if (lower.endsWith('.toml')) {
    let data: Record<string, unknown>;
    try {
      data = parseToml(text) as Record<string, unknown>;
    } catch (e) {
      throw new PalmError(
        'E_PARSE',
        `invalid TOML in command ${basename(absPath)}: ${messageOf(e).split('\n')[0]}`,
      );
    }
    return withoutUndefined({
      name,
      description: asString(data.description),
      body: typeof data.prompt === 'string' ? data.prompt : '',
      sourceFormat: 'gemini-toml' as const,
    });
  }

  const { data, body } = parseFrontmatter(text);
  const hintRaw = data['argument-hint'] ?? data.argumentHint ?? data.argument_hint;
  // YAML reads `argument-hint: [pr-number]` as a list; restore the bracketed form.
  const argumentHint = Array.isArray(hintRaw)
    ? `[${hintRaw.map((x) => String(x)).join(', ')}]`
    : asString(hintRaw);
  let sourceFormat: CommandDefinition['sourceFormat'];
  if (lower.endsWith('.prompt.md')) sourceFormat = 'prompt-md';
  else if (('agent' in data || 'subtask' in data) && argumentHint === undefined)
    sourceFormat = 'opencode-md';
  else sourceFormat = 'claude-md';
  return withoutUndefined({
    name,
    description: asString(data.description),
    argumentHint,
    body,
    sourceFormat,
  });
}
