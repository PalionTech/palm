/**
 * JSON pointers (RFC 6901): segment escaping (`~` → `~0`, `/` → `~1`), parsing and formatting.
 * The root is `''`; `'/'` is read as the root too.
 */

/** `s` escaped for use as one pointer segment. */
export function escapeSegment(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** The inverse of `escapeSegment`. */
export function unescapeSegment(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** `''` or `'/'` → `[]`; `'/a/b~1c'` → `['a', 'b/c']`. Throws an Error when `pointer` does not start with `/`. */
export function parsePointer(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`);
  return pointer.slice(1).split('/').map(unescapeSegment);
}

/** The pointer for `segments` (`''` for none). */
export function formatPointer(segments: readonly string[]): string {
  return segments.length === 0 ? '' : `/${segments.map(escapeSegment).join('/')}`;
}

/** `pointer` extended by the segment `key`. */
export function joinPointer(pointer: string, key: string): string {
  return formatPointer([...parsePointer(pointer), key]);
}
