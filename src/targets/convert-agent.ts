/**
 * Render a canonical AgentDefinition (Claude frontmatter superset) for one harness.
 *
 * - claude  `.md`: name, description, model, tools (comma-joined), disallowedTools,
 *   skills, mcpServers, color, then extra keys; body.
 * - codex   `.toml`: name, description, model (not a Claude model), whitelisted
 *   Codex keys from `extra`, developer_instructions as a multi-line basic string.
 *   Codex agent `mcp_servers` is a table of server *definitions*, so a list of names
 *   cannot be expressed: dropped (the servers palm installs into config.toml are
 *   inherited by subagents).
 * - copilot `.agent.md`: name (displayName), description, model (not a Claude alias),
 *   tools (list; `<server>/*` added for each mcpServers entry so MCP tools stay
 *   allowed). `mcp-servers` is a map of definitions in Copilot, so names are dropped.
 * - cursor  `.md`: name, description, model (not a Claude alias; `inherit` kept),
 *   readonly when tools exist and none of them writes.
 */
import { stringify as tomlStringify } from 'smol-toml';
import type { AgentDefinition, TargetId } from '../core/types.js';
import { normalizeBody, stringifyFrontmatter } from '../lib/frontmatter.js';
import { withoutUndefined } from '../lib/object.js';

const CLAUDE_ALIAS = /^(opus|sonnet|haiku|inherit|opusplan|default|best)(\[[^\]]*\])?$/i;
const CLAUDE_ID = /^(claude[-_.]|anthropic[/.])/i;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function isClaudeModelAlias(model: string): boolean {
  return CLAUDE_ALIAS.test(model.trim());
}

export function isClaudeModel(model: string): boolean {
  return isClaudeModelAlias(model) || CLAUDE_ID.test(model.trim());
}

/** Extra keys each harness understands (copied from `def.extra` when present). */
const CODEX_EXTRA = [
  'model_reasoning_effort',
  'model_verbosity',
  'sandbox_mode',
  'nickname_candidates',
];
const COPILOT_EXTRA = [
  'target',
  'disable-model-invocation',
  'user-invocable',
  'metadata',
  'mcp-servers',
];
const CURSOR_EXTRA = ['is_background', 'readonly'];
const CLAUDE_KNOWN = [
  'name',
  'description',
  'model',
  'tools',
  'disallowedTools',
  'skills',
  'mcpServers',
  'color',
];

function nonEmpty<T>(xs: T[] | undefined): T[] | undefined {
  return xs && xs.length > 0 ? xs : undefined;
}

/** Control characters TOML basic strings must escape (all but tab and newline). */
function isTomlControl(code: number): boolean {
  return (code <= 0x1f && code !== 0x09 && code !== 0x0a) || code === 0x7f;
}

/**
 * TOML multi-line basic string. Escapes backslashes, control characters and every
 * quote that is part of a run of two or more or that ends the string, so the
 * closing delimiter can never be formed by the content.
 */
export function tomlMultilineString(s: string): string {
  const escaped = Array.from(s.replace(/\\/g, '\\\\').replace(/\r\n/g, '\n'), (c) => {
    const code = c.charCodeAt(0);
    return isTomlControl(code) ? `\\u${code.toString(16).padStart(4, '0')}` : c;
  }).join('');
  let body = escaped.replace(/"{2,}/g, (run) => run.replace(/"/g, '\\"'));
  if (body.endsWith('"') && !body.endsWith('\\"')) body = `${body.slice(0, -1)}\\"`;
  return `"""\n${body}"""`;
}

function pickExtra(
  extra: Record<string, unknown> | undefined,
  allowed: readonly string[],
): { kept: Record<string, unknown>; dropped: string[] } {
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(withoutUndefined(extra ?? {}))) {
    if (allowed.includes(k)) kept[k] = v;
    else dropped.push(k);
  }
  return { kept, dropped };
}

type RenderedAgent = { fileName: string; content: string; dropped: string[] };

/** The list fields of a definition, undefined when empty. */
interface AgentLists {
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  mcpServers?: string[];
}

type DroppableField = keyof AgentLists | 'color';

/** Record, in order, each of `fields` the definition sets but the target cannot express. */
function dropFields(
  def: AgentDefinition,
  lists: AgentLists,
  fields: readonly DroppableField[],
  dropped: string[],
): void {
  for (const f of fields) if (f === 'color' ? def.color : lists[f]) dropped.push(f);
}

