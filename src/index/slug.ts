/** Canonical-name rules (Agent Skills spec): 1–64 chars of [a-z0-9-], no leading/trailing/double hyphen. */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MAX_SLUG_LENGTH = 64;

export function isValidSlug(s: string): boolean {
  return s.length >= 1 && s.length <= MAX_SLUG_LENGTH && SLUG_RE.test(s);
}

/**
 * Turn arbitrary text into a valid slug. Returns '' when nothing usable remains.
 *
 * `CSharpExpert` → `c-sharp-expert` (camelCase is split only when the input has no separators),
 * `Comment Sicko` → `comment-sicko`, `Thinking-Beast-Mode` → `thinking-beast-mode`.
 */
export function slugify(input: string): string {
  let s = input.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  if (!/[\s_.\-/]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s)) {
    s = s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2');
  }
  s = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (s.length > MAX_SLUG_LENGTH) s = s.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');
  return s;
}

/** Slug for `input`, or the first usable fallback, or 'unnamed'. */
export function toSlug(input: string | undefined, ...fallbacks: Array<string | undefined>): string {
  for (const candidate of [input, ...fallbacks]) {
    if (candidate === undefined) continue;
    if (isValidSlug(candidate)) return candidate;
    const s = slugify(candidate);
    if (s !== '') return s;
  }
  return 'unnamed';
}
