/**
 * YAML frontmatter parsing that tolerates what real repositories contain:
 * no frontmatter, CRLF line endings, a BOM, folded/literal strings, duplicate keys, and
 * Claude-style descriptions with unquoted `: ` inside (invalid YAML) — the latter via a
 * per-key fallback parser.
 */

import YAML from 'yaml';
import { isRecord } from './util.js';

export interface FrontmatterSplit {
  /** True when the text starts with a `---` block that is closed. */
  hasFrontmatter: boolean;
  /** Raw YAML between the fences ('' when absent). */
  raw: string;
  /** Text after the closing fence, leading blank lines removed. LF line endings. */
  body: string;
}

const OPEN_RE = /^---[ \t]*\n/;
const CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/m;

/** Normalise line endings and strip a BOM. */
export function normalizeText(text: string): string {
  let t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (t.includes('\r')) t = t.replace(/\r\n?/g, '\n');
  return t;
}

export function splitFrontmatter(text: string): FrontmatterSplit {
  const t = normalizeText(text);
  const open = OPEN_RE.exec(t);
  if (!open) return { hasFrontmatter: false, raw: '', body: t };
  const rest = t.slice(open[0].length);
  // An immediately closing fence means empty frontmatter.
  const close = CLOSE_RE.exec(rest);
  if (!close) return { hasFrontmatter: false, raw: '', body: t };
  const raw = rest.slice(0, close.index);
  let body = rest.slice(close.index + close[0].length);
  body = body.replace(/^\n+/, '');
  return { hasFrontmatter: true, raw, body };
}

/** Parse frontmatter YAML into a plain object. Never throws. */
export function parseFrontmatterYaml(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = YAML.parse(raw, { uniqueKeys: false, prettyErrors: false });
    data = isRecord(parsed) ? parsed : {};
  } catch {
    data = lenientParse(raw);
  }
  recoverVersionText(raw, data);
  return data;
}

export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const split = splitFrontmatter(text);
  if (!split.hasFrontmatter) return { data: {}, body: split.body };
  return { data: parseFrontmatterYaml(split.raw), body: split.body };
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) clean[k] = v;
  const yaml = Object.keys(clean).length === 0 ? '' : YAML.stringify(clean, { lineWidth: 0 });
  return `---\n${yaml}---\n\n${normalizeText(body).replace(/^\n+/, '')}`;
}

// ---------------------------------------------------------------------------
// Fallback parser: split the block into top-level keys and parse each separately,
// falling back to the raw text for keys whose value is not valid YAML.
// ---------------------------------------------------------------------------

const KEY_LINE = /^([A-Za-z0-9_$][\w.$-]*)[ \t]*:(?:[ \t]|$)(.*)$/;

function lenientParse(raw: string): Record<string, unknown> {
  const blocks: Array<{ key: string; first: string; lines: string[] }> = [];
  for (const line of raw.split('\n')) {
    const m = KEY_LINE.exec(line);
    if (m && m[1] !== undefined) {
      blocks.push({ key: m[1], first: (m[2] ?? '').trim(), lines: [line] });
    } else if (line.startsWith('#') && blocks.length === 0) {
      continue;
    } else {
      const cur = blocks[blocks.length - 1];
      if (cur) cur.lines.push(line);
    }
  }
  const out: Record<string, unknown> = {};
  for (const b of blocks) {
    try {
      const parsed: unknown = YAML.parse(b.lines.join('\n'), { uniqueKeys: false });
      if (isRecord(parsed) && b.key in parsed) {
        out[b.key] = parsed[b.key];
        continue;
      }
    } catch {
      // fall through to raw text
    }
    const continuation = b.lines
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    let value = [b.first, ...continuation]
      .filter((s) => s !== '' && s !== '|' && s !== '>')
      .join(' ');
    value = unquote(value);
    out[b.key] = coerceScalar(value);
  }
  return out;
}

function unquote(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function coerceScalar(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

/**
 * YAML turns `version: 1.10` into the number 1.1. Recover the literal text for top-level
 * `version` and `metadata.version` so versions survive intact.
 */
function recoverVersionText(raw: string, data: Record<string, unknown>): void {
  if (typeof data.version === 'number') {
    const m = /^version[ \t]*:[ \t]*([0-9][^\s#'"]*)/m.exec(raw);
    data.version = m?.[1] ?? String(data.version);
  }
  const meta = data.metadata;
  if (isRecord(meta) && typeof meta.version === 'number') {
    const m = /^metadata[ \t]*:[ \t]*\n((?:[ \t]+.*\n?)*)/m.exec(raw);
    const vm = m?.[1] ? /^[ \t]+version[ \t]*:[ \t]*([0-9][^\s#'"]*)/m.exec(m[1]) : null;
    meta.version = vm?.[1] ?? String(meta.version);
  }
}
