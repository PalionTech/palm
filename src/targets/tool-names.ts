/**
 * Claude Code tool names in the Gemini CLI, OpenCode, GitHub Copilot and Cursor dialects
 * (research R7; Copilot and Cursor docs as cited at each table).
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

/** `table[key]` for own keys only (`constructor` is not a tool name). */
function lookup(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The tool name of an entry: `Bash(git:*)` → `Bash`. */
export function toolName(entry: string): string {
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
  return lookup(GEMINI, name);
}

/**
 * Claude → GitHub Copilot custom-agent tool aliases ("Tool aliases", docs.github.com
 * copilot/reference/custom-agents-configuration: `execute` ← shell, Bash, powershell;
 * `read` ← Read, NotebookRead; `edit` ← Edit, MultiEdit, Write, NotebookEdit; `search` ← Grep,
 * Glob; `agent` ← custom-agent, Task; `web` ← WebSearch, WebFetch; `todo` ← TodoWrite).
 * "All unrecognized tool names are ignored", so anything else is dropped and reported.
 */
const COPILOT_AGENT: Readonly<Record<string, string>> = {
  Bash: 'execute',
  Read: 'read',
  NotebookRead: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  Task: 'agent',
  WebFetch: 'web',
  WebSearch: 'web',
  TodoWrite: 'todo',
};

/** Copilot's own agent tool names (primary aliases and the lower-case compatible ones). */
const COPILOT_AGENT_NATIVE: ReadonlySet<string> = new Set([
  ...Object.values(COPILOT_AGENT),
  'shell',
  'powershell',
  'custom-agent',
  '*',
]);

/**
 * The GitHub Copilot agent tool of a Claude tool entry: `Bash(git:*)` → `execute` (the caller
 * reports the lost restriction), `mcp__docs__search` → `docs/search`, `mcp__docs` → `docs/*`;
 * Copilot names (`read`, `github/*`) stay as written. Undefined when Copilot has no equivalent.
 */
export function copilotTool(entry: string): string | undefined {
  const name = toolName(entry);
  const mcp = mcpTool(name);
  if (mcp) return `${mcp.server}/${mcp.tool ?? '*'}`;
  if (COPILOT_AGENT_NATIVE.has(name) || /^[\w.-]+\/[\w.*-]+$/.test(name)) return name;
  return lookup(COPILOT_AGENT, name);
}

/** A dialect whose hook matchers are regexes over its own tool names (Codex speaks Claude's). */
export type ToolDialect = 'claude' | 'cursor' | 'copilot' | 'gemini';

/** How to move a matcher between Claude's names and one other dialect's. */
interface MatcherMap {
  /** One tool-name word of the source dialect. */
  word: RegExp;
  /** Source name → target name, or `a|b` alternatives when one name covers several. */
  names: Readonly<Record<string, string>>;
  /** MCP tool prefixes, rewritten before the names. */
  mcp: ReadonlyArray<readonly [RegExp, string]>;
}

const CLAUDE_WORD = /\b[A-Z][A-Za-z]*\b/g;
const SNAKE_WORD = /\b[a-z][a-z_]*\b/g;
/** `mcp__<server>__` (a server name may itself hold single underscores). */
const CLAUDE_MCP = /\bmcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__/g;

/** The inverse of `names`, many-to-one names joined as alternatives (`Write` → `Write|Edit`). */
function invert(names: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [claude, other] of Object.entries(names))
    out[other] = Object.hasOwn(out, other) ? `${out[other]}|${claude}` : claude;
  return out;
}

/**
 * Claude → Cursor hook matcher tool types: "Values include `Shell`, `Read`, `Write`, `Grep`,
 * `Delete`, `Task`, and MCP tools using the `MCP:<tool_name>` format" (cursor.com/docs/agent/hooks).
 */
const CURSOR_HOOK: Readonly<Record<string, string>> = {
  Bash: 'Shell',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Write',
  MultiEdit: 'Write',
  NotebookEdit: 'Write',
  Grep: 'Grep',
  Task: 'Task',
};

