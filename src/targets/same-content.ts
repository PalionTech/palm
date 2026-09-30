/**
 * Adoption compares meaning, not bytes (ruling Y13): a file already on disk that says what the
 * render says (frontmatter with the same data in any order or quoting, a body that differs only
 * in line ends, trailing spaces or blank lines at either end, JSON with the same value) is
 * adopted, never a conflict. The Applier then writes palm's bytes, so the lock's render hash
 * matches the disk.
 */
import { parseFrontmatter } from '../lib/frontmatter.js';
import { parseJson } from '../lib/json.js';
import { deepEqual } from '../lib/object.js';

/** Text is a file without a NUL byte in its first 8 KB (git's heuristic). */
const TEXT_SNIFF_BYTES = 8192;

function isText(bytes: Uint8Array): boolean {
  return !bytes.subarray(0, TEXT_SNIFF_BYTES).includes(0);
}

/** LF line ends, no trailing spaces, no blank lines at either end. */
function normalizeLines(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function sameMarkdown(a: string, b: string): boolean {
  try {
    const x = parseFrontmatter(a.replace(/\r\n?/g, '\n'));
    const y = parseFrontmatter(b.replace(/\r\n?/g, '\n'));
    return deepEqual(x.data, y.data) && normalizeLines(x.body) === normalizeLines(y.body);
  } catch {
    return false;
  }
}

function sameJson(a: string, b: string): boolean {
  try {
    return deepEqual(parseJson(a), parseJson(b));
  } catch {
    return false;
  }
}

/** True when `existing` holds what `rendered` says for the file at `file` (its name decides how). */
export function sameContent(existing: Uint8Array, rendered: Uint8Array, file: string): boolean {
  if (Buffer.from(existing).equals(rendered)) return true;
  if (!isText(existing) || !isText(rendered)) return false;
  const a = Buffer.from(existing).toString('utf8');
  const b = Buffer.from(rendered).toString('utf8');
  if (/\.(md|mdc)$/i.test(file)) return sameMarkdown(a, b);
  if (/\.json$/i.test(file)) return sameJson(a, b);
  return normalizeLines(a) === normalizeLines(b);
}
