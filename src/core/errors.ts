export type PalmErrorCode =
  | 'E_USAGE'
  | 'E_NOT_FOUND'
  | 'E_AMBIGUOUS'
  | 'E_CONFLICT'
  | 'E_ORIGIN'
  | 'E_GIT'
  | 'E_NETWORK'
  | 'E_PARSE'
  | 'E_TARGET'
  | 'E_IO'
  | 'E_NON_INTERACTIVE'
  | 'E_CANCELLED'
  | 'E_INTERNAL';

export class PalmError extends Error {
  readonly code: PalmErrorCode;
  readonly hint?: string;
  /**
   * Flags that make the same command succeed (`--yes`, `--secrets env-ref`). The CLI ends the
   * hint with the command line it ran plus these (`<hint>: palm install … --yes`); without a
   * command line the hint ends `<hint> it again with <flags>`.
   */
  readonly retryWith?: string;

  constructor(
    code: PalmErrorCode,
    message: string,
    hint?: string,
    opts: { retryWith?: string } = {},
  ) {
    super(message);
    this.name = 'PalmError';
    this.code = code;
    this.hint = hint;
    if (opts.retryWith) this.retryWith = opts.retryWith;
  }
}

/** A shell word: as is when it holds only safe characters, else single-quoted. */
function shellWord(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** `args` without the option `retry` sets (`--secrets x`, `--secrets=x`; `--yes` also as `-y`). */
function withoutOption(args: readonly string[], retry: readonly string[]): string[] {
  const [name = '', value] = retry;
  const takesValue = value !== undefined && !value.startsWith('-');
  const spellings = name === '--yes' ? ['--yes', '-y'] : [name];
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith(`${name}=`)) continue;
    if (!spellings.includes(a)) out.push(a);
    else if (takesValue) i++;
  }
  return out;
}

/**
 * The hint of an error with `retryWith`, given the command line that failed (`args` before `--`,
 * `passthrough` after it): `<hint>: palm <args> <flags> [-- <passthrough>]`.
 */
export function retryHint(
  e: PalmError,
  run?: { args: readonly string[]; passthrough: readonly string[] },
): string | undefined {
  if (!e.retryWith) return e.hint;
  const flags = e.retryWith.split(' ');
  if (!run) return `${e.hint ?? 'run the command'} it again with ${e.retryWith}`;
  const words = [...withoutOption(run.args, flags), ...flags].map(shellWord);
  const tail = run.passthrough.length ? ` -- ${run.passthrough.map(shellWord).join(' ')}` : '';
  return `${e.hint ?? 'run'}: palm ${words.join(' ')}${tail}`;
}

export function isPalmError(e: unknown): e is PalmError {
  return e instanceof PalmError;
}

/** The message of an Error, or the thrown value itself as a string. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
