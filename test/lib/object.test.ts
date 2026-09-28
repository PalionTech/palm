import { describe, expect, it } from 'vitest';
import {
  deepEqual,
  isRecord,
  withoutUndefined,
  withoutUndefinedDeep,
} from '../../src/lib/object.js';

describe('isRecord', () => {
  it.each([
    [{}, true],
    [{ a: 1 }, true],
    [Object.create(null), true],
    [[], false],
    [null, false],
    [undefined, false],
    ['x', false],
    [1, false],
    [new Date(0), false],
  ])('isRecord(%j) = %s', (v, ok) => {
    expect(isRecord(v)).toBe(ok);
  });
});

describe('deepEqual', () => {
  it('compares primitives with ===', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(1, '1')).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(0, -0)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
  });

  it('treats NaN as equal to NaN', () => {
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(deepEqual(Number.NaN, 1)).toBe(false);
  });

  it('ignores key order and undefined-valued keys', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1, x: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1, c: 1 })).toBe(false);
  });

  it('requires own keys (inherited keys do not count)', () => {
    const inherited = Object.create({ a: 1 }) as Record<string, unknown>;
    inherited.b = 2;
    inherited.c = 3;
    // Same number of defined keys; `a` is only inherited.
    expect(deepEqual({ a: 1, b: 2 }, inherited)).toBe(false);
  });

  it('compares arrays element-wise and never equal to records', () => {
    expect(deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual([1], [1, 2])).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual({}, [])).toBe(false);
  });

  it('compares Dates by time', () => {
    expect(deepEqual(new Date(5), new Date(5))).toBe(true);
    expect(deepEqual(new Date(5), new Date(6))).toBe(false);
    expect(deepEqual(new Date(5), 5)).toBe(false);
    expect(deepEqual('1970', new Date(0))).toBe(false);
    expect(deepEqual(new Date(Number.NaN), new Date(Number.NaN))).toBe(true);
  });

  it('treats a bigint as the same integer number', () => {
    expect(deepEqual(5n, 5)).toBe(true);
    expect(deepEqual(5, 5n)).toBe(true);
    expect(deepEqual(5n, 5n)).toBe(true);
    expect(deepEqual(5n, 6)).toBe(false);
    expect(deepEqual(5n, 5.5)).toBe(false);
    expect(deepEqual(5n, '5')).toBe(false);
    expect(deepEqual('5', 5n)).toBe(false);
  });
});

describe('withoutUndefined', () => {
  it('drops undefined-valued keys shallowly and returns a copy', () => {
    const input = { a: 1, b: undefined, c: null, d: { e: undefined } };
    const out = withoutUndefined(input);
    expect(out).toStrictEqual({ a: 1, c: null, d: { e: undefined } });
    expect(Object.keys(out)).toEqual(['a', 'c', 'd']);
    expect('b' in input).toBe(true);
  });
});

describe('withoutUndefinedDeep', () => {
  it('drops undefined-valued keys at every depth, through arrays', () => {
    const out = withoutUndefinedDeep({
      a: undefined,
      b: { c: undefined, d: [{ e: undefined, f: 1 }, undefined, 2] },
      g: new Date(0),
    });
    expect(out).toStrictEqual({ b: { d: [{ f: 1 }, undefined, 2] }, g: new Date(0) });
  });

  it('returns non-record values unchanged', () => {
    expect(withoutUndefinedDeep('x')).toBe('x');
    expect(withoutUndefinedDeep(undefined)).toBeUndefined();
  });
});
