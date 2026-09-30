/**
 * Fakes for the exec and secrets tests: a PalmContext with a recording logger and a scripted
 * UI (consent answers and secret answers are queued; anything else is unexpected).
 */
import { PalmError } from '../../src/core/errors.js';
import type { ConsentAnswer, PalmContext, PalmFlags, UI } from '../../src/core/types.js';

export interface Recorded {
  ctx: PalmContext;
  /** `level: message` for every log call; `page: text` for paged output. */
  logs: string[];
  /** The text of every consent prompt, and its `canDiff`. */
  consents: Array<{ text: string; canDiff: boolean }>;
  /** The label of every masked prompt. */
  secrets: string[];
}

export interface FakeOptions {
  interactive?: boolean;
  env?: Record<string, string>;
  flags?: Partial<PalmFlags>;
  /** Keys typed at consent prompts: `y`, `n`, `v`, `d`, or `''` for Enter. */
  consent?: string[];
  secret?: string[];
  /** Give the logger an Output-like `page` method. */
  pager?: boolean;
  argv?: string[];
}

const PATHS = {
  palmHome: '/home/u/.palm',
  home: '/home/u',
  projectRoot: '/work/app',
  cwd: '/work/app',
};

/** The UI contract's key mapping: `y` yes, `v` view, `d` diff, `n` and Enter (anything else) no. */
const KEYS: Record<string, ConsentAnswer> = { y: 'yes', v: 'view', d: 'diff' };

function scriptedUI(opts: FakeOptions, rec: Omit<Recorded, 'ctx' | 'logs'>): UI {
  const consent = [...(opts.consent ?? [])];
  const secret = [...(opts.secret ?? [])];
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected prompt');
  };
  return {
    isInteractive: opts.interactive ?? true,
    pick: unexpected,
    pickMany: unexpected,
    confirm: unexpected,
    text: unexpected,
    async secret(message) {
      rec.secrets.push(message);
      return secret.shift() ?? '';
    },
    async consent(text, o) {
      if (!(opts.interactive ?? true)) throw new PalmError('E_NON_INTERACTIVE', 'no terminal');
      rec.consents.push({ text, canDiff: o.canDiff });
      const key = consent.shift();
      if (key === undefined) throw new Error('consent asked more often than scripted');
      return KEYS[key] ?? 'no';
    },
    spinner: () => ({ stop() {}, message() {} }),
  };
}

export function fakeContext(opts: FakeOptions = {}): Recorded {
  const logs: string[] = [];
  const rec = { consents: [], secrets: [] } as Omit<Recorded, 'ctx' | 'logs'>;
  const push = (level: string) => (msg: string) => void logs.push(`${level}: ${msg}`);
  const log = {
    info: push('info'),
    warn: push('warn'),
    debug: push('debug'),
    success: push('success'),
    ...(opts.pager ? { page: async (text: string) => void logs.push(`page: ${text}`) } : {}),
  };
  const flags: PalmFlags = {
    yes: false,
    dryRun: false,
    force: false,
    offline: false,
    json: false,
    allowExec: [],
    local: false,
    ...opts.flags,
  };
  const ctx = {
    paths: { ...PATHS },
    ui: scriptedUI(opts, rec),
    log,
    env: { ...(opts.env ?? {}) },
    flags,
    ...(opts.argv ? { argv: opts.argv } : {}),
  } as PalmContext;
  return { ctx, logs, ...rec };
}
