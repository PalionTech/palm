/**
 * Convert a HookSet between harness dialects.
 *
 * Output (`hooks`) is the file-shaped object for the target:
 * - claude / codex: `{ hooks: { <PascalEvent>: [{ matcher?, hooks: [{ type: "command", command, timeout? }] }] } }`
 * - cursor:         `{ version: 1, hooks: { <camelEvent>: [{ command, matcher?, timeout? }] } }`
 * - copilot:        `{ version: 1, hooks: { <camelEvent>: [{ type: "command", bash, powershell?, cwd?, env?, timeoutSec?, matcher? }] } }`
 *                   (`powershell`: the source's own, or the bash line when it runs in both shells)
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
import { isRecord, withoutUndefined } from '../lib/object.js';
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

/**
 * What Codex reads in a hooks file it shares Claude's schema with (codex-rs/config
 * hook_config.rs `MatcherGroup`, `HookHandlerConfig`): other keys a Claude entry carries
 * (`shell`, `once`, `asyncRewake`) are left out with a note (ruling J); a handler Codex would run
 * differently (another type, an `if` filter, PowerShell) is skipped with a note.
 */
const CODEX_GROUP_KEYS: ReadonlySet<string> = new Set(['matcher', 'hooks']);
const CODEX_HANDLER_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  command: new Set([
    'type',
    'command',
    'commandWindows',
    'timeout',
    'async',
    'statusMessage',
    'additionalContextLimit',
  ]),
  mcp_tool: new Set(['type', 'server', 'tool', 'input', 'timeout', 'statusMessage']),
};

/** A matcher alternative with an argument (`Bash(git commit*)`), which Copilot cannot express. */
const MATCHER_ARGUMENT = /\(.*\)/;

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
  /** The event as the source names it (for notes). */
  srcEvent: string;
  matcher?: string;
  /** The POSIX shell command: Claude and Cursor `command`, Copilot `bash`. */
  command?: string;
  /** The PowerShell command: Copilot `powershell`, a Claude hook with `shell: powershell`. */
  powershell?: string;
  timeout?: number;
  /** Copilot's working directory and environment, kept for Copilot (ruling O11). */
  cwd?: string;
  env?: Record<string, unknown>;
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
    const shell = isPowershell(h) ? { powershell: command } : { command };
    out.push({ event: src.event, srcEvent: src.srcEvent, matcher, ...shell, timeout });
  }
}

/** The canonical hook of one flat entry (Cursor/Copilot shape). */
function fromFlat(h: unknown, src: CanonSource, out: CanonHook[], dropped: string[]): void {
  if (!isRecord(h)) return;
  const type = str(h.type) ?? 'command';
  const command = str(h.bash) ?? str(h.command);
  const powershell = str(h.powershell);
  if (type !== 'command' || !(command || powershell)) {
    const what = type === 'command' ? 'hook without a bash/command' : `${type} hook`;
    dropped.push(`${src.srcEvent}: ${what} not convertible`);
    return;
  }
  out.push({
    event: src.event,
    srcEvent: src.srcEvent,
    matcher: str(h.matcher),
    command,
    powershell,
    timeout: num(h.timeoutSec) ?? num(h.timeout),
    cwd: str(h.cwd),
    env: isRecord(h.env) ? h.env : undefined,
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

/** `obj` with only `allowed` keys; each other key is reported once per event. */
function pickKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  report: (key: string) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (allowed.has(k)) out[k] = v;
    else report(k);
  }
  return out;
}

/**
 * A Claude group as Codex reads it: documented keys only, handlers of a type Codex runs only
 * (ruling J). Undefined when no handler is left.
 */
function codexGroup(group: unknown, event: string, cx: Conversion): unknown {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return group;
  const noted = new Set<string>();
  const report = (key: string): void => {
    if (!noted.has(key)) cx.dropped.push(`${event}: ${key} (not a Codex hook key)`);
    noted.add(key);
  };
  const hooks: unknown[] = [];
  for (const h of group.hooks) {
    const skip = codexSkip(h);
    if (skip) cx.dropped.push(`${event}: ${skip}`);
    else if (isRecord(h))
      hooks.push(pickKeys(h, CODEX_HANDLER_KEYS[str(h.type) ?? 'command'] ?? new Set(), report));
  }
  if (hooks.length === 0) return undefined;
  return { ...pickKeys(group, CODEX_GROUP_KEYS, report), hooks };
}

/**
 * Why Codex cannot run a Claude handler as meant, or undefined: a type Codex does not run, an
 * `if` filter it would ignore (the hook would fire on every call), or a PowerShell command.
 */
function codexSkip(h: unknown): string | undefined {
  if (!isRecord(h)) return 'hook entry is not an object';
  const type = str(h.type) ?? 'command';
  if (!CODEX_HANDLER_KEYS[type]) return `${type} hook (Codex runs command and mcp_tool hooks)`;
  if (h.if !== undefined) return `hook with if: ${String(h.if)} (Codex has no if filter)`;
  return isPowershell(h) ? 'PowerShell hook (Codex runs hooks with sh)' : undefined;
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
    const kept =
      cx.target === 'codex'
        ? entries.map((e) => codexGroup(e, out, cx)).filter((e) => e !== undefined)
        : entries;
    events[out] = [...(events[out] ?? []), ...kept.map((e) => relocateEntry(e, srcEvent, cx))];
  }
  return events;
}

/**
 * True when Copilot cannot express the hook's matcher: an alternative narrows its tool with an
 * argument (`Bash(git commit*)`), which Copilot would match as a tool name and never fire (C6).
 */
