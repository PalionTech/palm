/** O1: git's line-end rule for text, behind every content hash palm compares. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contentHash, isBinary, lfText, sameContent, sha256 } from '../../src/lib/digest.js';

const bytes = (s: string) => Buffer.from(s, 'utf8');

describe('O1 lfText, contentHash, sameContent', () => {
  it('O1 turns CRLF into LF in text and leaves lone CRs alone', () => {
    expect(Buffer.from(lfText(bytes('a\r\nb\r\n'))).toString()).toBe('a\nb\n');
    expect(Buffer.from(lfText(bytes('a\rb\r\n\r'))).toString()).toBe('a\rb\n\r');
  });

  it('O1 returns content without CRLF as is', () => {
    const data = bytes('plain\n');
    expect(lfText(data)).toBe(data);
  });

  it('O1 leaves binary content untouched (a NUL in the first 8 KB)', () => {
    const data = Buffer.from([0x50, 0x00, 0x0d, 0x0a, 0x41]);
    expect(isBinary(data)).toBe(true);
    expect(lfText(data)).toBe(data);
  });

  it('O1 hashes CRLF and LF text alike, binary by its bytes', () => {
    expect(contentHash(bytes('x\r\ny\r\n'))).toBe(sha256('x\ny\n'));
    const bin = Buffer.from([0x00, 0x0d, 0x0a]);
    expect(contentHash(bin)).toBe(sha256(bin));
    expect(sameContent(bytes('x\r\n'), bytes('x\n'))).toBe(true);
    expect(sameContent(bytes('x\n'), bytes('y\n'))).toBe(false);
  });

  it('O1 lfText replaces each CRLF pair of text with LF in one pass', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', '\r', '\n', 'é', ' ')), (parts) => {
        const text = parts.join('');
        const out = Buffer.from(lfText(bytes(text))).toString();
        expect(out).toBe(text.replaceAll('\r\n', '\n'));
      }),
    );
  });
});
