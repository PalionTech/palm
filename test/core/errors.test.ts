import { describe, expect, it } from 'vitest';
import { isPalmError, messageOf, PalmError, retryHint } from '../../src/core/errors.js';

describe('messageOf', () => {
  it('returns the message of an Error and stringifies anything else', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf(new PalmError('E_CANCELLED', 'cancelled'))).toBe('cancelled');
    expect(messageOf('plain')).toBe('plain');
    expect(messageOf(42)).toBe('42');
    expect(messageOf(undefined)).toBe('undefined');
  });

  it('keeps PalmError codes', () => {
    const e = new PalmError('E_CANCELLED', 'cancelled');
    expect(isPalmError(e) && e.code).toBe('E_CANCELLED');
  });
});

describe('retryHint (M5: hints are runnable commands)', () => {
  const consent = new PalmError('E_NON_INTERACTIVE', 'no consent', 'review them, then run', {
    retryWith: '--yes',
  });
  const secrets = new PalmError('E_NON_INTERACTIVE', 'no secret', 'or keep a reference', {
    retryWith: '--secrets env-ref',
  });

  it('repeats the command line with the flags, before any `--` passthrough, shell-quoted', () => {
    expect(
      retryHint(consent, {
        args: ['install', 'mcp', 'fs', '-y', '--header', 'A=Bearer ${T}'],
        passthrough: ['npx', '-y', "it's"],
      }),
    ).toBe(
      "review them, then run: palm install mcp fs --header 'A=Bearer ${T}' --yes -- npx -y 'it'\\''s'",
    );
  });

  it('replaces an option the flags set; without a command line it names the flags', () => {
    expect(
      retryHint(secrets, {
        args: ['install', 'mcp', 'x', '-g', '--secrets', 'literal'],
        passthrough: [],
      }),
    ).toBe('or keep a reference: palm install mcp x -g --secrets env-ref');
    expect(
      retryHint(secrets, { args: ['i', 'mcp', 'x', '--secrets=literal'], passthrough: [] }),
    ).toBe('or keep a reference: palm i mcp x --secrets env-ref');
    expect(retryHint(consent)).toBe('review them, then run it again with --yes');
    expect(retryHint(new PalmError('E_IO', 'x', 'plain hint'))).toBe('plain hint');
  });
});
