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

const PLACEHOLDER = /\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/g;

/**
 * A recorded string matches the actual one when equal, or when the recorded string has
 * `${VAR}` placeholders and the actual string equals it with some text in their place
 * (records in the lockfile carry placeholders instead of literal secret values).
 */
export function recordedStringMatches(actual: string, recorded: string): boolean {
  if (actual === recorded) return true;
  const parts = recorded.replace(PLACEHOLDER, '\u0000').split('\u0000');
  if (parts.length === 1) return false;
  const re = new RegExp(`^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`);
  return re.test(actual);
}

/** deepEqual, except that recorded strings may contain `${VAR}` placeholders (see recordedStringMatches). */
export function matchesRecorded(actual: unknown, recorded: unknown): boolean {
  if (typeof actual === 'string' && typeof recorded === 'string') return recordedStringMatches(actual, recorded);
  if (Array.isArray(recorded)) {
    return Array.isArray(actual) && actual.length === recorded.length && recorded.every((x, i) => matchesRecorded(actual[i], x));
  }
  if (isPlainObject(actual) && isPlainObject(recorded)) {
    const ka = Object.keys(actual).filter((k) => actual[k] !== undefined);
    const kb = Object.keys(recorded).filter((k) => recorded[k] !== undefined);
    return ka.length === kb.length && kb.every((k) => Object.prototype.hasOwnProperty.call(actual, k) && matchesRecorded(actual[k], recorded[k]));
  }
  return deepEqual(actual, recorded);
}

/**
 * True when `actual` still holds everything palm inserted (`expected`): every key of
 * `expected` matches the same key in `actual` (placeholders in `expected` stand for
 * redacted secrets). Keys the user added are tolerated.
 */
export function containsAll(actual: unknown, expected: unknown): boolean {
  if (isPlainObject(actual) && isPlainObject(expected)) {
    return Object.keys(expected).every((k) => expected[k] === undefined || matchesRecorded(actual[k], expected[k]));
  }
  return matchesRecorded(actual, expected);
}

/** Replace every occurrence of a secret value with its `${NAME}` placeholder (for what palm records). */
export function redactSecrets<T>(value: T, secrets: Record<string, string> | undefined): T {
  const pairs = Object.entries(secrets ?? {})
    .filter(([, v]) => v.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  if (pairs.length === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return pairs.reduce((s, [name, secret]) => s.split(secret).join(`\${${name}}`), v);
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export { isPlainObject };
