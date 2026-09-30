import { createContext } from '../../src/core/context.js';
import { PalmError } from '../../src/core/errors.js';
import type {
  ConsentAnswer,
  Logger,
  PalmContext,
  PalmFlags,
  PickOption,
  UI,
} from '../../src/core/types.js';
import type { Sandbox } from './sandbox.js';

// ---------------------------------------------------------------------------
// Logger, UI, context
// ---------------------------------------------------------------------------

export interface FakeLogger extends Logger {
  messages: Array<{ level: string; msg: string }>;
}

export function fakeLogger(): FakeLogger {
  const messages: Array<{ level: string; msg: string }> = [];
  const push = (level: string) => (msg: string) => void messages.push({ level, msg });
  return {
    messages,
    info: push('info'),
    warn: push('warn'),
    debug: push('debug'),
    success: push('success'),
  };
}

export interface FakeUI extends UI {
  picks: Array<{ message: string; options: PickOption<unknown>[] }>;
  pickManys: Array<{ message: string; options: PickOption<unknown>[] }>;
  /** Every consent prompt shown, with its text. */
  consents: Array<{ text: string; canDiff: boolean }>;
}

export interface FakeUIOptions {
  interactive?: boolean;
  choose?: (options: PickOption<unknown>[]) => unknown;
  chooseMany?: (options: PickOption<unknown>[]) => unknown[];
  /** Answers for `confirm`, in order (default: `true`). */
  confirms?: boolean[];
  /** Answers for `consent`, in order (default: `no`, the prompt's default). */
  consentAnswers?: ConsentAnswer[];
}

/** Scripted UI: `pick` returns the option chosen by `choose` (default: first). */
export function fakeUI(opts: FakeUIOptions = {}): FakeUI {
  const interactive = opts.interactive ?? true;
  const picks: FakeUI['picks'] = [];
  const pickManys: FakeUI['pickManys'] = [];
  const consents: FakeUI['consents'] = [];
  const confirms = [...(opts.confirms ?? [])];
  const answers = [...(opts.consentAnswers ?? [])];
  const refuse = (): never => {
    throw new PalmError('E_NON_INTERACTIVE', 'prompt in non-interactive fake UI');
  };
  return {
    isInteractive: interactive,
    picks,
    pickManys,
    consents,
    async pick<T>(message: string, options: PickOption<T>[]): Promise<T> {
      if (!interactive) refuse();
      picks.push({ message, options: options as PickOption<unknown>[] });
      return (opts.choose ? opts.choose(options as PickOption<unknown>[]) : options[0]!.value) as T;
    },
    async pickMany<T>(message: string, options: PickOption<T>[]): Promise<T[]> {
      if (!interactive) refuse();
      pickManys.push({ message, options: options as PickOption<unknown>[] });
      const chosen = opts.chooseMany?.(options as PickOption<unknown>[]) ?? [options[0]!.value];
      return chosen as T[];
    },
    async confirm(): Promise<boolean> {
      if (!interactive) refuse();
      return confirms.shift() ?? true;
    },
    async text(): Promise<string> {
      if (!interactive) refuse();
      return '';
    },
    async secret(): Promise<string> {
      if (!interactive) refuse();
      return 'secret';
    },
    async consent(text: string, o: { canDiff: boolean }): Promise<ConsentAnswer> {
      if (!interactive) refuse();
      consents.push({ text, canDiff: o.canDiff });
      return answers.shift() ?? 'no';
    },
    spinner() {
      return { stop() {}, message() {} };
    },
  };
}

/** The flags of a plain run: nothing set, no `--allow-exec`. */
export function defaultFlags(flags: Partial<PalmFlags> = {}): PalmFlags {
  return {
    yes: false,
    dryRun: false,
    force: false,
    offline: false,
    json: false,
    allowExec: [],
    local: false,
    ...flags,
  };
}

export async function makeContext(
  sb: Sandbox,
  opts: { ui?: UI; log?: Logger; flags?: Partial<PalmFlags>; cwd?: string } = {},
): Promise<PalmContext> {
  return createContext({
    cwd: opts.cwd ?? sb.project,
    env: sb.env,
    ui: opts.ui ?? fakeUI(),
    log: opts.log ?? fakeLogger(),
    flags: defaultFlags(opts.flags),
  });
}
