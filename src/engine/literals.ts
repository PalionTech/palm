/**
 * Y15': the literal values a `--secrets literal` render wrote. The render carries `${VAR}` where
 * a secret goes; a fragment on disk that matches it with some text in each placeholder's place
 * yields that text per variable, so the disk can be hashed as the literal render palm wrote
 * (the lock's render hash covers the variable names, never the values) and a policy change is
 * never taken for the person's edit.
 */

import { deepEqual, isRecord } from '../lib/object.js';

type Values = Record<string, string>;

/** Characters a regular expression gives meaning to. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** Adds `value` for `name`; false when `name` already stands for another value. */
function put(out: Values, name: string, value: string): boolean {
  if (out[name] !== undefined && out[name] !== value) return false;
  out[name] = value;
  return true;
}

/** Every harness's reference form: `${VAR}`, `${env:VAR}`, `${VAR:-x}` and OpenCode's `{env:VAR}`. */
const REFERENCE =
  /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The references in `text` (name and text) and the literal parts between them. */
function references(text: string): { refs: Array<{ name: string; raw: string }>; parts: string[] } {
  const refs: Array<{ name: string; raw: string }> = [];
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(REFERENCE)) {
    parts.push(text.slice(last, m.index));
    refs.push({ name: (m[1] ?? m[2]) as string, raw: m[0] });
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return { refs, parts };
}

function stringValues(actual: string, expected: string, out: Values): boolean {
  const { refs, parts } = references(expected);
  if (!refs.length) return actual === expected;
  const pattern = parts.map((p) => p.replace(REGEX_SPECIAL, '\\$&')).join('([\\s\\S]*)');
  const m = new RegExp(`^${pattern}$`).exec(actual);
  if (!m) return false;
  return refs.every((r, i) => {
    const value = m[i + 1] ?? '';
    return value === r.raw || put(out, r.name, value);
  });
}

function listValues(actual: unknown, expected: unknown[], out: Values): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((x, i) => valuesIn(actual[i], x, out));
}

function recordValues(actual: unknown, expected: Record<string, unknown>, out: Values): boolean {
  if (!isRecord(actual)) return false;
  const keys = Object.keys(expected).filter((k) => expected[k] !== undefined);
  const extra = Object.keys(actual).filter((k) => actual[k] !== undefined && !keys.includes(k));
  return !extra.length && keys.every((k) => valuesIn(actual[k], expected[k], out));
}

/**
 * True when `actual` is `expected` with some text in place of each `${VAR}`; that text is
 * added to `out` per variable (a placeholder left as it is adds nothing).
 */
export function valuesIn(actual: unknown, expected: unknown, out: Values): boolean {
  if (typeof actual === 'string' && typeof expected === 'string')
    return stringValues(actual, expected, out);
  if (Array.isArray(expected)) return listValues(actual, expected, out);
  if (isRecord(expected)) return recordValues(actual, expected, out);
  return deepEqual(actual, expected);
}
