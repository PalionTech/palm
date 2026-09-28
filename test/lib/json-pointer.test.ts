import { describe, expect, it } from 'vitest';
import {
  escapeSegment,
  formatPointer,
  joinPointer,
  parsePointer,
  unescapeSegment,
} from '../../src/lib/json-pointer.js';

describe('json pointers', () => {
  it('escapes ~ and / in segments (RFC 6901) and back', () => {
    expect(escapeSegment('a/b~c')).toBe('a~1b~0c');
    expect(unescapeSegment('a~1b~0c')).toBe('a/b~c');
    expect(unescapeSegment('~01')).toBe('~1');
  });

  it('parses and formats pointers; the root is "" (or "/")', () => {
    expect(parsePointer('')).toEqual([]);
    expect(parsePointer('/')).toEqual([]);
    expect(parsePointer('/mcpServers/a~1b')).toEqual(['mcpServers', 'a/b']);
    expect(formatPointer([])).toBe('');
    expect(formatPointer(['hooks', 'Pre/Tool'])).toBe('/hooks/Pre~1Tool');
    expect(parsePointer(formatPointer(['x~', '', 'y/z']))).toEqual(['x~', '', 'y/z']);
  });

  it('joins a key onto a pointer', () => {
    expect(joinPointer('', 'a')).toBe('/a');
    expect(joinPointer('/mcpServers', 'my/server')).toBe('/mcpServers/my~1server');
  });

  it('rejects a pointer that does not start with /', () => {
    expect(() => parsePointer('mcpServers')).toThrowError('invalid JSON pointer: mcpServers');
  });
});
