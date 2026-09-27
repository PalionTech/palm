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
 * claude at project scope where they become `$CLAUDE_PROJECT_DIR/.palm/hooks/<basename(pluginRootAbs)>`
 * so the committed settings.json stays portable.
 *
 * Same-family conversions (claude→claude, claude→codex, cursor→cursor,
 * copilot→copilot) keep entries verbatim apart from the substitution; other
 * conversions go through a canonical `{ event, matcher, command, timeout }` form and
 * only `type: "command"` hooks survive. Events without an equivalent are reported
 * in `dropped`.
 */
import path from 'node:path';
import type { HookSet, Scope, TargetId } from '../core/types.js';
import { isPlainObject } from './deep-equal.js';

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
  { claude: 'UserPromptSubmit', cursor: 'beforeSubmitPrompt', copilot: 'userPromptSubmitted', codex: true },
  { claude: 'PreToolUse', cursor: 'preToolUse', copilot: 'preToolUse', codex: true },
  { claude: 'PostToolUse', cursor: 'postToolUse', copilot: 'postToolUse', codex: true },
  { claude: 'PostToolUseFailure', cursor: 'postToolUseFailure', copilot: 'postToolUseFailure', codex: false },
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

const ROOT_TOKENS = /\$\{(?:CLAUDE_PLUGIN_ROOT|CURSOR_PLUGIN_ROOT|PLUGIN_ROOT)\}|\$CLAUDE_PLUGIN_ROOT\b/g;

export function pluginRootReplacement(target: TargetId, pluginRootAbs: string, scope: Scope): string {
  if (target === 'claude' && scope === 'project') return `$CLAUDE_PROJECT_DIR/.palm/hooks/${path.basename(pluginRootAbs)}`;
  return pluginRootAbs;
}

export function substitutePluginRoot(command: string, replacement: string): string {
  return command.replace(ROOT_TOKENS, () => replacement);
}

/** True when any command string in the raw hooks references the plugin root. */
export function referencesPluginRoot(raw: unknown): boolean {
  return JSON.stringify(raw ?? null).match(ROOT_TOKENS) !== null;
}

/** Extract the `{ event: entries[] }` map from a hooks file (wrapped `{hooks:{...}}` or flat). */
export function eventMap(raw: unknown): Record<string, unknown[]> {
  if (isPlainObject(raw) && isPlainObject(raw.hooks)) {
    return Object.fromEntries(Object.entries(raw.hooks).filter(([, v]) => Array.isArray(v))) as Record<string, unknown[]>;
  }
  if (isPlainObject(raw)) {
    const entries = Object.entries(raw).filter(([k, v]) => Array.isArray(v) && !['version', 'description', 'disableAllHooks'].includes(k));
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
  return entries.some((e) => isPlainObject(e) && Array.isArray(e.hooks));
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
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
    if (isGrouped(entries)) {
      for (const group of entries) {
        if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
        const matcher = str(group.matcher);
        for (const h of group.hooks) {
          if (!isPlainObject(h)) continue;
          const type = str(h.type) ?? 'command';
          const command = str(h.command);
          if (type !== 'command' || !command) {
            dropped.push(`${srcEvent}: ${type} hook not convertible`);
            continue;
          }
          let timeout = num(h.timeout);
          if (timeout !== undefined && hooks.dialect === 'gemini') timeout = Math.ceil(timeout / 1000); // Gemini: ms
          out.push({ event, matcher, command, timeout });
        }
      }
    } else {
      for (const h of entries) {
        if (!isPlainObject(h)) continue;
        const type = str(h.type) ?? 'command';
        const command = str(h.bash) ?? str(h.command);
        if (type !== 'command' || !command) {
          dropped.push(`${srcEvent}: ${type === 'command' ? 'hook without a bash/command' : `${type} hook`} not convertible`);
          continue;
        }
        if (h.cwd !== undefined || h.env !== undefined) dropped.push(`${srcEvent}: cwd/env of "${command}"`);
        out.push({ event, matcher: str(h.matcher), command, timeout: num(h.timeoutSec) ?? num(h.timeout) });
      }
    }
  }
  return out;
}

function sourceFamily(hooks: HookSet): Family | undefined {
  if (hooks.dialect === 'claude' || hooks.dialect === 'cursor' || hooks.dialect === 'copilot') return hooks.dialect;
  return undefined;
}

/** Deep-copy entries, substituting the plugin root in every command-like string. */
function substituteEntry(entry: unknown, replacement: string): unknown {
  if (typeof entry === 'string') return substitutePluginRoot(entry, replacement);
  if (Array.isArray(entry)) return entry.map((e) => substituteEntry(e, replacement));
  if (isPlainObject(entry)) {
    return Object.fromEntries(
      Object.entries(entry).map(([k, v]) => [k, ['command', 'bash', 'powershell', 'hooks'].includes(k) ? substituteEntry(v, replacement) : v]),
    );
  }
  return entry;
}

function wrap(target: TargetId, events: Record<string, unknown[]>): unknown {
  return familyOf(target) === 'claude' ? { hooks: events } : { version: 1, hooks: events };
}

export function convertHooks(hooks: HookSet, target: TargetId, pluginRootAbs: string, scope: Scope): { hooks: unknown; dropped: string[] } {
  const dropped: string[] = [];
  const replacement = pluginRootReplacement(target, pluginRootAbs, scope);
  const fam = familyOf(target);

  // Same family: keep entries verbatim (extra fields such as statusMessage survive).
  if (sourceFamily(hooks) === fam) {
    const events: Record<string, unknown[]> = {};
    for (const [srcEvent, entries] of Object.entries(eventMap(hooks.raw))) {
      const canonical = canonicalEvent(srcEvent, hooks.dialect);
      // Events palm has no mapping for are native to this family: keep them (Codex: drop, unknown to it).
      const out = canonical ? targetEvent(canonical, target) : target === 'codex' ? undefined : srcEvent;
      if (!out) {
        dropped.push(`${srcEvent}: not supported by ${target}`);
        continue;
      }
      events[out] = [...(events[out] ?? []), ...(substituteEntry(entries, replacement) as unknown[])];
    }
    return { hooks: wrap(target, events), dropped };
  }

  const canon = toCanonical(hooks, dropped);
  const events: Record<string, unknown[]> = {};
  for (const h of canon) {
    const ev = targetEvent(h.event, target);
    if (!ev) {
      dropped.push(`${h.event}: not supported by ${target}`);
      continue;
    }
    const command = substitutePluginRoot(h.command, replacement);
    const list = (events[ev] ??= []);
    if (fam === 'claude') {
      const item = { type: 'command', command, ...(h.timeout !== undefined ? { timeout: h.timeout } : {}) };
      const group = list.find((g) => isPlainObject(g) && g.matcher === h.matcher) as { hooks: unknown[] } | undefined;
      if (group) group.hooks.push(item);
      else list.push({ ...(h.matcher !== undefined ? { matcher: h.matcher } : {}), hooks: [item] });
    } else if (fam === 'cursor') {
      list.push({ command, ...(h.matcher !== undefined ? { matcher: h.matcher } : {}), ...(h.timeout !== undefined ? { timeout: h.timeout } : {}) });
    } else {
      list.push({
        type: 'command',
        bash: command,
        ...(h.timeout !== undefined ? { timeoutSec: h.timeout } : {}),
        ...(h.matcher !== undefined ? { matcher: h.matcher } : {}),
      });
    }
  }
  return { hooks: wrap(target, events), dropped };
}
