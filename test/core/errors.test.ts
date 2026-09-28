import { describe, expect, it } from 'vitest';
import { isPalmError, messageOf, PalmError } from '../../src/core/errors.js';

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
