/**
 * YAML frontmatter (`---` fenced block at the top of a markdown file). Parsing tolerates what
 * real repositories contain: no frontmatter, CRLF, a BOM, duplicate keys, and invalid YAML such
 * as unquoted `: ` inside a description (recovered per key).
 */
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { isRecord, withoutUndefined } from './object.js';
import { normalizeText } from './text.js';
import { stringifyYaml } from './yaml.js';

export interface FrontmatterSplit {
  /** True when the text starts with a `---` block that is closed (`---` or `...`). */
  hasFrontmatter: boolean;
  /** Raw YAML between the fences ('' when absent). */
  raw: string;
  /** Text after the closing fence without leading blank lines; LF line endings. */
  body: string;
}

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

const OPEN_RE = /^---[ \t]*\n/;
const CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/m;
const KEY_LINE = /^([A-Za-z0-9_$][\w.$-]*)[ \t]*:(?:[ \t]|$)(.*)$/;

/** Splits `text` into raw frontmatter YAML and body; an unclosed fence counts as no frontmatter. */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const t = normalizeText(text);
  const open = OPEN_RE.exec(t);
  const rest = open ? t.slice(open[0].length) : '';
  const close = open ? CLOSE_RE.exec(rest) : null;
  if (!close) return { hasFrontmatter: false, raw: '', body: t };
  const body = rest.slice(close.index + close[0].length).replace(/^\n+/, '');
  return { hasFrontmatter: true, raw: rest.slice(0, close.index), body };
}

function unquote(s: string): string {
  const quoted = s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.endsWith(s[0]);
  return quoted ? s.slice(1, -1) : s;
}

/** A raw-text value for a key whose YAML did not parse: its lines joined, quotes removed. */
function rawValue(first: string, lines: string[]): unknown {
  const continuation = lines
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  const value = unquote(
    [first, ...continuation].filter((s) => s !== '' && s !== '|' && s !== '>').join(' '),
  );
  if (value === 'true' || value === 'false') return value === 'true';
  return value;
}

/** Top-level `key:` blocks of `raw`, each with its continuation lines. */
function keyBlocks(raw: string): Array<{ key: string; first: string; lines: string[] }> {
  const blocks: Array<{ key: string; first: string; lines: string[] }> = [];
  for (const line of raw.split('\n')) {
    const m = KEY_LINE.exec(line);
    if (m) blocks.push({ key: m[1] as string, first: (m[2] as string).trim(), lines: [line] });
    else blocks.at(-1)?.lines.push(line);
  }
  return blocks;
}

/** Parses each top-level key on its own, falling back to raw text where YAML fails. */
function lenientParse(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const b of keyBlocks(raw)) {
    try {
      const parsed: unknown = parse(b.lines.join('\n'), { uniqueKeys: false });
      if (isRecord(parsed) && b.key in parsed) {
        out[b.key] = parsed[b.key];
        continue;
      }
    } catch {
      // not valid YAML on its own: raw text below
    }
    out[b.key] = rawValue(b.first, b.lines);
  }
  return out;
}

/** `version: 1.10` parses as 1.1: restores the literal text of `version` and `metadata.version`. */
function recoverVersionText(raw: string, data: Record<string, unknown>): void {
  if (typeof data.version === 'number') {
    const m = /^version[ \t]*:[ \t]*([0-9][^\s#'"]*)/m.exec(raw);
    data.version = m?.[1] ?? String(data.version);
  }
  const meta = data.metadata;
  if (isRecord(meta) && typeof meta.version === 'number') {
    const block = /^metadata[ \t]*:[ \t]*\n((?:[ \t]+.*\n?)*)/m.exec(raw)?.[1] ?? '';
    const m = /^[ \t]+version[ \t]*:[ \t]*([0-9][^\s#'"]*)/m.exec(block);
    meta.version = m?.[1] ?? String(meta.version);
  }
}

/** Parses raw frontmatter YAML into a record ({} when empty or not a mapping). Never throws. */
export function parseFrontmatterYaml(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = parse(raw, { uniqueKeys: false, prettyErrors: false });
    data = isRecord(parsed) ? parsed : {};
  } catch {
    data = lenientParse(raw);
  }
  recoverVersionText(raw, data);
  return data;
}

/** Frontmatter data ({} when absent) and body of a markdown text. Never throws. */
export function parseFrontmatter(text: string): Frontmatter {
  const split = splitFrontmatter(text);
  return { data: split.hasFrontmatter ? parseFrontmatterYaml(split.raw) : {}, body: split.body };
}

/** Reads `file` and parses its frontmatter; fs errors propagate. */
export async function readFrontmatterFile(file: string): Promise<Frontmatter> {
  return parseFrontmatter(await readFile(file, 'utf8'));
}

/** LF line endings, no leading blank lines, exactly one trailing newline ('' stays ''). */
export function normalizeBody(body: string): string {
  const trimmed = normalizeText(body)
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd();
  return trimmed === '' ? '' : `${trimmed}\n`;
}

/** `---\n<yaml>\n---\n\n<body>` from ready YAML text; just the body when `yaml` is ''. */
export function withFrontmatter(yaml: string, body: string): string {
  const b = normalizeBody(body);
  const fm = yaml.replace(/\n+$/, '');
  if (fm === '') return b;
  return `---\n${fm}\n---\n${b === '' ? '' : `\n${b}`}`;
}

/**
 * `---\n<yaml>---\n\n<body>` with keys in the given order and undefined values dropped; the
 * body goes through `normalizeBody`. With no defined keys, just the body.
 */
export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const clean = withoutUndefined(data);
  return withFrontmatter(Object.keys(clean).length ? stringifyYaml(clean) : '', body);
}
