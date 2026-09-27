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
  | 'E_INTERNAL';

export class PalmError extends Error {
  readonly code: PalmErrorCode;
  readonly hint?: string;

  constructor(code: PalmErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'PalmError';
    this.code = code;
    this.hint = hint;
  }
}

export function isPalmError(e: unknown): e is PalmError {
  return e instanceof PalmError;
}
