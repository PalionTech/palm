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
 * Every command line goes through the injected `relocate` (relocate.ts): the harness runs the
 * rendered command, and `exec` lists each one with its canonical form, keyed by
 * `<event>//<matcher or ->` in Claude's event and tool names (a repeat gets `#2`, `#3`), so the
 * same command has the same id on every target.
 *
 * Same-family conversions (claude→claude, claude→codex, cursor→cursor, copilot→copilot,
 * gemini→gemini) keep entries verbatim apart from the commands; other conversions go through a
 * canonical `{ event, matcher, command, timeout }` form and only `type: "command"` hooks survive.
 * Events without an equivalent are reported in `dropped`. Tool-event matchers (regexes over tool
 * names) are translated both ways through Claude's names (tool-names.ts `hookMatcher`): a Gemini
 * `run_shell_command` or Cursor `Shell` matcher becomes `Bash` for Claude and Codex, Claude
 * `Edit|Write` becomes Cursor `Write`.
 */
import type { HookSet, Rendered, TargetId } from '../core/types.js';
import { isRecord } from '../lib/object.js';
import { hookMatcher, type ToolDialect } from './tool-names.js';

/** Relocates one command line (relocate.ts `relocateCommand`, bound to a target and asset root). */
export type Relocate = (
  command: string,
  opts?: { powershell?: boolean },
) => { canonical: string; rendered: string };

type ExecLine = Rendered['exec'][number];

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

/** Keys of a hook entry that hold a command line. */
const COMMAND_KEYS = ['command', 'bash', 'powershell'] as const;

type Family = ToolDialect;

/** The dialect a target's hooks file speaks (opencode has none: its hooks are skipped). */
function familyOf(target: TargetId): Family {
  return target === 'codex' || target === 'opencode' ? 'claude' : target;
}

function sourceFamily(hooks: HookSet): Family | undefined {
  return hooks.dialect === 'unknown' ? undefined : hooks.dialect;
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

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function isPowershell(h: Record<string, unknown>): boolean {
  return typeof h.shell === 'string' && h.shell.toLowerCase() === 'powershell';
}

/** One conversion: the relocation, and what it collects. */
class Conversion {
  readonly dropped: string[] = [];
  readonly exec: ExecLine[] = [];
  private readonly seen = new Map<string, number>();

  constructor(
    readonly hooks: HookSet,
    readonly target: TargetId,
    private readonly relocate: Relocate,
  ) {}

  get from(): Family {
    return sourceFamily(this.hooks) ?? 'claude';
  }

  /** A matcher in Claude's tool names (tool events only), for exec ids. */
  canonicalMatcher(matcher: string | undefined, event: string): string | undefined {
    if (matcher === undefined || !TOOL_EVENTS.has(event)) return matcher;
    return hookMatcher(matcher, this.from, 'claude');
  }

  /** Relocate one command line and list it; returns the rendered command. */
  run(command: string, at: { event: string; matcher?: string }, powershell: boolean): string {
    const r = this.relocate(command, powershell ? { powershell: true } : undefined);
    const base = `${at.event}//${at.matcher ?? '-'}`;
    const n = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, n);
    this.exec.push({
      id: n === 1 ? base : `${base}#${n}`,
      canonical: r.canonical,
      command: r.rendered,
      file: '',
      event: at.event,
      ...(at.matcher !== undefined ? { matcher: at.matcher } : {}),
    });
    return r.rendered;
  }
}

interface CanonHook {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
  powershell?: boolean;
}