function copilotCannotMatch(h: CanonHook): boolean {
  return h.matcher?.split('|').some((alt) => MATCHER_ARGUMENT.test(alt)) ?? false;
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

/** Characters whose meaning differs between sh and PowerShell (or that only one of them has). */
const SHELL_SYNTAX = /[$`;&|<>(){}\\*?~!#]/;
/** Programs that are a POSIX shell or run one, and shell scripts. */
const SHELL_PROGRAM =
  /^(?:sh|bash|zsh|fish|dash|ksh|source|\.|exec|env|sudo)$|\.(?:sh|bash|zsh|fish)$/i;

/**
 * True when `command` runs a program the same way under sh and PowerShell: a program on the
 * PATH (no `./`, `/` or `~` path, no shell script, no `VAR=value` prefix) with plain arguments
 * and no shell syntax (`go run .agents/hooks/main.go`, `npx prettier --write`). Copilot then gets
 * the same line as its `powershell` command, so the hook runs on Windows too (ruling O11).
 */
function runsInBothShells(command: string): boolean {
  if (SHELL_SYNTAX.test(command)) return false;
  const program = command.trim().split(/\s+/)[0] ?? '';
  if (program === '' || /^[./~]/.test(program) || program.includes('=')) return false;
  return !SHELL_PROGRAM.test(program);
}

/**
 * A Copilot entry: `bash` and `powershell` (the source's own, or the bash line when it runs in
 * both shells), `cwd` and `env` as the source has them, `timeoutSec` (ruling O11). `h` keeps
 * Claude's tool names (the exec ids); `matcher` is in Copilot's.
 */
function copilotItem(h: CanonHook, matcher: string | undefined, cx: Conversion) {
  const bash = h.command !== undefined ? cx.run(h.command, h, false) : undefined;
  const own = h.powershell !== undefined ? cx.run(h.powershell, h, true) : undefined;
  const powershell = own ?? (bash !== undefined && runsInBothShells(bash) ? bash : undefined);
  return withoutUndefined({
    type: 'command',
    bash,
    powershell,
    cwd: h.cwd,
    env: h.env,
    timeoutSec: h.timeout,
    matcher,
  });
}

/** Append canonical hook `h` (command already relocated) to `list` in the target family's shape. */
function pushHook(
  list: unknown[],
  fam: Exclude<Family, 'copilot'>,
  h: CanonHook,
  command: string,
): void {
  const matcher = h.matcher !== undefined ? { matcher: h.matcher } : {};
  if (fam === 'cursor') {
    list.push({ command, ...matcher, ...(h.timeout !== undefined ? { timeout: h.timeout } : {}) });
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

/**
 * The POSIX command a target other than Copilot runs for `h`, relocated; undefined (with a
 * note) for a PowerShell-only hook. Copilot's `cwd` and `env` are noted as dropped.
 */
function posixCommand(h: CanonHook, cx: Conversion): string | undefined {
  if (h.command === undefined) {
    cx.dropped.push(`${h.srcEvent}: PowerShell hook (${cx.target} runs hooks with sh)`);
    return undefined;
  }
  if (h.cwd !== undefined || h.env !== undefined)
    cx.dropped.push(`${h.srcEvent}: cwd/env of "${h.command}"`);
  return cx.run(h.command, h, false);
}

/** The target event for `h`, or undefined (with a note) when the target cannot run it. */
function eventFor(h: CanonHook, cx: Conversion): string | undefined {
  const ev = targetEvent(h.event, cx.target);
  if (!ev) {
    cx.dropped.push(`${h.event}: not supported by ${cx.target}`);
    return undefined;
  }
  if (cx.target === 'copilot' && copilotCannotMatch(h)) {
    cx.dropped.push(`${h.event}: matcher "${h.matcher}" has an argument copilot cannot match`);
    return undefined;
  }
  return ev;
}

/** Other families: through the canonical form; only command hooks survive. */
function convertViaCanonical(cx: Conversion): Record<string, unknown[]> {
  const fam = familyOf(cx.target);
  const events: Record<string, unknown[]> = {};
  for (const h of toCanonical(cx)) {
    const ev = eventFor(h, cx);
    if (!ev) continue;
    const list = events[ev] ?? [];
    const target = withMatcher(h, 'claude', fam);
    if (fam === 'copilot') list.push(copilotItem(h, target.matcher, cx));
    else {
      const command = posixCommand(h, cx);
      if (command === undefined) continue;
      pushHook(list, fam, target, command);
    }
    events[ev] = list;
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

/** The hook dialects the targets read (OpenCode reads none). */
export function hookDialectsOf(targets: readonly TargetId[]): Set<ToolDialect> {
  return new Set(targets.filter((t) => t !== 'opencode').map(familyOf));
}

function isKnownEvent(name: string): boolean {
  if (GEMINI_EVENTS[name]) return true;
  return HOOK_EVENTS.some((e) => e.claude === name || e.cursor === name || e.copilot === name);
}

/**
 * The dialect a hooks definition file is written in (`hooks/hooks.json` for Claude,
 * `hooks/hooks-cursor.json` for Cursor), or undefined when `json` is no hooks file: it needs
 * an event array under a name some harness uses.
 */
export function hooksFileDialect(json: unknown): ToolDialect | undefined {
  const events = Object.keys(eventMap(json)).filter(isKnownEvent);
  if (events.length === 0) return undefined;
  if (events.every((e) => /^[A-Z]/.test(e)))
    return events.some((e) => GEMINI_EVENTS[e] && GEMINI_EVENTS[e] !== e) ? 'gemini' : 'claude';
  const entries = events.flatMap((e) => eventMap(json)[e] ?? []).filter(isRecord);
  return entries.some((h) => 'bash' in h || 'powershell' in h || 'timeoutSec' in h)
    ? 'copilot'
    : 'cursor';
}