/**
 * Claude → Copilot hook tool names (`toolName`, matched as `^(?:PATTERN)$`: bash, powershell,
 * view, create, edit, grep, glob, web_fetch, web_search, ask_user, task;
 * docs.github.com copilot/reference/hooks-configuration).
 */
const COPILOT_HOOK: Readonly<Record<string, string>> = {
  Bash: 'bash',
  Read: 'view',
  Write: 'create',
  Edit: 'edit',
  MultiEdit: 'edit',
  Grep: 'grep',
  Glob: 'glob',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  Task: 'task',
  AskUserQuestion: 'ask_user',
};

/** Claude names → each dialect. */
const FROM_CLAUDE: Readonly<Record<Exclude<ToolDialect, 'claude'>, MatcherMap>> = {
  gemini: {
    word: CLAUDE_WORD,
    names: GEMINI,
    mcp: [
      [CLAUDE_MCP, 'mcp_$1_'],
      [/\bmcp__/g, 'mcp_'],
    ],
  },
  cursor: { word: CLAUDE_WORD, names: CURSOR_HOOK, mcp: [[CLAUDE_MCP, 'MCP:']] },
  copilot: { word: CLAUDE_WORD, names: COPILOT_HOOK, mcp: [] },
};

/** Each dialect → Claude names. Gemini's `mcp_<server>_` takes the server up to the first `_`. */
const INTO_CLAUDE: Readonly<Record<Exclude<ToolDialect, 'claude'>, MatcherMap>> = {
  gemini: {
    word: SNAKE_WORD,
    names: { ...invert(GEMINI), replace: 'Edit', read_many_files: 'Read' },
    mcp: [[/\bmcp_([A-Za-z0-9-]+)_/g, 'mcp__$1__']],
  },
  cursor: { word: CLAUDE_WORD, names: invert(CURSOR_HOOK), mcp: [[/\bMCP:/g, 'mcp__.*__']] },
  copilot: {
    word: SNAKE_WORD,
    names: { ...invert(COPILOT_HOOK), edit: 'Edit', powershell: 'Bash' },
    mcp: [],
  },
};

/** Replace every mapped word of `text`; a name that became alternatives is grouped. */
function replaceWords(text: string, map: MatcherMap): string {
  return text.replace(map.word, (w) => {
    const to = lookup(map.names, w);
    if (to === undefined) return w;
    return to.includes('|') ? `(?:${to})` : to;
  });
}

/**
 * `matcher` with `map` applied. A plain alternation (`Edit|Write`) is mapped per alternative,
 * flattened and deduplicated (`Edit|MultiEdit` → `replace`); a regex with groups or escapes has
 * each name replaced in place. Words that are not tool names stay as written.
 */
function translate(matcher: string, map: MatcherMap): string {
  let text = matcher;
  for (const [from, to] of map.mcp) text = text.replace(from, to);
  if (/[()[\]\\]/.test(text)) return replaceWords(text, map);
  const alternatives = text
    .split('|')
    .flatMap((alt) => (lookup(map.names, alt) ?? replaceWords(alt, map)).split('|'));
  return [...new Set(alternatives)].join('|');
}

/**
 * A hook matcher (a regex over tool names) from one dialect's tool names into another's,
 * through Claude's: Claude `Edit|Write` → Gemini `replace|write_file`, Cursor `Write`,
 * Copilot `edit|create`; Gemini `run_shell_command` → Claude `Bash`; `mcp__github__.*` →
 * `mcp_github_.*` (Gemini) or `MCP:.*` (Cursor, which names no server).
 */
export function hookMatcher(matcher: string, from: ToolDialect, to: ToolDialect): string {
  if (from === to) return matcher;
  const claude = from === 'claude' ? matcher : translate(matcher, INTO_CLAUDE[from]);
  return to === 'claude' ? claude : translate(claude, FROM_CLAUDE[to]);
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
  return lookup(OPENCODE, name);
}