function isGrouped(entries: unknown[]): boolean {
  return entries.some((e) => isRecord(e) && Array.isArray(e.hooks));
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
    out.push({ event: src.event, matcher, command, timeout, powershell: isPowershell(h) });
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
function toCanonical(cx: Conversion): CanonHook[] {
  const out: CanonHook[] = [];
  for (const [srcEvent, entries] of Object.entries(eventMap(cx.hooks.raw))) {
    const event = canonicalEvent(srcEvent, cx.hooks.dialect);
    if (!event) {
      cx.dropped.push(`${srcEvent}: no equivalent event`);
      continue;
    }
    const src = { srcEvent, event, dialect: cx.hooks.dialect };
    const convert = isGrouped(entries) ? fromGroup : fromFlat;
    for (const entry of entries) convert(entry, src, out, cx.dropped);
  }
  return out.map((h) => withMatcher(h, cx.from, 'claude'));
}

/** A hook entry with each command line relocated (prompt hooks and other fields untouched). */
function relocateFields(
  h: unknown,
  at: { event: string; matcher?: string },
  cx: Conversion,
): unknown {
  if (!isRecord(h) || (str(h.type) ?? 'command') !== 'command') return h;
  const out: Record<string, unknown> = { ...h };
  for (const key of COMMAND_KEYS) {
    const v = str(h[key]);
    if (v) out[key] = cx.run(v, at, key === 'powershell' || isPowershell(h));
  }
  return out;
}

/** A same-family entry (a `{ matcher?, hooks }` group or a flat entry) with its commands relocated. */
function relocateEntry(entry: unknown, srcEvent: string, cx: Conversion): unknown {
  if (!isRecord(entry)) return entry;
  const event = canonicalEvent(srcEvent, cx.hooks.dialect) ?? srcEvent;
  const at = { event, matcher: cx.canonicalMatcher(str(entry.matcher), event) };
  if (!Array.isArray(entry.hooks)) return relocateFields(entry, at, cx);
  return { ...entry, hooks: entry.hooks.map((h) => relocateFields(h, at, cx)) };
}

function wrap(target: TargetId, events: Record<string, unknown[]>): unknown {
  const fam = familyOf(target);
  return fam === 'claude' || fam === 'gemini' ? { hooks: events } : { version: 1, hooks: events };
}

/** Target event for a same-family source event; unmapped events are native to the family. */
function sameFamilyEvent(srcEvent: string, cx: Conversion): string | undefined {
  const canonical = canonicalEvent(srcEvent, cx.hooks.dialect);
  if (canonical) return targetEvent(canonical, cx.target);
  // Events palm has no mapping for are native to this family: keep them (Codex: drop, unknown to it).
  return cx.target === 'codex' ? undefined : srcEvent;
}

/** Same family: keep entries verbatim (extra fields such as statusMessage survive). */
function convertSameFamily(cx: Conversion): Record<string, unknown[]> {
  const events: Record<string, unknown[]> = {};
  for (const [srcEvent, entries] of Object.entries(eventMap(cx.hooks.raw))) {
    const out = sameFamilyEvent(srcEvent, cx);
    if (!out) {
      cx.dropped.push(`${srcEvent}: not supported by ${cx.target}`);
      continue;
    }
    events[out] = [...(events[out] ?? []), ...entries.map((e) => relocateEntry(e, srcEvent, cx))];
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

/** Append canonical hook `h` (command already relocated) to `list` in the target family's shape. */
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
function convertViaCanonical(cx: Conversion): Record<string, unknown[]> {
  const fam = familyOf(cx.target);
  const events: Record<string, unknown[]> = {};
  for (const h of toCanonical(cx)) {
    const ev = targetEvent(h.event, cx.target);
    if (!ev) {
      cx.dropped.push(`${h.event}: not supported by ${cx.target}`);
      continue;
    }
    const command = cx.run(h.command, h, h.powershell === true);
    const list = events[ev] ?? [];
    events[ev] = list;
    pushHook(list, fam, withMatcher(h, 'claude', fam), command);
  }
  return events;
}

/**
 * `hooks` in `target`'s dialect, every command line relocated through `relocate`, with the exec
 * lines it runs (`file` left empty: the caller knows where the entries land).
 */
export function convertHooks(
  hooks: HookSet,
  target: TargetId,
  relocate: Relocate,
): { hooks: unknown; exec: Rendered['exec']; dropped: string[] } {
  const cx = new Conversion(hooks, target, relocate);
  const convert =
    sourceFamily(hooks) === familyOf(target) ? convertSameFamily : convertViaCanonical;
  const events = convert(cx);
  return { hooks: wrap(target, events), exec: cx.exec, dropped: cx.dropped };
}
