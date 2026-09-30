/**
 * The interactive UI (`@clack/prompts`) and the one used without a terminal, where every prompt
 * is an error that names the flag that answers it (PLAN.md §4.5 invariant 21).
 */
import type { Readable, Writable } from 'node:stream';
import * as p from '@clack/prompts';
import { PalmError } from '../core/errors.js';
import type { ConsentAnswer, PickOption, UI } from '../core/types.js';

/** What a secret prompt echoes for each typed character. */
const SECRET_MASK = '•';

/** Above this many options, pickers switch to type-to-filter (autocomplete) prompts. */
const AUTOCOMPLETE_THRESHOLD = 8;

const CTRL_C = '\u0003';
const ESC = '\u001b';

export function isInteractiveTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = env.CI !== undefined && env.CI !== '' && env.CI !== '0' && env.CI !== 'false';
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !ci);
}

/** The user pressed Esc or Ctrl-C in a prompt: runCli exits 130 without another message. */
function cancelled(output: Writable | undefined): never {
  p.cancel('Cancelled.', { output });
  throw new PalmError('E_CANCELLED', 'cancelled');
}

/** Case-insensitive match of every whitespace-separated term against label and hint. */
function matchesQuery(
  option: { label?: string; hint?: string; value: unknown },
  query: string,
): boolean {
  const hay = `${option.label ?? String(option.value)} ${option.hint ?? ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

type SelectOpts<T> = Parameters<typeof p.select<T>>[0]['options'];

function toClack<T>(options: PickOption<T>[]): SelectOpts<T> {
  return options.map((o) =>
    o.hint ? { value: o.value, label: o.label, hint: o.hint } : { value: o.value, label: o.label },
  ) as unknown as SelectOpts<T>;
}

const filter = (search: string, option: { label?: string; hint?: string; value: unknown }) =>
  matchesQuery(option, search);

/**
 * A pseudo-terminal without a window size (some CI runners, `expect`, `script`) reports
 * columns 0; clack then hard-wraps every character. Fall back to a sane width.
 */
function fixTerminalSize(): void {
  const stdout = process.stdout as NodeJS.WriteStream & { columns?: number; rows?: number };
  if (!stdout.isTTY) return;
  if (!(typeof stdout.columns === 'number' && stdout.columns > 0)) stdout.columns = 80;
  if (!(typeof stdout.rows === 'number' && stdout.rows > 0)) stdout.rows = 24;
}

/** Streams the prompts read and write (default: the process's stdin and stdout). */
export interface PromptIO {
  input?: Readable;
  output?: Writable;
}

type RawInput = Readable & { isRaw?: boolean; setRawMode?: (on: boolean) => unknown };

/** One keypress (raw mode when the input is a terminal). */
function readKey(input: RawInput): Promise<string> {
  return new Promise((resolve) => {
    const wasRaw = Boolean(input.isRaw);
    input.setRawMode?.(true);
    const onData = (chunk: Buffer | string) => {
      input.off('data', onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      resolve(chunk.toString());
    };
    input.on('data', onData);
    input.resume();
  });
}

/** The answer a key means, or undefined for a key the prompt ignores. */
export function consentKey(key: string, canDiff: boolean): ConsentAnswer | 'cancel' | undefined {
  const k = key.toLowerCase();
  if (k === CTRL_C || k === ESC) return 'cancel';
  if (k === 'y') return 'yes';
  if (k === 'n' || k === '\r' || k === '\n' || k === '\r\n') return 'no';
  if (k === 'v') return 'view';
  if (k === 'd' && canDiff) return 'diff';
  return undefined;
}

const ANSWER_ECHO: Readonly<Record<ConsentAnswer, string>> = {
  yes: 'y',
  no: 'n',
  view: 'v',
  diff: 'd',
};

class ClackUI implements UI {
  readonly isInteractive = true;

  constructor(private readonly io: PromptIO) {}

  private unwrap<V>(value: V | typeof p.CANCEL_SYMBOL): V {
    if (p.isCancel(value)) cancelled(this.io.output);
    return value as V;
  }

  async pick<T>(message: string, options: PickOption<T>[]): Promise<T> {
    if (options.length === 0) throw new PalmError('E_USAGE', `nothing to choose from: ${message}`);
    if (options.length <= AUTOCOMPLETE_THRESHOLD)
      return this.unwrap(await p.select<T>({ message, options: toClack(options), ...this.io }));
    const opts = { message, options: toClack(options), maxItems: 10, filter, ...this.io };
    return this.unwrap(await p.autocomplete<T>({ ...opts, placeholder: 'type to filter' }));
  }

  async pickMany<T>(message: string, options: PickOption<T>[], initial?: T[]): Promise<T[]> {
    if (options.length === 0) return [];
    const base = { message, options: toClack(options), initialValues: initial, required: false };
    if (options.length <= AUTOCOMPLETE_THRESHOLD)
      return this.unwrap(await p.multiselect<T>({ ...base, ...this.io }));
    const placeholder = 'type to filter, space to toggle';
    return this.unwrap(
      await p.autocompleteMultiselect<T>({
        ...base,
        maxItems: 12,
        placeholder,
        filter,
        ...this.io,
      }),
    );
  }

  async confirm(message: string, initial = true): Promise<boolean> {
    return this.unwrap(await p.confirm({ message, initialValue: initial, ...this.io }));
  }

  async text(
    message: string,
    o: {
      placeholder?: string;
      initial?: string;
      validate?: (v: string) => string | undefined;
    } = {},
  ): Promise<string> {
    const validate = o.validate;
    const value = this.unwrap(
      await p.text({
        message,
        placeholder: o.placeholder,
        initialValue: o.initial,
        validate: validate ? (v: string | undefined) => validate(v ?? '') : undefined,
        ...this.io,
      }),
    );
    return value ?? '';
  }

  /** Masked input: each typed character echoes as SECRET_MASK, never as itself. */
  async secret(message: string): Promise<string> {
    return this.unwrap(await p.password({ message, mask: SECRET_MASK, ...this.io })) ?? '';
  }

  /** DESIGN.md §7: the text, then one key: y, n (or Enter), v, d. Esc or Ctrl-C cancels. */
  async consent(text: string, opts: { canDiff: boolean }): Promise<ConsentAnswer> {
    const output = this.io.output ?? process.stdout;
    const input = (this.io.input ?? process.stdin) as RawInput;
    output.write(text.endsWith(' ') ? text : `${text} `);
    for (;;) {
      const answer = consentKey(await readKey(input), opts.canDiff);
      if (answer === 'cancel') {
        output.write('\n');
        throw new PalmError('E_CANCELLED', 'cancelled');
      }
      if (answer) {
        output.write(`${ANSWER_ECHO[answer]}\n`);
        return answer;
      }
    }
  }

  /** `stop()` without a message clears the spinner line, so transcripts stay clean. */
  spinner(message: string) {
    const s = p.spinner({ output: this.io.output });
    s.start(message);
    return {
      stop: (msg?: string) => (msg === undefined ? s.clear() : s.stop(msg)),
      message: (msg: string) => s.message(msg),
    };
  }
}

export function createClackUI(opts: PromptIO = {}): UI {
  fixTerminalSize();
  return new ClackUI(opts);
}

export function createNonInteractiveUI(): UI {
  const fail = (message: string): never => {
    throw new PalmError(
      'E_NON_INTERACTIVE',
      `input needed but there is no terminal: ${message}`,
      'run it in a terminal, or answer up front with flags (--yes, --allow-exec)',
    );
  };
  return {
    isInteractive: false,
    pick: async (message) => fail(message),
    pickMany: async (message) => fail(message),
    confirm: async (message) => fail(message),
    text: async (message) => fail(message),
    secret: async (message) => fail(message),
    consent: async () => fail('allow programs to run'),
    spinner: () => ({ stop() {}, message() {} }),
  };
}