/** Extra keys the target understands; the others are recorded as dropped. */
function keepExtra(
  def: AgentDefinition,
  allowed: readonly string[],
  dropped: string[],
): Record<string, unknown> {
  const { kept, dropped: extraDropped } = pickExtra(def.extra, allowed);
  dropped.push(...extraDropped.map((k) => `extra: ${k}`));
  return kept;
}

/** `model`, or undefined (recorded as dropped) when `foreign` says the target cannot use it. */
function keepModel(
  model: string | undefined,
  foreign: (m: string) => boolean,
  dropped: string[],
): string | undefined {
  if (!model || !foreign(model)) return model;
  dropped.push(`model (${model})`);
  return undefined;
}

function renderClaude(def: AgentDefinition, lists: AgentLists): RenderedAgent {
  const extra = Object.fromEntries(
    Object.entries(def.extra ?? {}).filter(([k]) => !CLAUDE_KNOWN.includes(k)),
  );
  const fm = {
    name: def.name,
    description: def.description,
    model: def.model,
    tools: lists.tools?.join(', '),
    disallowedTools: lists.disallowedTools?.join(', '),
    skills: lists.skills,
    mcpServers: lists.mcpServers,
    color: def.color,
    ...extra,
  };
  return { fileName: `${def.name}.md`, content: stringifyFrontmatter(fm, def.body), dropped: [] };
}

function renderCodex(def: AgentDefinition, lists: AgentLists): RenderedAgent {
  const dropped: string[] = [];
  const model = keepModel(def.model, isClaudeModel, dropped);
  dropFields(def, lists, ['tools', 'disallowedTools', 'skills', 'mcpServers', 'color'], dropped);
  const kept = keepExtra(def, CODEX_EXTRA, dropped);
  const head = tomlStringify({
    name: def.name,
    description: def.description,
    ...(model ? { model } : {}),
    ...kept,
  }).replace(/\n+$/, '');
  const content = `${head}\ndeveloper_instructions = ${tomlMultilineString(normalizeBody(def.body))}\n`;
  return { fileName: `${def.name}.toml`, content, dropped };
}

/** Copilot `tools`: MCP tools stay allowed when tools are restricted (`<server>/*` per server). */
function copilotTools({ tools, mcpServers }: AgentLists): string[] | undefined {
  if (!tools) return undefined;
  const out = [...tools];
  for (const s of mcpServers ?? []) if (!out.includes(`${s}/*`)) out.push(`${s}/*`);
  return out;
}

function renderCopilot(def: AgentDefinition, lists: AgentLists): RenderedAgent {
  const dropped: string[] = [];
  const model = keepModel(def.model, isClaudeModelAlias, dropped);
  dropFields(def, lists, ['mcpServers', 'skills', 'disallowedTools', 'color'], dropped);
  const kept = keepExtra(def, COPILOT_EXTRA, dropped);
  const fm = {
    name: def.displayName ?? def.name,
    description: def.description,
    model,
    tools: copilotTools(lists),
    ...kept,
  };
  return {
    fileName: `${def.name}.agent.md`,
    content: stringifyFrontmatter(fm, def.body),
    dropped,
  };
}

function renderCursor(def: AgentDefinition, lists: AgentLists): RenderedAgent {
  const dropped: string[] = [];
  const foreign = (m: string): boolean =>
    isClaudeModelAlias(m) && m.trim().toLowerCase() !== 'inherit';
  const model = keepModel(def.model, foreign, dropped);
  const { tools } = lists;
  const readonly = tools ? !tools.some((t) => WRITE_TOOLS.has(t)) : undefined;
  if (tools) dropped.push(readonly ? 'tools (mapped to readonly: true)' : 'tools');
  dropFields(def, lists, ['disallowedTools', 'skills', 'mcpServers', 'color'], dropped);
  const kept = keepExtra(def, CURSOR_EXTRA, dropped);
  const fm = {
    name: def.name,
    description: def.description,
    model,
    ...(readonly ? { readonly: true } : {}),
    ...kept,
  };
  return { fileName: `${def.name}.md`, content: stringifyFrontmatter(fm, def.body), dropped };
}

const RENDERERS: Record<TargetId, (def: AgentDefinition, lists: AgentLists) => RenderedAgent> = {
  claude: renderClaude,
  codex: renderCodex,
  copilot: renderCopilot,
  cursor: renderCursor,
};

export function renderAgent(def: AgentDefinition, target: TargetId): RenderedAgent {
  const lists: AgentLists = {
    tools: nonEmpty(def.tools),
    disallowedTools: nonEmpty(def.disallowedTools),
    skills: nonEmpty(def.skills),
    mcpServers: nonEmpty(def.mcpServers),
  };
  return RENDERERS[target](def, lists);
}
