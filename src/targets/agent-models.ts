/**
 * Which agent `model` values each harness can run (rulings Y10, Y9'). A model a harness does not
 * know is dropped with a note for every harness, Claude Code included: Cursor's `fast` or
 * `claude-4.5-opus-high-thinking`, an OpenCode `provider/model` id, a Claude alias outside
 * Claude Code. An agent already in the harness's own format keeps its model as written (the
 * author picked it for that harness), except Claude's format, which is also every unknown
 * markdown agent's.
 */
import type { AgentDefinition, TargetId } from '../core/types.js';

const CLAUDE_ALIAS = /^(opus|sonnet|haiku|fable|inherit|opusplan|default|best)(\[[^\]]*\])?$/i;
/**
 * A Claude Code model id: the API id (`claude-opus-4-5`, `claude-3-5-haiku-20241022`), a Bedrock
 * id (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) or a Vertex id (`claude-opus-4@20250514`),
 * with an optional `[1m]`. Dotted versions (`claude-4.5-opus`) are Cursor's, not Claude Code's.
 */
const CLAUDE_CODE_ID =
  /^(?:(?:[a-z]{2,6}\.)?anthropic\.)?claude-[a-z0-9-]+(?:-v\d+:\d+)?(?:@\d{8})?(?:\[[^\]]*\])?$/i;
/** OpenAI ids Codex runs (`gpt-5-codex`, `o4-mini`, `codex-mini-latest`). */
const OPENAI_ID = /^(gpt-|o\d|codex-|chatgpt-)/i;
/** Model names GitHub Copilot and Cursor list (`GPT-5`, `Claude Sonnet 4.5`, `gemini-2.5-pro`). */
const PICKER_NAME = /^(gpt|o\d|claude|gemini|grok|composer|cursor)[-\s.]/i;
const CURSOR_WORDS = new Set(['inherit', 'fast', 'auto']);

function isClaudeAlias(model: string): boolean {
  return CLAUDE_ALIAS.test(model.trim());
}

const KNOWN: Record<TargetId, (model: string) => boolean> = {
  claude: (m) => isClaudeAlias(m) || CLAUDE_CODE_ID.test(m),
  codex: (m) => OPENAI_ID.test(m),
  copilot: (m) => !isClaudeAlias(m) && (PICKER_NAME.test(m) || /\(copilot\)$/i.test(m)),
  cursor: (m) => CURSOR_WORDS.has(m.toLowerCase()) || (!isClaudeAlias(m) && PICKER_NAME.test(m)),
  gemini: (m) => /^gemini-/i.test(m),
  opencode: (m) => /^[\w.-]+\/\S+$/.test(m),
};

/** The format each harness writes its own agents in (claude-md is left out, see above). */
const NATIVE: Partial<Record<TargetId, NonNullable<AgentDefinition['sourceFormat']>>> = {
  codex: 'codex-toml',
  copilot: 'copilot-agent-md',
  cursor: 'cursor-md',
};

/** True when `target` can run `model` for an agent written in `sourceFormat`. */
export function knownModel(
  target: TargetId,
  model: string,
  sourceFormat?: AgentDefinition['sourceFormat'],
): boolean {
  if (sourceFormat !== undefined && NATIVE[target] === sourceFormat) return true;
  return KNOWN[target](model.trim());
}
