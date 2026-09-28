/**
 * Render a CommandDefinition.
 * - claude/cursor `<n>.md` with `description` / `argument-hint` frontmatter.
 * - copilot `<n>.prompt.md` with the same keys.
 * - codex `<n>.md` plain markdown (global `~/.codex/prompts` only).
 * - opencode `<n>.md` with `description` only: `$ARGUMENTS`, `$1…`, ``!`cmd` `` and `@file`
 *   "match Claude" (R7 §5); `argument-hint` is dropped.
 * - gemini `<n>.toml` with `description` and `prompt` (docs/cli/custom-commands.md): Claude's
 *   `$ARGUMENTS` becomes `{{args}}`, ``!`cmd` `` becomes `!{cmd}` and `@path` becomes
 *   `@{path}`; positional `$1…` has no Gemini equivalent (noted).
 * Otherwise argument placeholders ($ARGUMENTS, $1, ${input:x}) are passed through unchanged.
 */
import { stringify as tomlStringify } from 'smol-toml';
import type { CommandDefinition, TargetId } from '../core/types.js';
import { normalizeBody, stringifyFrontmatter } from '../lib/frontmatter.js';
import { tomlMultilineString } from './convert-agent.js';

interface RenderedCommand {
  fileName: string;
  content: string;
  /** What the conversion could not carry over. */
  notes?: string[];
}

/**
 * A path-like `@` reference (`@src/a.ts`, `@./notes.md`, `@README.md`) at the start of a line
 * or after whitespace or `(`: e-mail addresses and `@mentions` do not match.
 */
const AT_PATH = /(^|[\s(])@((?:\.{1,2}\/|\/)?[\w-]+(?:[./][\w-]+)+\/?)/gm;

/** Claude command text in Gemini's syntax, and a note when positional arguments are used. */
function geminiPrompt(body: string, notes: string[]): string {
  if (/\$[1-9]/.test(body))
    notes.push(
      'positional arguments ($1, $2, …) have no Gemini CLI equivalent; {{args}} holds all of them',
    );
  return body
    .replace(/\$ARGUMENTS\b/g, '{{args}}')
    .replace(/!`([^`\n]+)`/g, '!{$1}')
    .replace(AT_PATH, '$1@{$2}');
}

function renderGemini(def: CommandDefinition): RenderedCommand {
  const notes: string[] = [];
  const prompt = geminiPrompt(normalizeBody(def.body), notes);
  const head = def.description ? tomlStringify({ description: def.description }) : '';
  const content = `${head}prompt = ${tomlMultilineString(prompt)}\n`;
  return { fileName: `${def.name}.toml`, content, notes };
}

export function renderCommand(def: CommandDefinition, target: TargetId): RenderedCommand {
  const fm = { description: def.description, 'argument-hint': def.argumentHint };
  switch (target) {
    case 'claude':
    case 'cursor':
      return { fileName: `${def.name}.md`, content: stringifyFrontmatter(fm, def.body) };
    case 'copilot':
      return { fileName: `${def.name}.prompt.md`, content: stringifyFrontmatter(fm, def.body) };
    case 'codex':
      return { fileName: `${def.name}.md`, content: normalizeBody(def.body) };
    case 'opencode': {
      const content = stringifyFrontmatter({ description: def.description }, def.body);
      return { fileName: `${def.name}.md`, content };
    }
    case 'gemini':
      return renderGemini(def);
  }
}
