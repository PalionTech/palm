import { PalmError } from '../core/errors.js';

/** RFC 6901 segment escaping. */
export function escapeSegment(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapeSegment(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** "" or "/" → []; "/a/b~1c" → ["a", "b/c"]. */
export function parsePointer(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  if (!pointer.startsWith('/'))
    throw new PalmError('E_INTERNAL', `invalid JSON pointer: ${pointer}`);
  return pointer.slice(1).split('/').map(unescapeSegment);
}

export function formatPointer(segments: readonly string[]): string {
  return segments.length === 0 ? '' : '/' + segments.map(escapeSegment).join('/');
}

export function joinPointer(pointer: string, key: string): string {
  return formatPointer([...parsePointer(pointer), key]);
}
