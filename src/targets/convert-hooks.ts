/**
 * Convert a HookSet between harness dialects.
 *
 * Output (`hooks`) is the file-shaped object for the target:
 * - claude / codex: `{ hooks: { <PascalEvent>: [{ matcher?, hooks: [{ type: "command", command, timeout? }] }] } }`
 * - cursor:         `{ version: 1, hooks: { <camelEvent>: [{ command, matcher?, timeout? }] } }`
 * - copilot:        `{ version: 1, hooks: { <camelEvent>: [{ type: "command", bash, timeoutSec?, matcher? }] } }`
 * - gemini:         `{ hooks: { <GeminiEvent>: [{ matcher?, hooks: [{ type: "command", command, timeout? }] }] } }`
 *                   with Gemini event names, tool names in matchers and `timeout` in milliseconds
 *                   ("`timeout` is in milliseconds", docs/hooks/reference.md)
 * - opencode:       none; OpenCode has no declarative hooks (the layout skips them)
 *
 * `${CLAUDE_PLUGIN_ROOT}`, `${CURSOR_PLUGIN_ROOT}`, `${PLUGIN_ROOT}` (and the unbraced
 * `$CLAUDE_PLUGIN_ROOT`) in command strings become `pluginRootAbs` at global scope. At project
 * scope the committed config must work in any clone, so they become the harness's project
 * directory followed by the root's project-relative path (`PROJECT_DIR`, DESIGN.md §2):
 * `$CLAUDE_PROJECT_DIR/.palm/hooks/<n>` (claude), `$CURSOR_PROJECT_DIR/.palm/hooks/<n>`
 * (cursor), `$GEMINI_PROJECT_DIR/.palm/hooks/<n>` (gemini), and the git top level for codex and
 * copilot, which set no such variable.
 *
 * Same-family conversions (claude→claude, claude→codex, cursor→cursor,
 * copilot→copilot, gemini→gemini) keep entries verbatim apart from the substitution; other
 * conversions go through a canonical `{ event, matcher, command, timeout }` form and
 * only `type: "command"` hooks survive. Events without an equivalent are reported
 * in `dropped`. Tool-event matchers (regexes over tool names) are translated both ways through
 * Claude's names (tool-names.ts `hookMatcher`): a Gemini `run_shell_command` or Cursor `Shell`
 * matcher becomes `Bash` for Claude and Codex, Claude `Edit|Write` becomes Cursor `Write`.
 */
import type { HookSet, TargetId } from '../core/types.js';
import { PLUGIN_ROOT_TOKENS } from '../domain/ignore.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { isWithin } from '../lib/fs.js';
import { isRecord } from '../lib/object.js';
import { hookMatcher, type ToolDialect } from './tool-names.js';

interface EventInfo {
  claude: string;
  cursor?: string;
  copilot?: string;
  /** Gemini CLI `HookEventName` (packages/core/src/hooks/types.ts), per research R7 §6. */
  gemini?: string;
  codex: boolean;
}

/** Canonical (Claude) event names and their equivalents. */
const HOOK_EVENTS: readonly EventInfo[] = [
  {
    claude: 'SessionStart',
    cursor: 'sessionStart',
    copilot: 'sessionStart',
    gemini: 'SessionStart',
    codex: true,
  },
  {
    claude: 'SessionEnd',
    cursor: 'sessionEnd',
    copilot: 'sessionEnd',
    gemini: 'SessionEnd',
    codex: true,
  },
  {
    claude: 'UserPromptSubmit',
    cursor: 'beforeSubmitPrompt',
    copilot: 'userPromptSubmitted',
    gemini: 'BeforeAgent',
    codex: true,
  },
  {
    claude: 'PreToolUse',
    cursor: 'preToolUse',
    copilot: 'preToolUse',
    gemini: 'BeforeTool',
    codex: true,
  },
  {
    claude: 'PostToolUse',
    cursor: 'postToolUse',
    copilot: 'postToolUse',
    gemini: 'AfterTool',
    codex: true,
  },
  {
    claude: 'PostToolUseFailure',
    cursor: 'postToolUseFailure',
    copilot: 'postToolUseFailure',
    codex: false,
  },
  { claude: 'Stop', cursor: 'stop', copilot: 'agentStop', gemini: 'AfterAgent', codex: true },
  { claude: 'SubagentStart', cursor: 'subagentStart', copilot: 'subagentStart', codex: true },
  { claude: 'SubagentStop', cursor: 'subagentStop', copilot: 'subagentStop', codex: true },
  {
    claude: 'PreCompact',
    cursor: 'preCompact',
    copilot: 'preCompact',
    gemini: 'PreCompress',
    codex: true,
  },
  { claude: 'PostCompact', codex: true },
  { claude: 'PermissionRequest', copilot: 'permissionRequest', codex: true },
  { claude: 'Notification', copilot: 'notification', gemini: 'Notification', codex: false },
];

