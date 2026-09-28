import { describe, expect, it } from 'vitest';
import { DEP_GRAMMAR, DepRef, sameName } from '../../src/domain/dep-ref.js';

describe('DepRef.parse', () => {
  it.each([
    ['wayfinder', { name: 'wayfinder' }],
    ['wayfinder@mattpocock', { name: 'wayfinder', origin: 'mattpocock' }],
    ['tdd@mattpocock#v1.2.3', { name: 'tdd', origin: 'mattpocock', ref: 'v1.2.3' }],
    ['io.github.github/github-mcp-server', { name: 'io.github.github/github-mcp-server' }],
    ['io.github.x/y#1.0.0', { name: 'io.github.x/y', ref: '1.0.0' }],
    ['x#main', { name: 'x', ref: 'main' }],
    ['x#feature/a#b', { name: 'x#feature/a', ref: 'b' }],
    ['@scope/pkg', { name: '@scope/pkg' }],
    ['@scope/pkg@o', { name: '@scope/pkg', origin: 'o' }],
    ['@origin', { name: '@origin' }],
    ['  a @ o # r  ', { name: 'a', origin: 'o', ref: 'r' }],
    ['a@#', { name: 'a' }],
  ])('%s', (input, expected) => {
    expect(DepRef.parse(input).toJSON()).toStrictEqual(expected);
  });

  it('rejects a missing name with E_USAGE and the grammar as hint', () => {
    for (const bad of ['', '   ', '#ref', '#', ' # x']) {
      expect(() => DepRef.parse(bad)).toThrow(
        expect.objectContaining({ code: 'E_USAGE', hint: DEP_GRAMMAR }),
      );
    }
    expect(() => DepRef.parse('#ref')).toThrow(/missing name/);
  });

  it('has no own keys for absent parts', () => {
    const d = DepRef.parse('a');
    expect(Object.keys(d)).toEqual(['name']);
    expect({ ...d }).toStrictEqual({ name: 'a' });
    expect(JSON.stringify(DepRef.parse('a@o#r'))).toBe('{"name":"a","origin":"o","ref":"r"}');
  });
});

describe('DepRef.from / of', () => {
  it('accepts strings, objects and DepRefs', () => {
    const d = DepRef.parse('a@o');
    expect(DepRef.from(d)).toBe(d);
    expect(DepRef.from('a@o#r').toString()).toBe('a@o#r');
    expect(DepRef.from({ name: 'a', origin: '', ref: 'r' }).toJSON()).toStrictEqual({
      name: 'a',
      ref: 'r',
    });
    expect(DepRef.of('io.x/y', undefined, '1.0').toString()).toBe('io.x/y#1.0');
    // parts are taken verbatim: no parsing of `@` in the name
    expect(DepRef.of('a@b').toJSON()).toStrictEqual({ name: 'a@b' });
  });

  it('rejects malformed manifest objects with E_PARSE', () => {
    for (const bad of [null, 42, {}, { name: '' }, { name: 3 }]) {
      expect(() => DepRef.from(bad as never)).toThrow(expect.objectContaining({ code: 'E_PARSE' }));
    }
  });
});

describe('DepRef methods', () => {
  it('withOrigin / withRef replace one part', () => {
    const d = DepRef.parse('a@o#r');
    expect(d.withOrigin('p').toString()).toBe('a@p#r');
    expect(d.withOrigin(undefined).toString()).toBe('a#r');
    expect(d.withRef('v2').toString()).toBe('a@o#v2');
    expect(d.withRef(undefined).toString()).toBe('a@o');
    expect(d.toString()).toBe('a@o#r'); // immutable
  });

  it('matches names case-insensitively, and the origin when one is named', () => {
    expect(DepRef.parse('Tdd').matches({ name: 'tdd', origin: 'x' })).toBe(true);
    expect(DepRef.parse('tdd@X').matches({ name: 'TDD', origin: 'x' })).toBe(true);
    expect(DepRef.parse('tdd@y').matches({ name: 'tdd', origin: 'x' })).toBe(false);
    expect(DepRef.parse('tdd@y').matches({ name: 'tdd' })).toBe(false);
    expect(DepRef.parse('tdd').matches({ name: 'tdd' })).toBe(true);
    expect(DepRef.parse('other').matches({ name: 'tdd', origin: 'x' })).toBe(false);
  });

  it('sameName ignores case', () => {
    expect(sameName('ABC', 'abc')).toBe(true);
    expect(sameName('abc', 'abd')).toBe(false);
  });
});
