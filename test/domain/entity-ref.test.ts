import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { KINDS } from '../../src/core/types.js';
import {
  formatEntityRef,
  isLegacyDepString,
  parseEntityRef,
  REF_GRAMMAR,
  sameName,
} from '../../src/domain/entity-ref.js';

describe('parseEntityRef', () => {
  it.each([
    ['tdd', { name: 'tdd' }],
    ['  tdd  ', { name: 'tdd' }],
    ['skill:tdd', { kind: 'skill', name: 'tdd' }],
    ['sk:tdd', { kind: 'skill', name: 'tdd' }],
    ['SKILLS:TDD', { kind: 'skill', name: 'TDD' }],
    ['command:review', { kind: 'skill', name: 'review' }],
    ['hook:session-start', { kind: 'hook', name: 'session-start' }],
    ['plugin:superpowers', { kind: 'plugin', name: 'superpowers' }],
    ['mcp:docs', { kind: 'mcp', name: 'docs' }],
  ])('%j → %j', (text, ref) => {
    expect(parseEntityRef(text)).toEqual(ref);
  });

  it('refuses an unknown kind word and an empty name with the grammar as hint', () => {
    for (const bad of ['widget:x', 'skill:', ' ', ':']) {
      expect(() => parseEntityRef(bad), bad).toThrowError(
        expect.objectContaining({ code: 'E_USAGE', hint: REF_GRAMMAR }),
      );
    }
  });

  it('refuses the 0.1 forms, naming the 0.2 command', () => {
    expect(() => parseEntityRef('tdd@mattpocock')).toThrowError(
      expect.objectContaining({ code: 'E_USAGE', hint: 'palm install mattpocock tdd' }),
    );
    expect(() => parseEntityRef('tdd@matt#v1')).toThrowError(
      expect.objectContaining({ code: 'E_USAGE', hint: 'palm update matt --to v1' }),
    );
  });

  it('round-trips formatEntityRef for every kind and safe name', () => {
    const name = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,20}$/);
    fc.assert(
      fc.property(fc.constantFrom(...KINDS), name, (kind, n) => {
        expect(parseEntityRef(formatEntityRef({ kind, name: n }))).toEqual({ kind, name: n });
      }),
    );
  });
});

describe('isLegacyDepString / sameName', () => {
  it('spots name@source and #ref only', () => {
    expect(isLegacyDepString('tdd@mattpocock')).toBe(true);
    expect(isLegacyDepString('tdd#v1')).toBe(true);
    expect(isLegacyDepString('tdd')).toBe(false);
    expect(isLegacyDepString('skill:tdd')).toBe(false);
    expect(isLegacyDepString('@scope')).toBe(false);
  });

  it('compares names in any case', () => {
    expect(sameName('TDD', 'tdd')).toBe(true);
    expect(sameName('tdd', 'tdd2')).toBe(false);
  });
});
