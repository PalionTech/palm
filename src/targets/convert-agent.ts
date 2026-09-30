/**
 * Render a canonical AgentDefinition (Claude frontmatter superset) for one harness.
 *
 * Every harness keeps only a model it knows (agent-models.ts, ruling Y9'); a model it does not
 * know is dropped with a note. A Copilot agent's tools (`read, search, execute`) are read in
 * Claude's names (`Read, Grep, Glob, Bash`) for every harness but Copilot (ruling O14).
 *
 * - claude  `.md`: name, description, model (a Claude Code model only), tools (comma-joined),
 *   disallowedTools, skills, mcpServers, color, then the subagent keys Claude Code reads from
 *   `extra`; other harnesses' keys are dropped and reported, and Cursor's `readonly: true`
 *   becomes a read-only tool list (ruling Y10); body.
 * - codex   `.toml`: name, description, model (not a Claude model), whitelisted
 *   Codex keys from `extra`, developer_instructions as a multi-line basic string.
 *   Codex agent `mcp_servers` is a table of server *definitions*, so a list of names
 *   cannot be expressed: dropped (the servers palm installs into config.toml are
 *   inherited by subagents).
 * - copilot `.agent.md`: name (displayName), description, model (not a Claude alias),
 *   tools (list in Copilot's tool aliases, tool-names.ts `copilotTool`: `Bash` → `execute`,
 *   `mcp__s__t` → `s/t`, argument restrictions and unknown names reported; `<server>/*` added
 *   for each mcpServers entry so MCP tools stay allowed). `mcp-servers` is a map of definitions
 *   in Copilot, so names are dropped.
 * - cursor  `.md`: name, description, model (not a Claude alias; `inherit` kept),
 *   readonly when tools exist and none of them writes or runs programs (ruling E9).
 * - gemini  `.md`: Gemini's agent schema is `.strict()` ("any unknown key fails the whole
 *   file"), so only name (`^[a-z0-9-_]+$`), description, kind: local, display_name, tools
 *   (Gemini names, tool-names.ts), model (not a Claude model) and temperature / max_turns /
 *   timeout_mins from `extra`. Gemini's `mcp_servers` holds inline server *definitions*, so
 *   referenced servers stay global and become `mcp_<server>_*` tools (R7 §3).
 * - opencode `.md`: description, mode: subagent, model (`provider/model-id` only), color
 *   (hex or theme name), `permission` from the tool lists (`readonly: true` denies edit and
 *   bash), and temperature / top_p / steps /
 *   variant / hidden from `extra`. OpenCode moves unknown keys into `options` "passed through
 *   directly to the provider as model options", so everything else is stripped (R7 §3).
 */
import { stringify as tomlStringify } from 'smol-toml';
import type { AgentDefinition, TargetId } from '../core/types.js';
import { normalizeBody, stringifyFrontmatter } from '../lib/frontmatter.js';
import { withoutUndefined } from '../lib/object.js';
import { knownModel } from './agent-models.js';
import {
  claudeToolsFromCopilot,
  copilotTool,
  geminiTool,
  hasToolArgument,
  opencodePermission,
  opencodeServerPattern,
  toolName,
} from './tool-names.js';

/** Tools that change files or run programs: an agent with one of them is not read-only. */
const WRITE_OR_RUN_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'PowerShell',
]);
/** What Cursor's `readonly: true` becomes as a Claude Code tool list (ruling Y10). */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];

/** True when a tool entry (`Bash(git:*)` included) can change files or run programs. */
function writesOrRuns(entry: string): boolean {
  return WRITE_OR_RUN_TOOLS.has(toolName(entry));
}

/** Cursor's `readonly: true` (a boolean or the string), read from the definition's extra keys. */
function isReadonly(def: AgentDefinition): boolean {
  const v = def.extra?.readonly;
  return v === true || v === 'true';
}

