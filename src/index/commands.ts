/**
 * Command (prompt template) parsing. A command installs as a skill (DESIGN §5), so the parser
 * returns the skill's name and description plus the command itself for the SKILL.md render:
 *  - Claude Code / OpenCode `.md` (description, argument-hint)
 *  - Copilot `.prompt.md`
 *  - Gemini `.toml` (prompt, description)
 */

import { basename } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { messageOf, PalmError } from '../core/errors.js';
import type { CommandAsSkill } from '../core/types.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { stemOf } from '../lib/names.js';
import { withoutUndefined } from '../lib/object.js';
import { asString, toSlug } from './util.js';

/** Command file extensions; the file stem is the name without one of them. */
const COMMAND_EXTS = ['.prompt.md', '.md', '.toml'];

export interface ParsedCommand {
  name: string;
  description?: string;
  command: CommandAsSkill;
}

/** Longest description derived from a command's text. */
const DERIVED_MAX = 200;

/**
 * A description for a command that has none (ruling Y11): its first non-empty line, heading
 * marks and surrounding spaces removed, cut at 200 characters. A skill needs a description; the
 * command's first line is what a person reads first.
 */
function firstLineDescription(body: string): string | undefined {
  const line = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l !== '');
  if (line === undefined) return undefined;
  return line.length > DERIVED_MAX ? `${line.slice(0, DERIVED_MAX - 1).trimEnd()}…` : line;
}

/** The name a command file installs under: its stem as a slug (`Review PR.md` → `review-pr`). */
export function commandName(file: string): string {
  return toSlug(stemOf(file, COMMAND_EXTS));
}

/** True for a file name a command parser reads (`.md`, `.prompt.md`, `.toml`). */
export function isCommandFile(file: string): boolean {
  const lower = file.toLowerCase();
  return COMMAND_EXTS.some((e) => lower.endsWith(e));
}

export function parseCommandFile(absPath: string, text: string): ParsedCommand {
  const lower = absPath.toLowerCase();
  const name = commandName(absPath);

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
    const body = typeof data.prompt === 'string' ? data.prompt : '';
    return withoutUndefined({
      name,
      description: asString(data.description) ?? firstLineDescription(body),
      command: { body, sourceFormat: 'gemini-toml' as const },
    });
  }

  const { data, body } = parseFrontmatter(text);
  const hintRaw = data['argument-hint'] ?? data.argumentHint ?? data.argument_hint;
  // YAML reads `argument-hint: [pr-number]` as a list; restore the bracketed form.
  const argumentHint = Array.isArray(hintRaw)
    ? `[${hintRaw.map((x) => String(x)).join(', ')}]`
    : asString(hintRaw);
  let sourceFormat: CommandAsSkill['sourceFormat'];
  if (lower.endsWith('.prompt.md')) sourceFormat = 'prompt-md';
  else if (('agent' in data || 'subtask' in data) && argumentHint === undefined)
    sourceFormat = 'opencode-md';
  else sourceFormat = 'claude-md';
  return withoutUndefined({
    name,
    description: asString(data.description) ?? firstLineDescription(body),
    command: withoutUndefined({ body, argumentHint, sourceFormat }),
  });
}
