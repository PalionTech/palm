/**
 * Every error palm raises (DESIGN.md section 11). `E_USAGE` exits 2, `E_CANCELLED` 130, the
 * rest 1. `E_SOURCE`: a source cannot be declared, fetched or read. `E_UNTRUSTED_EXEC`: an
 * executable needs consent and there is no terminal. `E_SECRET`: a literal secret may not be
 * written. `E_CHECK`: `palm check` found a problem.
 */
export type PalmErrorCode =
  | 'E_USAGE'
  | 'E_NOT_FOUND'
  | 'E_AMBIGUOUS'
  | 'E_CONFLICT'
  | 'E_SOURCE'
  | 'E_GIT'
  | 'E_NETWORK'
  | 'E_PARSE'
  | 'E_TARGET'
  | 'E_IO'
  | 'E_NON_INTERACTIVE'
  | 'E_CANCELLED'
  | 'E_UNTRUSTED_EXEC'
  | 'E_SECRET'
  | 'E_CHECK'
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

/** `palm <args> <retryWith>`, the option replaced when `args` already has it, shell-quoted. */
export function retryCommand(args: readonly string[], retryWith: string): string {
  const flags = retryWith.split(' ');
  return `palm ${[...withoutOption(args, flags), ...flags].map(shellWord).join(' ')}`;
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
  if (!run) return `${e.hint ?? 'run the command'} it again with ${e.retryWith}`;
  const tail = run.passthrough.length ? ` -- ${run.passthrough.map(shellWord).join(' ')}` : '';
  return `${e.hint ?? 'run'}: ${retryCommand(run.args, e.retryWith)}${tail}`;
}

export function isPalmError(e: unknown): e is PalmError {
  return e instanceof PalmError;
}

/** Node's errno codes for a write the filesystem refused, with the words people read for each. */
const DENIED: Readonly<Record<string, string>> = {
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EROFS: 'read-only file system',
};

/** The `code` and `path` of a Node.js system error, when it has them. */
function systemError(e: unknown): { code?: string; path?: string } {
  if (typeof e !== 'object' || e === null) return {};
  const { code, path } = e as { code?: unknown; path?: unknown };
  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof path === 'string' ? { path } : {}),
  };
}

/**
 * B6: a write the filesystem refused (EACCES, EPERM, EROFS) as E_IO naming the path and the
 * reason, never E_INTERNAL; undefined for any other error. `fallback` is the path to name when
 * the error carries none; `hint` replaces the default (check the directory's permissions).
 */
export function deniedError(e: unknown, fallback: string, hint?: string): PalmError | undefined {
  if (e instanceof PalmError) return undefined;
  const { code, path } = systemError(e);
  const reason = code ? DENIED[code] : undefined;
  if (!reason) return undefined;
  const where = path ?? fallback;
  return new PalmError(
    'E_IO',
    `cannot write ${where}: ${reason} (${code})`,
    hint ?? `check the permissions: ls -ld ${where}`,
  );
}

/** The message of an Error, or the thrown value itself as a string. */
export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
