/** Content digests in palm's one textual form, `sha256:<64 hex>`. */
import { createHash } from 'node:crypto';

/** sha256 of `data` (a string is hashed as UTF-8) as `sha256:<hex>`. */
export function sha256(data: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/** The first `n` hex digits of a digest: `sha256:a7cc7911…` → `a7cc7911`; a bare hex string works too. */
export function short(hash: string, n = 8): string {
  return hash.replace(/^sha256:/, '').slice(0, n);
}