/** Canonical events whose matcher is a regex over tool names (others match sources, triggers). */
const TOOL_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
]);

/** Gemini CLI event names → canonical. */
const GEMINI_EVENTS: Readonly<Record<string, string>> = Object.fromEntries(
  HOOK_EVENTS.flatMap((e) => (e.gemini ? [[e.gemini, e.claude]] : [])),
);

type Family = 'claude' | 'cursor' | 'copilot' | 'gemini';

/** The dialect a target's hooks file speaks (opencode has none: its hooks are skipped). */
function familyOf(target: TargetId): Family {
  return target === 'codex' || target === 'opencode' ? 'claude' : target;
}

/** Map a source event name (any dialect) to its canonical Claude name. */
function canonicalEvent(name: string, dialect: HookSet['dialect']): string | undefined {
  if (dialect === 'gemini' && GEMINI_EVENTS[name]) return GEMINI_EVENTS[name];
  const hit = HOOK_EVENTS.find((e) => e.claude === name || e.cursor === name || e.copilot === name);
  if (hit) return hit.claude;
  // Copilot also accepts PascalCase variants and a few aliases.
  if (name === 'userPromptSubmit') return 'UserPromptSubmit';
  return undefined;
}

/** Target event name for a canonical event; undefined when unsupported. */
function targetEvent(canonical: string, target: TargetId): string | undefined {
  const info = HOOK_EVENTS.find((e) => e.claude === canonical);
  if (!info) return undefined;
  switch (target) {
    case 'claude':
      return info.claude;
    case 'codex':
      return info.codex ? info.claude : undefined;
    case 'cursor':
      return info.cursor;
    case 'copilot':
      return info.copilot;
    case 'gemini':
      return info.gemini;
    case 'opencode':
      return undefined;
  }
}

/**
 * Codex and Copilot export no project-directory variable, and run hooks from the session's
 * working directory (Codex) or an undocumented default (Copilot), so project hooks resolve the
 * repository root themselves, as the Codex hook docs recommend; outside a git repository the
 * working directory stands in.
 */
const GIT_TOP_LEVEL = '$(git rev-parse --show-toplevel 2>/dev/null || pwd)';

/**
 * How a project-scope hook command names the project root, per harness:
 * - claude: `$CLAUDE_PROJECT_DIR` (https://code.claude.com/docs/en/hooks)
 * - cursor: `$CURSOR_PROJECT_DIR`, set for every hook (https://cursor.com/docs/agent/hooks)
 * - codex, copilot: the git top level (https://learn.chatgpt.com/docs/hooks,
 *   https://docs.github.com/en/copilot/reference/hooks-configuration)
 * - gemini: `$GEMINI_PROJECT_DIR`, which Gemini CLI sets and expands in hook commands
 *   (packages/core/src/hooks/hookRunner.ts, research R7 §6)
 * - opencode: unused (OpenCode hooks are JS plugins; palm installs none)
 */
