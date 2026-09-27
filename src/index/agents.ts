/**
 * Agent definition parsing:
 *  - Claude Code / Cursor `.md` (frontmatter + system prompt body)
 *  - GitHub Copilot `.agent.md` (also APM `.apm/agents/*.agent.md`)
 *  - Codex `.toml` (`developer_instructions` is the body)
 */

import { basename } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { AgentDefinition } from '../core/types.js';
import { PalmError } from '../core/errors.js';
import { parseFrontmatterYaml, splitFrontmatter } from './frontmatter.js';
import { isValidSlug, toSlug } from './slug.js';
import { asList, asString, compact, isRecord } from './util.js';

export interface ParsedAgent {
  def: AgentDefinition;
  issues: string[];
  /** Whether the source had frontmatter (md) / was a table (toml). */
  hasFrontmatter: boolean;
  /** The source-declared name, if any. */
  declaredName?: string;
}

/** File stem without `.agent.md` / `.md` / `.toml`. */
export function agentStem(fileName: string): string {
  const b = basename(fileName);
  for (const ext of ['.agent.md', '.chatmode.md', '.md', '.toml']) {
    if (b.toLowerCase().endsWith(ext)) return b.slice(0, -ext.length);
  }
  return b;
}

export function parseAgentFile(absPath: string, text: string): AgentDefinition {
  return parseAgentFileDetailed(absPath, text).def;
}

const CURSOR_ONLY_KEYS = ['readonly', 'is_background', 'isBackground'];

export function parseAgentFileDetailed(absPath: string, text: string): ParsedAgent {
  const lower = absPath.toLowerCase();
  if (lower.endsWith('.toml')) return parseCodexToml(absPath, text);

  const split = splitFrontmatter(text);
  const data = split.hasFrontmatter ? parseFrontmatterYaml(split.raw) : {};
  const isApm = /(^|[\\/])\.apm[\\/]agents[\\/]/.test(absPath);
  const isAgentMd = lower.endsWith('.agent.md') || lower.endsWith('.chatmode.md');
  let sourceFormat: AgentDefinition['sourceFormat'];
  if (isApm) sourceFormat = 'apm-agent-md';
  else if (isAgentMd) sourceFormat = 'copilot-agent-md';
  else if (CURSOR_ONLY_KEYS.some((k) => k in data)) sourceFormat = 'cursor-md';
  else sourceFormat = 'claude-md';

  const known = new Set(['name', 'description', 'model', 'tools', 'disallowedTools', 'disallowed-tools', 'skills', 'mcpServers', 'instructions', 'color']);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!known.has(k)) extra[k] = v;

  // mcpServers: string entries are dependencies; inline server objects stay in `extra`.
  const mcpRaw = data.mcpServers;
  let mcpServers: string[] | undefined;
  if (Array.isArray(mcpRaw)) {
    mcpServers = mcpRaw.map((x) => asString(x)).filter((x): x is string => x !== undefined);
    if (mcpRaw.some((x) => isRecord(x))) extra.mcpServers = mcpRaw;
  } else if (typeof mcpRaw === 'string') {
    mcpServers = asList(mcpRaw);
  } else if (isRecord(mcpRaw)) {
    extra.mcpServers = mcpRaw;
  }

  const { name, displayName, issues } = resolveName(absPath, asString(data.name));
  const description = asString(data.description);
  if (description === undefined) issues.push('missing description');

  const def: AgentDefinition = compact({
    name,
    displayName,
    description: description ?? '',
    model: asString(data.model),
    tools: asList(data.tools),
    disallowedTools: asList(data.disallowedTools ?? data['disallowed-tools']),
    skills: asList(data.skills),
    mcpServers: mcpServers && mcpServers.length > 0 ? mcpServers : undefined,
    instructions: asList(data.instructions),
    color: asString(data.color),
    body: split.body,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
    sourceFormat,
  });
  return { def, issues, hasFrontmatter: split.hasFrontmatter, declaredName: asString(data.name) };
}

function parseCodexToml(absPath: string, text: string): ParsedAgent {
  let data: Record<string, unknown>;
  try {
    data = parseToml(text) as Record<string, unknown>;
  } catch (e) {
    throw new PalmError('E_PARSE', `invalid TOML in agent ${basename(absPath)}: ${(e as Error).message.split('\n')[0]}`);
  }
  const known = new Set(['name', 'description', 'developer_instructions', 'model', 'mcp_servers', 'tools', 'skills', 'color']);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!known.has(k)) extra[k] = v;
  let mcpServers: string[] | undefined;
  if (isRecord(data.mcp_servers)) {
    mcpServers = Object.keys(data.mcp_servers);
    extra.mcp_servers = data.mcp_servers;
  } else if (Array.isArray(data.mcp_servers)) {
    mcpServers = asList(data.mcp_servers);
  }
  const { name, displayName, issues } = resolveName(absPath, asString(data.name));
  const description = asString(data.description);
  if (description === undefined) issues.push('missing description');
  const body = typeof data.developer_instructions === 'string' ? data.developer_instructions : '';
  if (body === '') issues.push('missing developer_instructions');
  const def: AgentDefinition = compact({
    name,
    displayName,
    description: description ?? '',
    model: asString(data.model),
    tools: asList(data.tools),
    skills: asList(data.skills),
    mcpServers: mcpServers && mcpServers.length > 0 ? mcpServers : undefined,
    color: asString(data.color),
    body,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
    sourceFormat: 'codex-toml' as const,
  });
  return { def, issues, hasFrontmatter: true, declaredName: asString(data.name) };
}

/**
 * Canonical agent name.
 *  - Claude/Cursor `.md` and Codex `.toml`: the declared `name` is the harness identity, so a
 *    valid slug wins (wshobson/agents namespaces names like `backend-development-debugger`).
 *  - Copilot `.agent.md`: the file stem is the identity and `name` is a display label.
 *  - A declared name that is not a slug ("Comment Sicko", "C# Expert") becomes `displayName`
 *    and the slugified file stem is used (DESIGN §5).
 */
function resolveName(absPath: string, declared: string | undefined): { name: string; displayName?: string; issues: string[] } {
  const stem = agentStem(absPath);
  const stemIsIdentity = /\.(agent|chatmode)\.md$/i.test(absPath);
  const issues: string[] = [];
  if (declared !== undefined && isValidSlug(declared) && !stemIsIdentity) return { name: declared, issues };
  const name = toSlug(stem, declared);
  if (declared === undefined || declared === name) return { name, issues };
  return { name, displayName: declared, issues };
}
