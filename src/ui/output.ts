/**
 * The one output writer (DESIGN.md §9, "Output contract"). src/cli.ts creates it, commands
 * receive it and pass it on as `ctx.log`, so every line palm prints goes through here:
 *
 * - data (`out`, `table`) goes to stdout, or to stderr under `--json`;
 * - `json(value)` buffers the one JSON document `finish()` writes to stdout;
 * - status lines carry a symbol: `+` added, `-` removed, `~` updated, `=` unchanged,
 *   `x` error, `!` warning, `i` info;
 * - warnings are collected and printed once, under a `Warnings` heading, by `finish()`
 *   (and land in the JSON document as `warnings: []`).
 *
 * Colours come from picocolors, which honours `NO_COLOR` and `--no-color`.
 */
import pc from 'picocolors';
import type { InstallOutcome, InstallResult, Logger, Scope, TargetId } from '../core/types.js';

/** Anything with a `write(text)`: process.stdout, process.stderr, or a test buffer. */
export interface Sink {
  write(chunk: string): unknown;
}

export type Mark = 'added' | 'removed' | 'updated' | 'unchanged' | 'error' | 'warning' | 'info';

export const SYMBOLS: Readonly<Record<Mark, string>> = {
  added: '+',
  removed: '-',
  updated: '~',
  unchanged: '=',
  error: 'x',
  warning: '!',
  info: 'i',
};

const COLOURS: Readonly<Record<Mark, (s: string) => string>> = {
  added: pc.green,
  removed: pc.red,
  updated: pc.cyan,
  unchanged: pc.dim,
  error: pc.red,
  warning: pc.yellow,
  info: pc.blue,
};

export function symbol(mark: Mark): string {
  return COLOURS[mark](SYMBOLS[mark]);
}

export interface OutputOptions {
  json?: boolean;
  verbose?: boolean;
  stdout?: Sink;
  stderr?: Sink;
}

/** Logger plus the data channel. Everything a command prints goes through one of these. */
export interface Output extends Logger {
  readonly jsonMode: boolean;
  readonly verbose: boolean;
  /** Apply the parsed global flags (cli.ts calls this before each action runs). */
  configure(opts: { json?: boolean; verbose?: boolean }): void;
  /** One line of data (stdout; stderr under --json). */
  out(line?: string): void;
  table(rows: string[][], header?: string[]): void;
  /** The command's JSON document; written by finish(), with `warnings`. */
  json(value: unknown): void;
  mark(mark: Mark, msg: string): void;
  added(msg: string): void;
  removed(msg: string): void;
  updated(msg: string): void;
  unchanged(msg: string): void;
  /** `x message` and an optional dim hint line, on stderr. */
  error(msg: string, hint?: string): void;
  /** A dim follow-up line, e.g. the command to run next. */
  hint(msg: string): void;
  /** Warnings collected so far (deduplicated, in order). */
  warnings(): string[];
  /** Print the collected warnings (or the JSON document) and reset. */
  finish(): void;
}

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

function padVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

