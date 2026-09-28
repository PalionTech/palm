/**
 * Values palm records in the lockfile carry `${VAR}` placeholders instead of literal secret
 * values. These helpers compare such recorded values with what is on disk, and produce them.
 */
import { messageOf, PalmError } from '../core/errors.js';
import { parsePointer } from '../lib/json-pointer.js';
import { deepEqual, isRecord } from '../lib/object.js';
import { envRef, replacePlaceholders } from '../lib/placeholders.js';

/**
 * A recorded string matches the actual one when equal, or when the recorded string has
 * `${VAR}` placeholders and the actual string equals it with some text in their place.
 */
function recordedStringMatches(actual: string, recorded: string): boolean {
  if (actual === recorded) return true;
  const parts = replacePlaceholders(recorded, () => '\u0000').split('\u0000');
  if (parts.length === 1) return false;
  const re = new RegExp(
    `^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`,
  );
  return re.test(actual);
}

/** deepEqual, except that recorded strings may contain `${VAR}` placeholders (see recordedStringMatches). */
function matchesRecorded(actual: unknown, recorded: unknown): boolean {
  if (typeof actual === 'string' && typeof recorded === 'string')
    return recordedStringMatches(actual, recorded);
  if (Array.isArray(recorded)) {
    return (
      Array.isArray(actual) &&
      actual.length === recorded.length &&
      recorded.every((x, i) => matchesRecorded(actual[i], x))
    );
  }
  if (isRecord(actual) && isRecord(recorded)) {
    const ka = Object.keys(actual).filter((k) => actual[k] !== undefined);
    const kb = Object.keys(recorded).filter((k) => recorded[k] !== undefined);
    return (
      ka.length === kb.length &&
      kb.every((k) => Object.hasOwn(actual, k) && matchesRecorded(actual[k], recorded[k]))
    );
  }
  return deepEqual(actual, recorded);
}

/**
 * True when `actual` still holds everything palm inserted (`expected`): every key of
 * `expected` matches the same key in `actual` (placeholders in `expected` stand for
 * redacted secrets). Keys the user added are tolerated.
 */
export function containsAll(actual: unknown, expected: unknown): boolean {
  if (isRecord(actual) && isRecord(expected)) {
    return Object.keys(expected).every(
      (k) => expected[k] === undefined || matchesRecorded(actual[k], expected[k]),
    );
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
    if (typeof v === 'string')
      return pairs.reduce((s, [name, secret]) => s.split(secret).join(envRef(name)), v);
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Segments of a pointer read from the lockfile; a malformed one is E_INTERNAL. */
export function recordedPath(pointer: string): string[] {
  try {
    return parsePointer(pointer);
  } catch (e) {
    throw new PalmError('E_INTERNAL', messageOf(e));
  }
}
