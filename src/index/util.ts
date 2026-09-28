/** Small coercion and path helpers shared by the scanner modules. */

import { posix } from 'node:path';
import { isSlug, slugify } from '../lib/names.js';

/** Scalars become strings; everything else is undefined. Strings are trimmed; empty strings become undefined. */
export function asString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return undefined;
}

export function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === 'yes' || t === 'on') return true;
    if (t === 'false' || t === 'no' || t === 'off') return false;
  }
  return undefined;
}

/**
 * Normalise a list-ish frontmatter value.
 * - arrays: each scalar entry stringified
 * - strings: split on commas; when there is no comma and `whitespace` is true, split on whitespace
 *   (but never inside parentheses, so `Bash(git diff:*)` survives)
 */
export function asList(v: unknown, opts: { whitespace?: boolean } = {}): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const out = v.map((x) => asString(x)).filter((x): x is string => x !== undefined);
    return out;
  }
  const s = asString(v);
  if (s === undefined) return undefined;
  let parts = [s];
  if (s.includes(',')) parts = splitOutsideParens(s, ',');
  else if (opts.whitespace) parts = splitOutsideParens(s, ' ');
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

function splitOutsideParens(s: string, sep: ',' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    const isSep = sep === ',' ? ch === ',' : /\s/.test(ch);
    if (isSep && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Slug for `input`, or the first usable fallback, or 'unnamed'. */
export function toSlug(input: string | undefined, ...fallbacks: Array<string | undefined>): string {
  for (const candidate of [input, ...fallbacks]) {
    if (candidate === undefined) continue;
    if (isSlug(candidate)) return candidate;
    const s = slugify(candidate);
    if (s !== '') return s;
  }
  return 'unnamed';
}

/** Normalise a manifest-relative path: strip `./`, trailing `/`, collapse `.` segments. Returns '' for the root. */
export function normRel(p: string): string {
  const n = posix.normalize(p.replace(/\\/g, '/'));
  if (n === '.' || n === './' || n === '') return '';
  return n.replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Join relative posix paths, returning '' for the root. */
export function joinRel(...parts: string[]): string {
  return normRel(posix.join(...parts.map((p) => (p === '' ? '.' : p))));
}

/** True when `rel` escapes its base (`..`) or is absolute. */
export function escapesRoot(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel);
}

/** Parent directory of a relative path ('' for top-level entries). */
export function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

export function baseOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? rel : rel.slice(i + 1);
}

/** Number of directory levels of a relative file path (`a/b/c.md` → 2). */
export function dirDepth(rel: string): number {
  if (rel === '') return 0;
  return rel.split('/').length - 1;
}

/**
 * True when `rel` equals `dir` or lies underneath it ('' contains everything). For origin-relative
 * posix paths; absolute paths use `isWithin` from lib/fs (much slower in the scanner's loops).
 */
export function isWithinRel(rel: string, dir: string): boolean {
  if (dir === '') return true;
  return rel === dir || rel.startsWith(`${dir}/`);
}

/** Display form of a relative directory: '' → '.'. */
export function displayRel(rel: string): string {
  return rel === '' ? '.' : rel;
}

export const GLOB_CHARS = /[*?[\]{}!]/;

export function hasGlobChars(p: string): boolean {
  return GLOB_CHARS.test(p);
}

/** Semver-looking tag → version string without a leading `v`. */
export function versionFromTag(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const m = /^v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)$/.exec(ref.trim());
  return m ? m[1] : undefined;
}
