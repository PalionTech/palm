/**
 * The one output writer (DESIGN.md §10, "Output contract"). runCli creates it per run and it is
 * `ctx.log` for the command, so every line palm prints goes through here:
 *
 * - data (`out`, `table`, status lines) goes to stdout, or to stderr under `--json`;
 * - `json(value)` buffers the one JSON document `finish()` writes to stdout;
 * - status lines carry a mark: `+ - ~ ↺ = ⊘ x ! i`;
 * - warnings are collected and printed once, under a `Warnings` heading on stderr, by `finish()`
 *   (and land in the JSON document as `warnings: []`);
 * - errors go to stderr as `x message` with the hint on the following lines.
 *
 * Colour is on only for a terminal without `NO_COLOR`.
 */
import { spawn } from 'node:child_process';
import pc from 'picocolors';
import type { Logger, OutcomeStatus } from '../core/types.js';
import { isRecord } from '../lib/object.js';
import {
  type Colors,
  formatTable,
  MARK_COLOUR,
  type Mark,
  STATUS_MARK,
  statusWord,
} from './format.js';

export { type Colors, formatTable, type Mark } from './format.js';
export { failureCount, printInstallSummary, type SummaryOptions } from './summary.js';

/** Anything with a `write(text)`: process.stdout, process.stderr, or a test buffer. */
export interface Sink {
  write(chunk: string): unknown;
}

export interface OutputOptions {
  json?: boolean;
  stdout?: Sink;
  stderr?: Sink;
  /** stdout is a terminal: colour on (unless `noColor`) and `page()` uses the pager. */
  isTTY?: boolean;
  noColor?: boolean;
  /** `PALM_DEBUG=1`: debug lines on stderr. */
  debug?: boolean;
  /** The pager command for `page()` on a terminal (default `$PAGER`, else `less -R`). */
  pager?: string;
}

/** Logger plus the data channel. Everything a command prints goes through one of these. */
export interface Output extends Logger {
  jsonMode: boolean;
  readonly colors: Colors;
  /** Apply the parsed global flags (runCli calls this before each action runs). */
  configure(opts: { json?: boolean }): void;
  /** One line of data (stdout; stderr under --json). */
  out(line?: string): void;
  table(rows: string[][], header?: string[]): void;
  /** The command's JSON document; written by finish(), with `warnings`. */
  json(value: unknown): void;
  mark(mark: Mark, msg: string): void;
  /** `<mark> <word>  <line>`: the DESIGN.md §6 status vocabulary. */
  status(status: OutcomeStatus, line: string): void;
  /** `x message` and the hint on the following lines, on stderr. */
  error(msg: string, hint?: string): void;
  /** A dim follow-up line, e.g. the command to run next. */
  hint(msg: string): void;
  /** Collected, printed once by finish() under "Warnings". */
  warn(msg: string): void;
  warnings(): string[];
  /** Long text (script bodies, diffs): the pager on a terminal, else plain lines. */
  page(text: string): Promise<void>;
  /** Print the collected warnings (or the JSON document). Later calls print nothing. */
  finish(): void;
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

/** Run `pager` with `text` on its stdin; false when it could not start. */
function runPager(pager: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(pager, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code !== 127));
    child.stdin.on('error', () => undefined);
    child.stdin.end(text);
  });
}

class Writer implements Output {
  jsonMode: boolean;
  readonly colors: Colors;
  private readonly stdout: Sink;
  private readonly stderr: Sink;
  private collected: string[] = [];
  private doc: { value: unknown } | undefined;
  private finished = false;

  constructor(private readonly opts: OutputOptions) {
    this.jsonMode = Boolean(opts.json);
    this.stdout = opts.stdout ?? process.stdout;
    this.stderr = opts.stderr ?? process.stderr;
    this.colors = pc.createColors(Boolean(opts.isTTY) && !opts.noColor);
  }

  configure(opts: { json?: boolean }): void {
    if (opts.json !== undefined) this.jsonMode = opts.json;
  }

  /** stdout for data and status lines; stderr under --json so stdout stays one document. */
  private get data(): Sink {
    return this.jsonMode ? this.stderr : this.stdout;
  }

  out(line = ''): void {
    this.data.write(`${line}\n`);
  }

  table(rows: string[][], header?: string[]): void {
    const text = formatTable(rows, header, this.colors);
    if (text) this.out(text);
  }

  json(value: unknown): void {
    this.doc = { value };
  }

  mark(mark: Mark, msg: string): void {
    this.out(`${this.colors[MARK_COLOUR[mark]](mark)} ${msg}`);
  }

  status(status: OutcomeStatus, line: string): void {
    this.mark(STATUS_MARK[status], `${statusWord(status)}  ${line}`);
  }

  success(msg: string): void {
    this.mark('+', msg);
  }

  info(msg: string): void {
    this.mark('i', msg);
  }

  hint(msg: string): void {
    this.out(this.colors.dim(msg));
  }

  warn(msg: string): void {
    if (!this.collected.includes(msg)) this.collected.push(msg);
  }

  warnings(): string[] {
    return [...this.collected];
  }

  error(msg: string, hint?: string): void {
    this.stderr.write(`${this.colors.red('x')} ${msg}\n`);
    for (const line of hint ? hint.split('\n') : [])
      this.stderr.write(`${this.colors.dim(`  ${line}`)}\n`);
  }

  debug(msg: string): void {
    if (this.opts.debug) this.stderr.write(`${this.colors.dim(`· ${msg}`)}\n`);
  }

  async page(text: string): Promise<void> {
    const pager = this.opts.pager ?? process.env.PAGER ?? 'less -R';
    if (this.opts.isTTY && !this.jsonMode && (await runPager(pager, text))) return;
    for (const line of text.replace(/\n$/, '').split('\n')) this.out(line);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const warnings = this.collected;
    if (this.jsonMode) {
      const doc = jsonEnvelope(this.doc?.value, warnings);
      this.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
      return;
    }
    if (!warnings.length) return;
    this.stderr.write(`\n${this.colors.bold(this.colors.yellow('Warnings'))}\n`);
    for (const w of warnings) this.stderr.write(`  ${this.colors.yellow('!')} ${w}\n`);
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