export const PROJECT_DIR: Readonly<Record<TargetId, string>> = {
  claude: '$CLAUDE_PROJECT_DIR',
  codex: GIT_TOP_LEVEL,
  copilot: GIT_TOP_LEVEL,
  cursor: '$CURSOR_PROJECT_DIR',
  gemini: '$GEMINI_PROJECT_DIR',
  opencode: GIT_TOP_LEVEL,
};

/**
 * What the plugin-root tokens become (see the module comment): the absolute root at global
 * scope, or for a root inside the project, the harness's project directory plus the root's
 * project-relative path, so no absolute path reaches a committed config.
 */
function pluginRootReplacement(target: TargetId, pluginRootAbs: string, paths: ScopePaths): string {
  if (paths.scope !== 'project' || !isWithin(pluginRootAbs, paths.root)) return pluginRootAbs;
  const rel = paths.lockForm(pluginRootAbs);
  return rel === '' ? PROJECT_DIR[target] : `${PROJECT_DIR[target]}/${rel}`;
}

/**
 * The variable a harness sets to the plugin root when it runs a plugin's hooks natively.
 * Gemini CLI sets no `CLAUDE_PLUGIN_ROOT` but exports `CLAUDE_PROJECT_DIR` "for compatibility"
 * (hookRunner.ts), and the hooks palm converts for it come from Claude plugins, so their
 * scripts get the variable they were written for.
 */
const PLUGIN_ROOT_VAR: Partial<Record<TargetId, string>> = {
  claude: 'CLAUDE_PLUGIN_ROOT',
  codex: 'CLAUDE_PLUGIN_ROOT',
  cursor: 'CURSOR_PLUGIN_ROOT',
  gemini: 'CLAUDE_PLUGIN_ROOT',
};

function substitutePluginRoot(command: string, replacement: string): string {
  return command.replace(PLUGIN_ROOT_TOKENS, () => replacement);
}

/**
 * A command that referenced the plugin root, with the root substituted and — for harnesses
 * that would have set it when running the plugin natively — the variable exported for the
 * script too (`CLAUDE_PLUGIN_ROOT="…" cmd` for claude/codex, `CURSOR_PLUGIN_ROOT="…"` for
 * cursor). Scripts such as superpowers' `session-start` read it to find sibling files and to
 * pick the output format the harness understands. PowerShell commands only get the substitution.
 */
function rootedCommand(
  command: string,
  replacement: string,
  target: TargetId,
  shell?: unknown,
): string {
  if (!new RegExp(PLUGIN_ROOT_TOKENS.source).test(command)) return command;
  const substituted = substitutePluginRoot(command, replacement);
  const variable = PLUGIN_ROOT_VAR[target];
  if (!variable || (typeof shell === 'string' && shell.toLowerCase() === 'powershell'))
    return substituted;
  return `${variable}="${replacement.replace(/(["\\`])/g, '\\$1')}" ${substituted}`;
}

/** Extract the `{ event: entries[] }` map from a hooks file (wrapped `{hooks:{...}}` or flat). */
function eventMap(raw: unknown): Record<string, unknown[]> {
  if (isRecord(raw) && isRecord(raw.hooks)) {
    return Object.fromEntries(
      Object.entries(raw.hooks).filter(([, v]) => Array.isArray(v)),
    ) as Record<string, unknown[]>;
  }
  if (isRecord(raw)) {
    const entries = Object.entries(raw).filter(
      ([k, v]) => Array.isArray(v) && !['version', 'description', 'disableAllHooks'].includes(k),
    );
    return Object.fromEntries(entries) as Record<string, unknown[]>;
  }
  return {};
}

