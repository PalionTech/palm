/** Content digests in palm's one textual form, `sha256:<64 hex>`, and git's line-end rule for text. */
import { createHash } from 'node:crypto';

/** sha256 of `data` (a string is hashed as UTF-8) as `sha256:<hex>`. */
export function sha256(data: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/** The first `n` hex digits of a digest: `sha256:a7cc7911…` → `a7cc7911`; a bare hex string works too. */
export function short(hash: string, n = 8): string {
  return hash.replace(/^sha256:/, '').slice(0, n);
}

/** Text is content without a NUL byte in its first 8 KB (git's heuristic). */
const TEXT_SNIFF_BYTES = 8192;

const CR = 0x0d;
const LF = 0x0a;

/** True when `data` is binary by git's heuristic: a NUL byte in its first 8 KB. */
export function isBinary(data: Uint8Array): boolean {
  return data.subarray(0, TEXT_SNIFF_BYTES).includes(0);
}

/** True when `data` holds a CRLF pair. */
function hasCrlf(data: Uint8Array): boolean {
  for (let i = data.indexOf(CR); i >= 0; i = data.indexOf(CR, i + 1))
    if (data[i + 1] === LF) return true;
  return false;
}

/**
 * `data` with CRLF line ends turned into LF when it is text (git's convention, what a
 * `text=auto eol=lf` clean filter commits). Binary content and lone CRs are left alone; content
 * without a CRLF pair is returned as is.
 */
export function lfText(data: Uint8Array): Uint8Array {
  if (!hasCrlf(data) || isBinary(data)) return data;
  const out = Buffer.allocUnsafe(data.byteLength);
  let n = 0;
  for (let i = 0; i < data.byteLength; i++)
    if (data[i] !== CR || data[i + 1] !== LF) out[n++] = data[i] as number;
  return out.subarray(0, n);
}

/** sha256 of `data` with text line ends normalised to LF (`lfText`): how palm hashes a file's content. */
export function contentHash(data: Uint8Array): string {
  return sha256(lfText(data));
}

/** True when `a` and `b` hold the same content once text line ends are normalised to LF. */
export function sameContent(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(lfText(a)).equals(Buffer.from(lfText(b)));
}
