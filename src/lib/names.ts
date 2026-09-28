/**
 * Name rules: canonical slugs (Agent Skills spec), safe single path segments, origin aliases
 * and file stems.
 */
import { basename } from 'node:path';

/** A slug: lowercase letters and digits in runs joined by single hyphens. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest slug `slugify` produces and `isSlug` accepts. */
export const MAX_SLUG_LENGTH = 64;

/** An alias: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit. */
export const ALIAS_RE = /^[a-z0-9][a-z0-9._-]*$/;

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `s` matches SLUG_RE and has at most MAX_SLUG_LENGTH characters. */
export function isSlug(s: string): boolean {
  return s.length <= MAX_SLUG_LENGTH && SLUG_RE.test(s);
}

/** `CSharpExpert` → `CSharp-Expert`: splits camelCase words with a hyphen. */
function splitCamel(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2');
}

/**
 * A slug for arbitrary text, or '' when nothing usable remains. Accents are dropped, camelCase
 * is split only when the text has no separators, runs of anything else become one hyphen,
 * and the result is cut to MAX_SLUG_LENGTH. Idempotent: `slugify(slugify(x)) === slugify(x)`.
 */
export function slugify(text: string): string {
  let s = text.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  if (!/[\s_./-]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s)) s = splitCamel(s);
  s = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > MAX_SLUG_LENGTH ? s.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '') : s;
}

/**
 * True when `s` is safe as one path segment: a letter or digit, then letters, digits, `.`, `_`
 * and `-`, never containing `..`. So never `.`, `..`, empty, `/`, `\` or NUL. Every name that
 * becomes a file or directory name must pass this.
 */
export function isSafeName(s: string): boolean {
  return SAFE_NAME_RE.test(s) && !s.includes('..');
}

/** True when `s` matches ALIAS_RE. */
export function isValidAlias(s: string): boolean {
  return ALIAS_RE.test(s);
}

/**
 * Basename of `file` without the longest of `exts` it ends with (case-insensitive), so
 * `a.agent.md` with ['.md', '.agent.md'] gives `a`. No match: the whole basename.
 */
export function stemOf(file: string, exts: readonly string[]): string {
  const base = basename(file);
  const lower = base.toLowerCase();
  const ext = [...exts]
    .sort((a, b) => b.length - a.length)
    .find((e) => e !== '' && lower.endsWith(e.toLowerCase()));
  return ext === undefined ? base : base.slice(0, base.length - ext.length);
}