/** Shorten `text` to at most `max` visible characters, ending with an ellipsis when cut. */
export function truncate(text: string | undefined, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function renderRow(r: string[], widths: number[], style?: (s: string) => string): string {
  return widths
    .map((w, i) => {
      const cell = r[i] ?? '';
      const padded = i === widths.length - 1 ? cell : padVisible(cell, w);
      return style ? style(padded) : padded;
    })
    .join('  ')
    .trimEnd();
}

/** Render rows as padded columns (two-space gutter). ANSI colour codes do not count toward widths. */
export function formatTable(rows: string[][], header?: string[]): string {
  const clean = (r: string[]) => r.map((c) => (c ?? '').replace(/\r?\n/g, ' '));
  const body = rows.map(clean);
  const head = header ? clean(header) : undefined;
  const all = head ? [head, ...body] : body;
  const cols = all.reduce((n, r) => Math.max(n, r.length), 0);
  if (cols === 0) return '';
  const widths = Array.from({ length: cols }, (_, i) =>
    all.reduce((w, r) => Math.max(w, visibleWidth(r[i] ?? '')), 0),
  );
  const out: string[] = [];
  if (head) {
    out.push(renderRow(head, widths, pc.bold));
    out.push(pc.dim(widths.map((w) => '─'.repeat(Math.max(w, 1))).join('  ')));
  }
  for (const r of body) out.push(renderRow(r, widths));
  return out.join('\n');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The JSON document for `value`: arrays become `{ items }`, and every document carries
 * `warnings` (its own plus the collected ones, deduplicated).
 */
export function jsonEnvelope(value: unknown, warnings: string[]): Record<string, unknown> {
  let base: Record<string, unknown>;
  if (Array.isArray(value)) base = { items: value };
  else if (isRecord(value)) base = { ...value };
  else base = value === undefined ? {} : { value };
  const own = Array.isArray(base.warnings)
    ? base.warnings.filter((w): w is string => typeof w === 'string')
    : [];
  return { ...base, warnings: [...new Set([...own, ...warnings])] };
}

class Writer implements Output {
  jsonMode: boolean;
  verbose: boolean;
  private readonly stdout: Sink;
  private readonly stderr: Sink;
  private collected: string[] = [];
  private doc: { value: unknown } | undefined;

  constructor(opts: OutputOptions) {
    this.jsonMode = Boolean(opts.json);
    this.verbose = Boolean(opts.verbose);
    this.stdout = opts.stdout ?? process.stdout;
    this.stderr = opts.stderr ?? process.stderr;
  }

  configure(opts: { json?: boolean; verbose?: boolean }): void {
    if (opts.json !== undefined) this.jsonMode = opts.json;
    if (opts.verbose !== undefined) this.verbose = opts.verbose;
  }

  /** stdout for data and status lines; stderr under --json so stdout stays pure JSON. */
  private get data(): Sink {
    return this.jsonMode ? this.stderr : this.stdout;
  }

  out(line = ''): void {
    this.data.write(`${line}\n`);
  }

  table(rows: string[][], header?: string[]): void {
    const text = formatTable(rows, header);
    if (text) this.out(text);
  }

  json(value: unknown): void {
    this.doc = { value };
  }

  mark(mark: Mark, msg: string): void {
    if (mark === 'warning') this.warn(msg);
    else if (mark === 'error') this.error(msg);
    else this.out(`${symbol(mark)} ${msg}`);
  }

  added(msg: string): void {
    this.mark('added', msg);
  }

  removed(msg: string): void {
    this.mark('removed', msg);
  }

  updated(msg: string): void {
    this.mark('updated', msg);
  }

  unchanged(msg: string): void {
    this.mark('unchanged', msg);
  }

  success(msg: string): void {
    this.mark('added', msg);
  }

  info(msg: string): void {
    this.mark('info', msg);
  }

  hint(msg: string): void {
    this.out(pc.dim(msg));
  }

  warn(msg: string): void {
    if (!this.collected.includes(msg)) this.collected.push(msg);
  }

  error(msg: string, hint?: string): void {
    this.stderr.write(`${symbol('error')} ${msg}\n`);
    if (hint) this.stderr.write(`${pc.dim(`  ${hint}`)}\n`);
  }

  debug(msg: string): void {
    if (this.verbose) this.stderr.write(`${pc.dim(`· ${msg}`)}\n`);
  }

  warnings(): string[] {
    return [...this.collected];
  }

  finish(): void {
    const warnings = this.collected;
    const doc = this.doc;
    this.collected = [];
    this.doc = undefined;
    if (this.jsonMode) {
      if (doc || warnings.length)
        this.stdout.write(`${JSON.stringify(jsonEnvelope(doc?.value, warnings), null, 2)}\n`);
      return;
    }
    if (!warnings.length) return;
    this.stderr.write(`\n${pc.bold(pc.yellow('Warnings'))}\n`);
    for (const w of warnings) this.stderr.write(`  ${symbol('warning')} ${w}\n`);
  }
}

export function createOutput(opts: OutputOptions = {}): Output {
  return new Writer(opts);
}

/**
 * `ctx.log` as the output writer. A plain Logger (tests, library use) gets a writer whose data
 * lines go to `log.info`, stderr lines to `log.debug` and warnings straight to `log.warn`.
 */
export function outputOf(log: Logger): Output {
  const o = log as Partial<Output>;
  if (typeof o.table === 'function' && typeof o.finish === 'function') return log as Output;
  const line = (fn: (msg: string) => void) => ({ write: (s: string) => fn(s.replace(/\n$/, '')) });
  const writer = createOutput({
    stdout: line((m) => log.info(m)),
    stderr: line((m) => log.debug(m)),
  });
  return Object.assign(writer, { warn: (msg: string) => log.warn(msg) });
}

/**
 * How many things an engine result reports as failed: a `failures` array when the result has
 * one, else outcomes with status `failed`. The CLI exits 1 when this is not 0.
 */
export function failureCount(result: object): number {
  const r = result as { failures?: unknown; outcomes?: Array<{ status?: string }> };
  const listed = Array.isArray(r.failures) ? r.failures.length : 0;
  const failed = (r.outcomes ?? []).filter((o) => o.status === 'failed').length;
  return Math.max(listed, failed);
}

const STATUS_MARK: Record<string, Mark> = {
  installed: 'added',
  updated: 'updated',
  unchanged: 'unchanged',
  skipped: 'warning',
  failed: 'error',
};

function statusCell(status: InstallOutcome['status'] | 'failed'): string {
  const mark = STATUS_MARK[status] ?? 'info';
  return `${symbol(mark)} ${status}`;
}

function fileCount(o: InstallOutcome): string {
  const files = o.entry.files.length;
  const merged = o.entry.merged?.length ?? 0;
  return merged ? `${files} (+${merged} merged)` : String(files);
}

function outcomeRow(o: InstallOutcome): string[] {
  return [
    statusCell(o.status),
    o.entry.kind,
    o.entry.via ? `${o.entry.name} ${pc.dim(`(${o.entry.via})`)}` : o.entry.name,
    o.entry.origin,
    o.entry.targets.join(','),
    fileCount(o),
  ];
}

function printOutcomes(out: Output, outcomes: InstallOutcome[]): void {
  out.table(outcomes.map(outcomeRow), ['status', 'kind', 'name', 'origin', 'targets', 'files']);
  const tally = new Map<string, number>();
  for (const o of outcomes) tally.set(o.status, (tally.get(o.status) ?? 0) + 1);
  out.hint([...tally].map(([s, n]) => `${n} ${s}`).join(', '));
  const noted = outcomes.filter((o) => o.notes.length > 0);
  if (!noted.length) return;
  out.out();
  for (const o of noted)
    for (const note of o.notes) out.out(`${symbol('info')} ${pc.bold(o.entry.name)}: ${note}`);
}

/** Status table of an install/update/sync; result warnings join the collected warnings. */
export function printInstallSummary(
  out: Output,
  result: InstallResult,
  opts: { scope: Scope; targets: TargetId[] },
): void {
  const targets = opts.targets.length ? opts.targets.join(', ') : 'no targets';
  if (result.outcomes.length === 0) {
    out.hint(`Nothing to install (${opts.scope} scope → ${targets}).`);
  } else {
    out.out(`${pc.bold(opts.scope)} scope → ${pc.bold(targets)}`);
    printOutcomes(out, result.outcomes);
  }
  for (const w of result.warnings) out.warn(w);
}
