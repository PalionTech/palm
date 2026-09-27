function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** Structural equality for JSON/TOML/YAML values (key order ignored, undefined keys ignored). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'bigint' || typeof b === 'bigint') return String(a) === String(b);
  if (a instanceof Date || b instanceof Date) return String(a) === String(b);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * True when `actual` still holds everything palm inserted (`expected`): every key of
 * `expected` deep-equals the same key in `actual`. Keys the user added are tolerated.
 */
export function containsAll(actual: unknown, expected: unknown): boolean {
  if (isPlainObject(actual) && isPlainObject(expected)) {
    return Object.keys(expected).every((k) => expected[k] === undefined || deepEqual(actual[k], expected[k]));
  }
  return deepEqual(actual, expected);
}

export { isPlainObject };