interface CanonHook {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

function isGrouped(entries: unknown[]): boolean {
  return entries.some((e) => isRecord(e) && Array.isArray(e.hooks));
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

interface CanonSource {
  srcEvent: string;
  event: string;
  dialect: HookSet['dialect'];
}

/** Canonical hooks of one `{ matcher?, hooks: [...] }` group (Claude/Gemini shape). */
function fromGroup(group: unknown, src: CanonSource, out: CanonHook[], dropped: string[]): void {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return;
  const matcher = str(group.matcher);
  for (const h of group.hooks) {
    if (!isRecord(h)) continue;
    const type = str(h.type) ?? 'command';
    const command = str(h.command);
    if (type !== 'command' || !command) {
      dropped.push(`${src.srcEvent}: ${type} hook not convertible`);
      continue;
    }
    let timeout = num(h.timeout);
    if (timeout !== undefined && src.dialect === 'gemini') timeout = Math.ceil(timeout / 1000); // Gemini: ms
    out.push({ event: src.event, matcher, command, timeout });
  }
}

/** The canonical hook of one flat entry (Cursor/Copilot shape). */
function fromFlat(h: unknown, src: CanonSource, out: CanonHook[], dropped: string[]): void {
  if (!isRecord(h)) return;
  const type = str(h.type) ?? 'command';
  const command = str(h.bash) ?? str(h.command);
  if (type !== 'command' || !command) {
    const what = type === 'command' ? 'hook without a bash/command' : `${type} hook`;
    dropped.push(`${src.srcEvent}: ${what} not convertible`);
    return;
  }
  if (h.cwd !== undefined || h.env !== undefined)
    dropped.push(`${src.srcEvent}: cwd/env of "${command}"`);
  out.push({
    event: src.event,
    matcher: str(h.matcher),
    command,
    timeout: num(h.timeoutSec) ?? num(h.timeout),
  });
}

/** `h` with its tool-event matcher moved from one dialect's tool names to another's. */
function withMatcher(h: CanonHook, from: ToolDialect, to: ToolDialect): CanonHook {
  if (h.matcher === undefined || !TOOL_EVENTS.has(h.event)) return h;
  return { ...h, matcher: hookMatcher(h.matcher, from, to) };
}

/** Flatten any dialect into canonical command hooks (tool matchers in Claude's names). */
function toCanonical(hooks: HookSet, dropped: string[]): CanonHook[] {
  const out: CanonHook[] = [];
  for (const [srcEvent, entries] of Object.entries(eventMap(hooks.raw))) {
    const event = canonicalEvent(srcEvent, hooks.dialect);
    if (!event) {
      dropped.push(`${srcEvent}: no equivalent event`);
      continue;
    }
    const src = { srcEvent, event, dialect: hooks.dialect };
    const convert = isGrouped(entries) ? fromGroup : fromFlat;
    for (const entry of entries) convert(entry, src, out, dropped);
  }
  const from = sourceFamily(hooks) ?? 'claude';
  return out.map((h) => withMatcher(h, from, 'claude'));
}

function sourceFamily(hooks: HookSet): Family | undefined {
  return hooks.dialect === 'unknown' ? undefined : hooks.dialect;
}

/** Deep-copy entries, substituting the plugin root in every command-like string (see rootedCommand). */
function substituteEntry(entry: unknown, replacement: string, target: TargetId): unknown {
  if (typeof entry === 'string') return substitutePluginRoot(entry, replacement);
  if (Array.isArray(entry)) return entry.map((e) => substituteEntry(e, replacement, target));
  if (isRecord(entry)) {
    return Object.fromEntries(
      Object.entries(entry).map(([k, v]) => {
        if (k === 'command' && typeof v === 'string')
          return [k, rootedCommand(v, replacement, target, entry.shell)];
        return [
          k,
          ['command', 'bash', 'powershell', 'hooks'].includes(k)
            ? substituteEntry(v, replacement, target)
            : v,
        ];
      }),
    );
  }
  return entry;
}

function wrap(target: TargetId, events: Record<string, unknown[]>): unknown {
  const fam = familyOf(target);
  return fam === 'claude' || fam === 'gemini' ? { hooks: events } : { version: 1, hooks: events };
}

/** Target event for a same-family source event; unmapped events are native to the family. */
function sameFamilyEvent(srcEvent: string, hooks: HookSet, target: TargetId): string | undefined {
  const canonical = canonicalEvent(srcEvent, hooks.dialect);
  if (canonical) return targetEvent(canonical, target);
  // Events palm has no mapping for are native to this family: keep them (Codex: drop, unknown to it).
  return target === 'codex' ? undefined : srcEvent;
}

/** Same family: keep entries verbatim (extra fields such as statusMessage survive). */
function convertSameFamily(
  hooks: HookSet,
  target: TargetId,
  replacement: string,
  dropped: string[],
): Record<string, unknown[]> {
  const events: Record<string, unknown[]> = {};
  for (const [srcEvent, entries] of Object.entries(eventMap(hooks.raw))) {
    const out = sameFamilyEvent(srcEvent, hooks, target);
    if (!out) {
      dropped.push(`${srcEvent}: not supported by ${target}`);
      continue;
    }
    events[out] = [
      ...(events[out] ?? []),
      ...(substituteEntry(entries, replacement, target) as unknown[]),
    ];
  }
  return events;
}

/** Append `h` to the `{ matcher?, hooks: [...] }` group of its matcher (Claude/Gemini shape). */
function pushGrouped(list: unknown[], h: CanonHook, command: string): void {
  const item = {
    type: 'command',
    command,
    ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
  };
  const group = list.find((g) => isRecord(g) && g.matcher === h.matcher) as
    | { hooks: unknown[] }
    | undefined;
  if (group) group.hooks.push(item);
  else list.push({ ...(h.matcher !== undefined ? { matcher: h.matcher } : {}), hooks: [item] });
}

/** Append canonical hook `h` (command already rooted) to `list` in the target family's shape. */
function pushHook(list: unknown[], fam: Family, h: CanonHook, command: string): void {
  const matcher = h.matcher !== undefined ? { matcher: h.matcher } : {};
  if (fam === 'cursor') {
    list.push({ command, ...matcher, ...(h.timeout !== undefined ? { timeout: h.timeout } : {}) });
    return;
  }
  if (fam === 'copilot') {
    const timeout = h.timeout !== undefined ? { timeoutSec: h.timeout } : {};
    list.push({ type: 'command', bash: command, ...timeout, ...matcher });
    return;
  }
  if (fam === 'gemini') {
    // Gemini timeouts are milliseconds (R7 §6).
    const timeout = h.timeout !== undefined ? h.timeout * 1000 : undefined;
    pushGrouped(list, { ...h, timeout }, command);
    return;
  }
  pushGrouped(list, h, command);
}

/** Other families: through the canonical form; only command hooks survive. */
function convertViaCanonical(
  hooks: HookSet,
  target: TargetId,
  replacement: string,
  dropped: string[],
): Record<string, unknown[]> {
  const fam = familyOf(target);
  const events: Record<string, unknown[]> = {};
  for (const h of toCanonical(hooks, dropped)) {
    const ev = targetEvent(h.event, target);
    if (!ev) {
      dropped.push(`${h.event}: not supported by ${target}`);
      continue;
    }
    const command =
      fam === 'copilot'
        ? substitutePluginRoot(h.command, replacement)
        : rootedCommand(h.command, replacement, target);
    const list = events[ev] ?? [];
    events[ev] = list;
    pushHook(list, fam, withMatcher(h, 'claude', fam), command);
  }
  return events;
}

/**
 * `hooks` in `target`'s dialect, with plugin-root tokens pointing at `pluginRootAbs` (the
 * hook's asset dir in `paths`).
 */
export function convertHooks(
  hooks: HookSet,
  target: TargetId,
  pluginRootAbs: string,
  paths: ScopePaths,
): { hooks: unknown; dropped: string[] } {
  const dropped: string[] = [];
  const replacement = pluginRootReplacement(target, pluginRootAbs, paths);
  const convert =
    sourceFamily(hooks) === familyOf(target) ? convertSameFamily : convertViaCanonical;
  const events = convert(hooks, target, replacement, dropped);
  return { hooks: wrap(target, events), dropped };
}
