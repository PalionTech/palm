/**
 * Convert a HookSet between harness dialects.
 *
 * Output (`hooks`) is the file-shaped object for the target:
 * - claude / codex: `{ hooks: { <PascalEvent>: [{ matcher?, hooks: [{ type: "command", command, timeout? }] }] } }`
 * - cursor:         `{ version: 1, hooks: { <camelEvent>: [{ command, matcher?, timeout? }] } }`
 * - copilot:        `{ version: 1, hooks: { <camelEvent>: [{ type: "command", bash, timeoutSec?, matcher? }] } }`
 *
 * `${CLAUDE_PLUGIN_ROOT}`, `${CURSOR_PLUGIN_ROOT}`, `${PLUGIN_ROOT}` (and the unbraced
 * `$CLAUDE_PLUGIN_ROOT`) in command strings become `pluginRootAbs`, except for
 * claude at project scope where they become `$CLAUDE_PROJECT_DIR/<pluginRootAbs relative to
 * the project>` so the committed settings.json stays portable.
 *
 * Same-family conversions (claude→claude, claude→codex, cursor→cursor,
 * copilot→copilot) keep entries verbatim apart from the substitution; other
 * conversions go through a canonical `{ event, matcher, command, timeout }` form and
 * only `type: "command"` hooks survive. Events without an equivalent are reported
 * in `dropped`.
 */
import type { HookSet, TargetId } from '../core/types.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { isRecord } from '../lib/object.js';

interface EventInfo {
  claude: string;
  cursor?: string;
  copilot?: string;
  codex: boolean;
}

/** Canonical (Claude) event names and their equivalents. */
export const HOOK_EVENTS: readonly EventInfo[] = [
  { claude: 'SessionStart', cursor: 'sessionStart', copilot: 'sessionStart', codex: true },
  { claude: 'SessionEnd', cursor: 'sessionEnd', copilot: 'sessionEnd', codex: true },
  {
    claude: 'UserPromptSubmit',
    cursor: 'beforeSubmitPrompt',
    copilot: 'userPromptSubmitted',
    codex: true,
  },
  { claude: 'PreToolUse', cursor: 'preToolUse', copilot: 'preToolUse', codex: true },
  { claude: 'PostToolUse', cursor: 'postToolUse', copilot: 'postToolUse', codex: true },
  {
    claude: 'PostToolUseFailure',
    cursor: 'postToolUseFailure',
    copilot: 'postToolUseFailure',
    codex: false,
  },
  { claude: 'Stop', cursor: 'stop', copilot: 'agentStop', codex: true },
  { claude: 'SubagentStart', cursor: 'subagentStart', copilot: 'subagentStart', codex: true },
  { claude: 'SubagentStop', cursor: 'subagentStop', copilot: 'subagentStop', codex: true },
  { claude: 'PreCompact', cursor: 'preCompact', copilot: 'preCompact', codex: true },
  { claude: 'PostCompact', codex: true },
  { claude: 'PermissionRequest', copilot: 'permissionRequest', codex: true },
  { claude: 'Notification', copilot: 'notification', codex: false },
];

/** Gemini CLI event names → canonical. */
const GEMINI_EVENTS: Record<string, string> = {
  BeforeTool: 'PreToolUse',
  AfterTool: 'PostToolUse',
  BeforeAgent: 'UserPromptSubmit',
  AfterAgent: 'Stop',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  PreCompress: 'PreCompact',
  Notification: 'Notification',
};

type Family = 'claude' | 'cursor' | 'copilot';

function familyOf(target: TargetId): Family {
  return target === 'codex' ? 'claude' : target;
}

/** Map a source event name (any dialect) to its canonical Claude name. */
export function canonicalEvent(name: string, dialect: HookSet['dialect']): string | undefined {
  if (dialect === 'gemini' && GEMINI_EVENTS[name]) return GEMINI_EVENTS[name];
  const hit = HOOK_EVENTS.find((e) => e.claude === name || e.cursor === name || e.copilot === name);
  if (hit) return hit.claude;
  // Copilot also accepts PascalCase variants and a few aliases.
  if (name === 'userPromptSubmit') return 'UserPromptSubmit';
  return undefined;
}

/** Target event name for a canonical event; undefined when unsupported. */
export function targetEvent(canonical: string, target: TargetId): string | undefined {
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
  }
}

const ROOT_TOKENS =
  /\$\{(?:CLAUDE_PLUGIN_ROOT|CURSOR_PLUGIN_ROOT|PLUGIN_ROOT)\}|\$CLAUDE_PLUGIN_ROOT\b/g;

/** What the plugin-root tokens become (see the module comment). */
export function pluginRootReplacement(
  target: TargetId,
  pluginRootAbs: string,
  paths: ScopePaths,
): string {
  if (target === 'claude' && paths.scope === 'project')
    return `$CLAUDE_PROJECT_DIR/${paths.lockForm(pluginRootAbs)}`;
  return pluginRootAbs;
}

/** The variable a harness sets to the plugin root when it runs a plugin's hooks natively. */
const PLUGIN_ROOT_VAR: Partial<Record<TargetId, string>> = {
  claude: 'CLAUDE_PLUGIN_ROOT',
  codex: 'CLAUDE_PLUGIN_ROOT',
  cursor: 'CURSOR_PLUGIN_ROOT',
};

export function substitutePluginRoot(command: string, replacement: string): string {
  return command.replace(ROOT_TOKENS, () => replacement);
}

/**
 * A command that referenced the plugin root, with the root substituted and — for harnesses
 * that would have set it when running the plugin natively — the variable exported for the
 * script too (`CLAUDE_PLUGIN_ROOT="…" cmd` for claude/codex, `CURSOR_PLUGIN_ROOT="…"` for
 * cursor). Scripts such as superpowers' `session-start` read it to find sibling files and to
 * pick the output format the harness understands. PowerShell commands only get the substitution.
 */
export function rootedCommand(
  command: string,
  replacement: string,
  target: TargetId,
  shell?: unknown,
): string {
  if (!new RegExp(ROOT_TOKENS.source).test(command)) return command;
  const substituted = substitutePluginRoot(command, replacement);
  const variable = PLUGIN_ROOT_VAR[target];
  if (!variable || (typeof shell === 'string' && shell.toLowerCase() === 'powershell'))
    return substituted;
  return `${variable}="${replacement.replace(/(["\\`])/g, '\\$1')}" ${substituted}`;
}

/** True when any command string in the raw hooks references the plugin root. */
export function referencesPluginRoot(raw: unknown): boolean {
  return JSON.stringify(raw ?? null).match(ROOT_TOKENS) !== null;
}

/** Extract the `{ event: entries[] }` map from a hooks file (wrapped `{hooks:{...}}` or flat). */
export function eventMap(raw: unknown): Record<string, unknown[]> {
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

/** Flatten any dialect into canonical command hooks. */
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
  return out;
}

function sourceFamily(hooks: HookSet): Family | undefined {
  if (hooks.dialect === 'claude' || hooks.dialect === 'cursor' || hooks.dialect === 'copilot')
    return hooks.dialect;
  return undefined;
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
  return familyOf(target) === 'claude' ? { hooks: events } : { version: 1, hooks: events };
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
  const item = {
    type: 'command',
    command,
    ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
  };
  const group = list.find((g) => isRecord(g) && g.matcher === h.matcher) as
    | { hooks: unknown[] }
    | undefined;
  if (group) group.hooks.push(item);
  else list.push({ ...matcher, hooks: [item] });
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
    pushHook(list, fam, h, command);
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
