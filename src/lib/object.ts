/**
 * Plain-data helpers (JSON, YAML and TOML values): record check, structural equality and
 * dropping undefined-valued keys.
 */

/** True for a non-null object that is neither an array nor a Date. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** An integer as bigint (a bigint, or a number that is an integer), else undefined. */
function asBigInt(v: unknown): bigint | undefined {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  return undefined;
}

/** Keys of `o` whose value is not undefined. */
function definedKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined);
}

function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = definedKeys(a);
  return (
    ka.length === definedKeys(b).length &&
    ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
  );
}

/**
 * Structural equality on plain data: key order and undefined-valued keys are ignored, arrays
 * compare element-wise, Dates by time, NaN equals NaN, and a bigint equals the same integer
 * number (TOML integers). Anything else compares with `===`.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const x = asBigInt(a);
    return x !== undefined && x === asBigInt(b);
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => deepEqual(x, b[i]))
    );
  }
  return isRecord(a) && isRecord(b) && sameRecord(a, b);
}

/** Shallow copy of the record `o` without the keys whose value is undefined. */
export function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Deep copy of `v` with undefined-valued keys removed from every nested record. Arrays keep
 * their length (undefined elements stay); non-record values are returned as they are.
 */
export function withoutUndefinedDeep<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x: unknown) => withoutUndefinedDeep(x)) as T;
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = withoutUndefinedDeep(x);
  return out as T;
}
