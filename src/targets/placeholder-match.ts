/**
 * Rendered values carry `${VAR}` placeholders where a secret goes. These helpers compare such
 * a value with what is on disk (a placeholder matches any text, so a literal the user or a
 * `--secrets literal` run wrote still counts as palm's), and produce the placeholder form of a
 * value that holds literal secrets (for the render hash, which never covers secret values).
 */
import { deepEqual, isRecord } from '../lib/object.js';
import { envRef, replacePlaceholders } from '../lib/placeholders.js';

/** Characters a regular expression gives meaning to. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * An expected string matches the actual one when equal, or when the expected string has
 * `${VAR}` placeholders and the actual string equals it with some text in their place.
 */
function stringMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const parts = replacePlaceholders(expected, () => '\u0000').split('\u0000');
  if (parts.length === 1) return false;
  const re = new RegExp(
    `^${parts.map((p) => p.replace(REGEX_SPECIAL, '\\$&')).join('[\\s\\S]*')}$`,
  );
  return re.test(actual);
}

function definedKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined);
}

/**
 * Deep equality, except that expected strings may contain `${VAR}` placeholders that match any
 * text (see stringMatches). Object key order does not matter; undefined keys are ignored.
 */
export function matchesRendered(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string' && typeof expected === 'string')
    return stringMatches(actual, expected);
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((x, i) => matchesRendered(actual[i], x))
    );
  if (isRecord(actual) && isRecord(expected)) {
    const ka = definedKeys(actual);
    const kb = definedKeys(expected);
    return (
      ka.length === kb.length &&
      kb.every((k) => Object.hasOwn(actual, k) && matchesRendered(actual[k], expected[k]))
    );
  }
  return deepEqual(actual, expected);
}

/** `value` with every occurrence of a secret value replaced by its `${NAME}` placeholder. */
export function redactSecrets<T>(value: T, secrets: Record<string, string> | undefined): T {
  const pairs = Object.entries(secrets ?? {})
    .filter(([, v]) => v.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  if (pairs.length === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string')
      return pairs.reduce((s, [name, secret]) => s.split(secret).join(envRef(name)), v);
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