/** The definition without `readonly`, once a renderer has expressed it another way. */
function withoutReadonly(def: AgentDefinition): AgentDefinition {
  if (!def.extra || !('readonly' in def.extra)) return def;
  const { readonly: _readonly, ...extra } = def.extra;
  return { ...def, extra };
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
/** Subagent keys Claude Code reads beyond the typed fields (code.claude.com/docs/en/sub-agents). */
const CLAUDE_EXTRA = [
  'mcpServers',
  'permissionMode',
  'maxTurns',
  'hooks',
  'memory',
  'background',
  'effort',
  'isolation',
  'initialPrompt',
  'omitClaudeMd',
  'experimental',
];
const GEMINI_EXTRA = ['temperature', 'max_turns', 'timeout_mins'];
const OPENCODE_EXTRA = ['temperature', 'top_p', 'steps', 'variant', 'hidden'];
/** OpenCode colors: `#RRGGBB` or a theme color (packages/core/src/v1/config/agent.ts). */
const OPENCODE_COLOR = /^(#[0-9a-fA-F]{6}|primary|secondary|accent|success|warning|error|info)$/;
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

type RenderedAgent = {
  fileName: string;
  content: string;
  dropped: string[];
  /** Changes worth reporting that drop nothing (a renamed agent). */
  notes?: string[];
};

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

/** The agent's model, or undefined (recorded as dropped) when `target` does not know it (Y9'). */
function keepModel(def: AgentDefinition, target: TargetId, dropped: string[]): string | undefined {
  const { model } = def;
  if (!model || knownModel(target, model, def.sourceFormat)) return model;
  dropped.push(`model (${model})`);
  return undefined;
}

/**
 * Claude Code tools: the list as written, or with Cursor's `readonly: true` a list that only reads
 * (the write and run tools taken out of a list, else `READ_ONLY_TOOLS`), with a note.
 */
function claudeTools(
  def: AgentDefinition,
  lists: AgentLists,
  notes: string[],
): string[] | undefined {
  if (!isReadonly(def)) return lists.tools;
  if (!lists.tools) {
    notes.push(`readonly: true written as tools: ${READ_ONLY_TOOLS.join(', ')}`);
    return READ_ONLY_TOOLS;
  }
  const removed = lists.tools.filter(writesOrRuns);
  const kept = lists.tools.filter((t) => !writesOrRuns(t));
  if (removed.length) notes.push(`readonly: true: ${removed.join(', ')} left out of tools`);
  return kept.length ? kept : READ_ONLY_TOOLS;
}

/**
 * Claude Code: the typed fields plus the subagent keys it reads; a model it cannot run (`fast`,
 * a Cursor or OpenAI id) and keys of other harnesses are dropped and reported (ruling Y10).
 */
function renderClaude(def: AgentDefinition, lists: AgentLists): RenderedAgent {
  const dropped: string[] = [];
  const notes: string[] = [];
  const model = keepModel(def, 'claude', dropped);
  const tools = claudeTools(def, lists, notes);
  const kept = keepExtra(withoutReadonly(def), CLAUDE_EXTRA, dropped);
  const fm = {
    name: def.name,
    description: def.description,
    model,
    tools: tools?.join(', '),
    disallowedTools: lists.disallowedTools?.join(', '),
    skills: lists.skills,
    mcpServers: lists.mcpServers,
    color: def.color,
    ...kept,
  };
  const content = stringifyFrontmatter(fm, def.body);
  return { fileName: `${def.name}.md`, content, dropped, ...(notes.length ? { notes } : {}) };
}

/** Cursor's `readonly: true` as Codex's `sandbox_mode = "read-only"` (unless one is set). */
function codexSandbox(def: AgentDefinition, notes: string[]): AgentDefinition {
  if (!isReadonly(def)) return def;
  const plain = withoutReadonly(def);
  if (plain.extra?.sandbox_mode !== undefined) return plain;
  notes.push('readonly: true written as sandbox_mode = "read-only"');
  return { ...plain, extra: { ...plain.extra, sandbox_mode: 'read-only' } };
}

function renderCodex(source: AgentDefinition, lists: AgentLists): RenderedAgent {
  const dropped: string[] = [];
  const notes: string[] = [];
  const def = codexSandbox(source, notes);
  const model = keepModel(def, 'codex', dropped);
  dropFields(def, lists, ['tools', 'disallowedTools', 'skills', 'mcpServers', 'color'], dropped);
  const kept = keepExtra(def, CODEX_EXTRA, dropped);
  const head = tomlStringify({
    name: def.name,
    description: def.description,
    ...(model ? { model } : {}),
    ...kept,
  }).replace(/\n+$/, '');
  const content = `${head}\ndeveloper_instructions = ${tomlMultilineString(normalizeBody(def.body))}\n`;
  return { fileName: `${def.name}.toml`, content, dropped, ...(notes.length ? { notes } : {}) };
}

/**
 * Copilot `tools` in Copilot's names ("All unrecognized tool names are ignored", so a copied
 * `Bash(git:*)` would silently lose the shell): each entry mapped, lost argument restrictions and
 * entries without an equivalent recorded as dropped. MCP tools stay allowed when tools are
 * restricted (`<server>/*` per referenced server).
 */
function copilotTools(lists: AgentLists, dropped: string[]): string[] | undefined {
  if (!lists.tools) return undefined;
  const out = new Set<string>();
  for (const entry of lists.tools) {
    const mapped = copilotTool(entry);
    if (!mapped) dropped.push(`tools: ${entry} (no GitHub Copilot equivalent)`);
    else if (hasToolArgument(entry)) dropped.push(`tools: ${entry} restriction (all of ${mapped})`);
    if (mapped) out.add(mapped);
  }
  for (const server of lists.mcpServers ?? []) out.add(`${server}/*`);
  return [...out];
}

function renderCopilot(def: AgentDefinition, lists: AgentLists): RenderedAgent {
  const dropped: string[] = [];
  const model = keepModel(def, 'copilot', dropped);
  const tools = copilotTools(lists, dropped);
  dropFields(def, lists, ['mcpServers', 'skills', 'disallowedTools', 'color'], dropped);
  const kept = keepExtra(def, COPILOT_EXTRA, dropped);
  const fm = {
    name: def.displayName ?? def.name,
    description: def.description,
    model,
    tools,
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
  const model = keepModel(def, 'cursor', dropped);
  const { tools } = lists;
  const readonly = tools ? !tools.some(writesOrRuns) : undefined;
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

/** Gemini agent names must match `^[a-z0-9-_]+$`: lowercased, anything else becomes `-`. */
function geminiName(name: string, notes: string[]): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (slug !== name)
    notes.push(`name "${name}" written as "${slug}" (Gemini agent names are [a-z0-9-_])`);
  return slug;
}

/**
 * Gemini `tools`: each entry in Gemini's name, then `activate_skill` when skills are listed
 * ("Skills reach the agent through the `activate_skill` tool") and `mcp_<server>_*` per
 * referenced server. Undefined (inherit every tool) when the definition lists none.
 */
function geminiTools(lists: AgentLists, dropped: string[]): string[] | undefined {
  if (!lists.tools) return undefined;
  const out = new Set<string>();
  for (const entry of lists.tools) {
    const mapped = geminiTool(entry);
    if (!mapped) dropped.push(`tools: ${entry} (no Gemini CLI equivalent)`);
    else if (hasToolArgument(entry)) dropped.push(`tools: ${entry} restriction (all of ${mapped})`);
    if (mapped) out.add(mapped);
  }
  if (lists.skills) out.add('activate_skill');
  for (const server of lists.mcpServers ?? []) out.add(`mcp_${server}_*`);
  return [...out];
}

function renderGemini(def: AgentDefinition, lists: AgentLists): RenderedAgent {
  const dropped: string[] = [];
  const notes: string[] = [];
  const name = geminiName(def.name, notes);
  const model = keepModel(def, 'gemini', dropped);
  const tools = geminiTools(lists, dropped);
  dropFields(def, lists, ['disallowedTools', 'skills', 'color'], dropped);
  const kept = keepExtra(def, GEMINI_EXTRA, dropped);
  const fm = {
    name,
    description: def.description,
    kind: 'local',
    display_name: def.displayName,
    tools,
    model,
    ...kept,
  };
  const content = stringifyFrontmatter(fm, def.body);
  return { fileName: `${def.name}.md`, content, dropped, notes };
}

/** Allow `key` in an OpenCode permission block; entries without an equivalent are dropped. */
function allowTool(perm: Record<string, unknown>, entry: string, dropped: string[]): void {
  const key = opencodePermission(entry);
  if (!key) dropped.push(`tools: ${entry} (no OpenCode equivalent)`);
  else if (hasToolArgument(entry)) dropped.push(`tools: ${entry} restriction (all of ${key})`);
  if (key) perm[key] = 'allow';
}

/**
 * OpenCode `permission` (R7 §3): a tool list becomes `"*": "deny"` plus an `allow` per tool,
 * per referenced MCP server (`<server>_*`) and per listed skill (`skill: {<name>: allow}`);
 * disallowedTools become `deny` entries. Later rules win in OpenCode, so denials come last.
 */
function opencodePermissions(
  lists: AgentLists,
  dropped: string[],
): Record<string, unknown> | undefined {
  const perm: Record<string, unknown> = {};
  if (lists.tools) {
    perm['*'] = 'deny';
    for (const entry of lists.tools) allowTool(perm, entry, dropped);
    for (const server of lists.mcpServers ?? []) perm[opencodeServerPattern(server)] = 'allow';
    if (lists.skills && perm.skill !== 'allow')
      perm.skill = Object.fromEntries(lists.skills.map((s) => [s, 'allow']));
  }
  for (const entry of lists.disallowedTools ?? []) {
    const key = opencodePermission(entry);
    if (key) perm[key] = 'deny';
    else dropped.push(`disallowedTools: ${entry} (no OpenCode equivalent)`);
  }
  return Object.keys(perm).length ? perm : undefined;
}

/** Cursor's `readonly: true` as OpenCode denials, after every allow (later rules win). */
function readonlyPermissions(
  perm: Record<string, unknown> | undefined,
  readonly: boolean,
): Record<string, unknown> | undefined {
  return readonly ? { ...perm, edit: 'deny', bash: 'deny' } : perm;
}

function renderOpencode(def: AgentDefinition, lists: AgentLists): RenderedAgent {
  const dropped: string[] = [];
  // OpenCode models are `provider/model-id`: Claude aliases and bare ids name no provider.
  const model = keepModel(def, 'opencode', dropped);
  const color = def.color && OPENCODE_COLOR.test(def.color) ? def.color : undefined;
  if (def.color && !color) dropped.push(`color (${def.color})`);
  const readonly = isReadonly(def);
  const permission = readonlyPermissions(opencodePermissions(lists, dropped), readonly);
  // Skills are not preloaded; with a tool list they are allowed through `permission.skill`.
  dropFields(def, lists, ['skills'], dropped);
  const kept = keepExtra(withoutReadonly(def), OPENCODE_EXTRA, dropped);
  const fm = { description: def.description, mode: 'subagent', model, color, permission, ...kept };
  const notes = readonly ? ['readonly: true written as permission edit: deny, bash: deny'] : [];
  const content = stringifyFrontmatter(fm, def.body);
  return { fileName: `${def.name}.md`, content, dropped, ...(notes.length ? { notes } : {}) };
}

const RENDERERS: Record<TargetId, (def: AgentDefinition, lists: AgentLists) => RenderedAgent> = {
  claude: renderClaude,
  codex: renderCodex,
  copilot: renderCopilot,
  cursor: renderCursor,
  gemini: renderGemini,
  opencode: renderOpencode,
};

/**
 * Dependencies as the harness knows them: a source may write `tdd@mattpocock#v1` or
 * `skill:tdd`; the harness only sees the installed name `tdd`.
 */
function bareNames(refs: string[] | undefined): string[] | undefined {
  const names = (refs ?? []).map((r) =>
    r
      .trim()
      .replace(/[@#].*$/, '')
      .replace(/^[a-z]+:/, ''),
  );
  return nonEmpty([...new Set(names.filter((n) => n !== ''))]);
}

/** Agent formats whose `tools` are GitHub Copilot aliases (`read`, `execute`, `github/*`). */
const COPILOT_TOOL_FORMATS: ReadonlySet<AgentDefinition['sourceFormat']> = new Set([
  'copilot-agent-md',
  'apm-agent-md',
]);

/**
 * The agent's tools in Claude's names, which every renderer maps from (ruling O14): a Copilot
 * agent's `read, search, execute` become `Read, Grep, Glob, Bash` for every harness but Copilot;
 * `*` is every tool (no list); a Copilot tool Claude Code has no name for is dropped.
 */
function toolsOf(def: AgentDefinition, target: TargetId, dropped: string[]): string[] | undefined {
  const tools = nonEmpty(def.tools);
  if (!tools || target === 'copilot' || !COPILOT_TOOL_FORMATS.has(def.sourceFormat)) return tools;
  const mapped = claudeToolsFromCopilot(tools);
  for (const t of mapped.unmapped) dropped.push(`tools: ${t} (a GitHub Copilot tool)`);
  return mapped.all ? undefined : nonEmpty(mapped.tools);
}

export function renderAgent(def: AgentDefinition, target: TargetId): RenderedAgent {
  const unmapped: string[] = [];
  const lists: AgentLists = {
    tools: toolsOf(def, target, unmapped),
    disallowedTools: nonEmpty(def.disallowedTools),
    skills: bareNames(def.skills),
    mcpServers: bareNames(def.mcpServers),
  };
  const r = RENDERERS[target](def, lists);
  return unmapped.length ? { ...r, dropped: [...unmapped, ...r.dropped] } : r;
}
