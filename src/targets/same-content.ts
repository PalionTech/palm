/**
 * Adoption compares meaning, not bytes (ruling Y13): a file already on disk that says what the
 * render says (frontmatter with the same data in any order or quoting, an empty key the same as
 * an absent one, a SKILL.md's `name` the same as its folder's name, a body that differs only
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

/** An empty value says what an absent key says (`description:` vs no description, ruling Y8'). */
function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/**
 * Frontmatter data as it means: keys with empty values dropped, and a SKILL.md's `name` dropped
 * when it is its folder's name, which the render adds when the source leaves it out (ruling T5).
 */
function meaningOf(data: Record<string, unknown>, file: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!isEmptyValue(v)) out[k] = v;
  const segs = file.split(/[\\/]/);
  if (segs.at(-1) === 'SKILL.md' && out.name === segs.at(-2)) delete out.name;
  return out;
}

function sameMarkdown(a: string, b: string, file: string): boolean {
  try {
    const x = parseFrontmatter(a.replace(/\r\n?/g, '\n'));
    const y = parseFrontmatter(b.replace(/\r\n?/g, '\n'));
    return (
      deepEqual(meaningOf(x.data, file), meaningOf(y.data, file)) &&
      normalizeLines(x.body) === normalizeLines(y.body)
    );
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
  if (/\.(md|mdc)$/i.test(file)) return sameMarkdown(a, b, file);
  if (/\.json$/i.test(file)) return sameJson(a, b);
  return normalizeLines(a) === normalizeLines(b);
}
