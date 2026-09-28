import type { Writable } from 'node:stream';
import * as p from '@clack/prompts';
import { PalmError } from '../core/errors.js';
import type { PickOption, UI } from '../core/types.js';

/** Above this many options, pickers switch to type-to-filter (autocomplete) prompts. */
const AUTOCOMPLETE_THRESHOLD = 8;

/**
 * UI with an extra multi-line text prompt. Local extension of the `UI` contract,
 * used by the create wizards for bodies when no $EDITOR is available.
 */
export interface MultilineUI extends UI {
  multiline(message: string, opts?: { placeholder?: string; initial?: string }): Promise<string>;
}

export function supportsMultiline(ui: UI): ui is MultilineUI {
  return typeof (ui as Partial<MultilineUI>).multiline === 'function';
}

export function isInteractiveTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = env.CI !== undefined && env.CI !== '' && env.CI !== '0' && env.CI !== 'false';
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !ci);
}

function cancelled(output: Writable | undefined): never {
  p.cancel('Cancelled.', { output });
  throw new PalmError('E_USAGE', 'cancelled');
}

/** Case-insensitive match of every whitespace-separated term against label + hint. */
export function matchesQuery(
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

export function createClackUI(opts: { output?: Writable } = {}): MultilineUI {
  const output = opts.output;
  // A pseudo-terminal without a window size (some CI runners, `expect`, `script`) reports
  // columns 0; clack then hard-wraps every character. Fall back to a sane width.
  const stdout = process.stdout as NodeJS.WriteStream & { columns?: number; rows?: number };
  if (stdout.isTTY) {
    if (!(typeof stdout.columns === 'number' && stdout.columns > 0)) stdout.columns = 80;
    if (!(typeof stdout.rows === 'number' && stdout.rows > 0)) stdout.rows = 24;
  }
  const unwrap = <V>(value: V | typeof p.CANCEL_SYMBOL): V => {
    if (p.isCancel(value)) cancelled(output);
    return value as V;
  };
  const filter = (search: string, option: { label?: string; hint?: string; value: unknown }) =>
    matchesQuery(option, search);

  return {
    isInteractive: true,

    async pick<T>(message: string, options: PickOption<T>[]): Promise<T> {
      if (options.length === 0)
        throw new PalmError('E_USAGE', `nothing to choose from: ${message}`);
      if (options.length > AUTOCOMPLETE_THRESHOLD) {
        return unwrap(
          await p.autocomplete<T>({
            message,
            options: toClack(options),
            maxItems: 10,
            placeholder: 'type to filter',
            filter,
            output,
          }),
        );
      }
      return unwrap(await p.select<T>({ message, options: toClack(options), output }));
    },

    async pickMany<T>(message: string, options: PickOption<T>[], initial?: T[]): Promise<T[]> {
      if (options.length === 0) return [];
      if (options.length > AUTOCOMPLETE_THRESHOLD) {
        return unwrap(
          await p.autocompleteMultiselect<T>({
            message,
            options: toClack(options),
            initialValues: initial,
            maxItems: 12,
            placeholder: 'type to filter, space to toggle',
            required: false,
            filter,
            output,
          }),
        );
      }
      return unwrap(
        await p.multiselect<T>({
          message,
          options: toClack(options),
          initialValues: initial,
          required: false,
          output,
        }),
      );
    },

    async confirm(message: string, initial = true): Promise<boolean> {
      return unwrap(await p.confirm({ message, initialValue: initial, output }));
    },

    async text(message, o = {}): Promise<string> {
      const validate = o.validate;
      const value = unwrap(
        await p.text({
          message,
          placeholder: o.placeholder,
          initialValue: o.initial,
          validate: validate ? (v: string | undefined) => validate(v ?? '') : undefined,
          output,
        }),
      );
      return value ?? '';
    },

    async multiline(message, o = {}): Promise<string> {
      const value = unwrap(
        await p.multiline({
          message,
          placeholder: o.placeholder,
          initialValue: o.initial,
          showSubmit: true,
          output,
        }),
      );
      return value ?? '';
    },

    async secret(message: string): Promise<string> {
      return unwrap(await p.password({ message, output })) ?? '';
    },

    spinner(message: string) {
      const s = p.spinner({ output });
      s.start(message);
      return {
        stop: (msg?: string) => s.stop(msg),
        message: (msg: string) => s.message(msg),
      };
    },
  };
}

export function createNonInteractiveUI(): UI {
  const fail = (message: string): never => {
    throw new PalmError(
      'E_NON_INTERACTIVE',
      `input needed but no interactive terminal: ${message}`,
      'run in a terminal, or answer up front (name@origin, --target <ids>, --yes)',
    );
  };
  return {
    isInteractive: false,
    pick: async (message) => fail(message),
    pickMany: async (message) => fail(message),
    confirm: async (message) => fail(message),
    text: async (message) => fail(message),
    secret: async (message) => fail(message),
    spinner: () => ({ stop() {}, message() {} }),
  };
}
