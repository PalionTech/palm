/**
 * Claude Code tool names in the Gemini CLI and OpenCode dialects (research R7).
 *
 * - Gemini CLI agent `tools` entries must pass `isValidToolName` (built-in names, `*`,
 *   `mcp_<server>_<tool>`, `mcp_<server>_*`): "Claude names (`Read`, `Bash`) are invalid and
 *   would break the agent" (gemini-cli packages/core/src/tools/tool-names.ts). Hook matchers
 *   are regexes over the same names.
 * - OpenCode agents restrict tools through `permission` keys; an MCP tool is named
 *   `sanitize(server) + "_" + sanitize(tool)` (opencode packages/opencode/src/mcp/catalog.ts).
 *
 * A Claude entry with an argument (`Bash(git:*)`) maps by its tool name; callers report the
 * lost restriction.
 */

/** Claude → Gemini CLI built-in tool names (R7 §3). `Task` and `NotebookEdit` have none. */
const GEMINI: Readonly<Record<string, string>> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'replace',
  MultiEdit: 'replace',
  Glob: 'glob',
  Grep: 'grep_search',
  LS: 'list_directory',
  Bash: 'run_shell_command',
  WebFetch: 'web_fetch',
  WebSearch: 'google_web_search',
  TodoWrite: 'write_todos',
  Skill: 'activate_skill',
};

/** Gemini names an origin may already use; kept as written. */
const GEMINI_NATIVE: ReadonlySet<string> = new Set([
  ...Object.values(GEMINI),
  'read_many_files',
  'save_memory',
  '*',
]);

/** Claude → OpenCode permission keys (R7 §3: `Write/Edit→edit`, `LS→list`, `Task→task`). */
const OPENCODE: Readonly<Record<string, string>> = {
  Read: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  Glob: 'glob',
  Grep: 'grep',
  LS: 'list',
  Bash: 'bash',
  Task: 'task',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  TodoWrite: 'todowrite',
  Skill: 'skill',
};

/** The tool name of an entry: `Bash(git:*)` → `Bash`. */
function toolName(entry: string): string {
  return entry.trim().replace(/\(.*\)$/s, '');
}

/** True when the entry narrows its tool with an argument (`Bash(git:*)`). */
export function hasToolArgument(entry: string): boolean {
  return /\(.*\)$/s.test(entry.trim());
}

/** `mcp__server__tool` → server and tool; `mcp__server` and `mcp__server__*` → server only. */
function mcpTool(name: string): { server: string; tool?: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep < 0) return { server: rest };
  const tool = rest.slice(sep + 2);
  return { server: rest.slice(0, sep), tool: tool === '' || tool === '*' ? undefined : tool };
}

/** The Gemini CLI name of a Claude tool entry; undefined when Gemini has no equivalent. */
export function geminiTool(entry: string): string | undefined {
  const name = toolName(entry);
  const mcp = mcpTool(name);
  if (mcp) return `mcp_${mcp.server}_${mcp.tool ?? '*'}`;
  if (GEMINI_NATIVE.has(name) || name.startsWith('mcp_')) return name;
  return GEMINI[name];
}

/**
 * A Claude hook matcher (a regex over tool names) in Gemini's names: `Edit|Write` →
 * `replace|write_file`, `mcp__github__.*` → `mcp_github_.*`. Alternatives that became equal
 * (`Edit|MultiEdit`) are merged; words that are not Claude tools stay as written.
 */
export function geminiMatcher(matcher: string): string {
  const mapped = matcher
    .replace(/\bmcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__/g, 'mcp_$1_')
    .replace(/\bmcp__/g, 'mcp_')
    .replace(/\b[A-Z][A-Za-z]*\b/g, (word) => GEMINI[word] ?? word);
  if (!/^[\w|]+$/.test(mapped)) return mapped;
  return [...new Set(mapped.split('|'))].join('|');
}

/** OpenCode's MCP name sanitizer: anything but letters, digits, `_` and `-` becomes `_`. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** The OpenCode permission pattern covering every tool of MCP server `server`. */
export function opencodeServerPattern(server: string): string {
  return `${sanitize(server)}_*`;
}

/** The OpenCode permission key of a Claude tool entry; undefined when OpenCode has none. */
export function opencodePermission(entry: string): string | undefined {
  const name = toolName(entry);
  const mcp = mcpTool(name);
  if (mcp)
    return mcp.tool
      ? `${sanitize(mcp.server)}_${sanitize(mcp.tool)}`
      : opencodeServerPattern(mcp.server);
  return OPENCODE[name];
}
