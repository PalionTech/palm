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

/**
 * TOML multi-line basic string. Escapes backslashes, control characters and every
 * quote that is part of a run of two or more or that ends the string, so the
 * closing delimiter can never be formed by the content.
 */
export function tomlMultilineString(s: string): string {
  let body = s
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\n')
    .replace(
      /[\u0000-\u0008\u000b-\u001f\u007f]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    .replace(/"{2,}/g, (run) => run.replace(/"/g, '\\"'));
  if (body.endsWith('"') && !body.endsWith('\\"')) body = body.slice(0, -1) + '\\"';
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

export function renderAgent(
  def: AgentDefinition,
  target: TargetId,
): { fileName: string; content: string; dropped: string[] } {
  const dropped: string[] = [];
  const tools = nonEmpty(def.tools);
  const skills = nonEmpty(def.skills);
  const mcpServers = nonEmpty(def.mcpServers);
  const disallowed = nonEmpty(def.disallowedTools);

  switch (target) {
    case 'claude': {
      const extra = Object.fromEntries(
        Object.entries(def.extra ?? {}).filter(([k]) => !CLAUDE_KNOWN.includes(k)),
      );
      const fm = {
        name: def.name,
        description: def.description,
        model: def.model,
        tools: tools?.join(', '),
        disallowedTools: disallowed?.join(', '),
        skills,
        mcpServers,
        color: def.color,
        ...extra,
      };
      return { fileName: `${def.name}.md`, content: stringifyFrontmatter(fm, def.body), dropped };
    }

    case 'codex': {
      let model = def.model;
      if (model && isClaudeModel(model)) {
        dropped.push(`model (${model})`);
        model = undefined;
      }
      if (tools) dropped.push('tools');
      if (disallowed) dropped.push('disallowedTools');
      if (skills) dropped.push('skills');
      if (mcpServers) dropped.push('mcpServers');
      if (def.color) dropped.push('color');
      const { kept, dropped: extraDropped } = pickExtra(def.extra, CODEX_EXTRA);
      dropped.push(...extraDropped.map((k) => `extra: ${k}`));
      const head = tomlStringify({
        name: def.name,
        description: def.description,
        ...(model ? { model } : {}),
        ...kept,
      }).replace(/\n+$/, '');
      const content = `${head}\ndeveloper_instructions = ${tomlMultilineString(normalizeBody(def.body))}\n`;
      return { fileName: `${def.name}.toml`, content, dropped };
    }

    case 'copilot': {
      let model = def.model;
      if (model && isClaudeModelAlias(model)) {
        dropped.push(`model (${model})`);
        model = undefined;
      }
      let copilotTools = tools ? [...tools] : undefined;
      if (copilotTools && mcpServers) {
        for (const s of mcpServers)
          if (!copilotTools.includes(`${s}/*`)) copilotTools.push(`${s}/*`);
      }
      if (mcpServers) dropped.push('mcpServers');
      if (skills) dropped.push('skills');
      if (disallowed) dropped.push('disallowedTools');
      if (def.color) dropped.push('color');
      const { kept, dropped: extraDropped } = pickExtra(def.extra, COPILOT_EXTRA);
      dropped.push(...extraDropped.map((k) => `extra: ${k}`));
      if (copilotTools?.length === 0) copilotTools = undefined;
      const fm = {
        name: def.displayName ?? def.name,
        description: def.description,
        model,
        tools: copilotTools,
        ...kept,
      };
      return {
        fileName: `${def.name}.agent.md`,
        content: stringifyFrontmatter(fm, def.body),
        dropped,
      };
    }

    case 'cursor': {
      let model = def.model;
      if (model && isClaudeModelAlias(model) && model.trim().toLowerCase() !== 'inherit') {
        dropped.push(`model (${model})`);
        model = undefined;
      }
      const readonly = tools ? !tools.some((t) => WRITE_TOOLS.has(t)) : undefined;
      if (tools) dropped.push(readonly ? 'tools (mapped to readonly: true)' : 'tools');
      if (disallowed) dropped.push('disallowedTools');
      if (skills) dropped.push('skills');
      if (mcpServers) dropped.push('mcpServers');
      if (def.color) dropped.push('color');
      const { kept, dropped: extraDropped } = pickExtra(def.extra, CURSOR_EXTRA);
      dropped.push(...extraDropped.map((k) => `extra: ${k}`));
      const fm = {
        name: def.name,
        description: def.description,
        model,
        ...(readonly ? { readonly: true } : {}),
        ...kept,
      };
      return { fileName: `${def.name}.md`, content: stringifyFrontmatter(fm, def.body), dropped };
    }
  }
}
