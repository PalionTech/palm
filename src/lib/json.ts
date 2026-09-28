/**
 * JSON text: parsing that ignores a BOM and optionally tolerates JSONC (comments and trailing
 * commas), and the one serialised form palm writes (2-space indent, trailing newline).
 */
import { stripBom } from './text.js';

/** A JSON string literal, unterminated ones included (they run to the end of the text). */
const STRING = /"[^"\\]*(?:\\[\s\S][^"\\]*)*(?:"|$)/.source;
const COMMENTS = new RegExp(`${STRING}|//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)`, 'g');
const TRAILING_COMMAS = new RegExp(`${STRING}|,(?=\\s*[}\\]])`, 'g');

/** `s` with every character except line breaks replaced by a space. */
function blank(s: string): string {
  return s.replace(/[^\r\n]/g, ' ');
}

/**
 * `text` with `//` and `/* *\/` comments outside strings blanked out. Line breaks are kept and
 * everything else is replaced by spaces, so parser error positions still point at the source.
 */
export function stripJsonComments(text: string): string {
  return text.replace(COMMENTS, (m) => (m.startsWith('"') ? m : blank(m)));
}

/** `text` with commas directly before `}` or `]` (outside strings) blanked out. Expects comment-free input. */
export function stripTrailingCommas(text: string): string {
  return text.replace(TRAILING_COMMAS, (m) => (m === ',' ? ' ' : m));
}

/**
 * Parses JSON text; a leading BOM is ignored. With `tolerant`, text that is not strict JSON is
 * retried with comments and trailing commas removed. Throws the parser's SyntaxError.
 */
export function parseJson<T = unknown>(text: string, opts: { tolerant?: boolean } = {}): T {
  const t = stripBom(text);
  try {
    return JSON.parse(t) as T;
  } catch (e) {
    if (!opts.tolerant) throw e;
    return JSON.parse(stripTrailingCommas(stripJsonComments(t))) as T;
  }
}

/** `value` as JSON with a 2-space indent and a trailing newline. */
export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Deterministic JSON for hashing: object keys sorted, undefined-valued keys dropped, no spaces. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
