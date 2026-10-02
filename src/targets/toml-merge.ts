/**
 * Merge/unmerge tables in TOML files (Codex `config.toml`, `[mcp_servers.<name>]`).
 *
 * Strategy: edit the text so comments and unrelated formatting survive — append a
 * freshly stringified `[a.b]` section, or cut the lines of the `[a.b]` / `[a.b.*]`
 * sections. The edited text is re-parsed and compared with the expected document;
 * when that check fails (dotted keys, inline tables, headers inside multi-line
 * strings, ...) the whole document is re-stringified with smol-toml instead.
 *
 * A table is found by its path (`['mcp_servers', <name>]`, the fragment's key is the name).
 * Unmerge removes it by that path; whether the user changed it is decided before undeploy,
 * from the lock's render hash.
 *
 * `mergeTableText` is the pure merge (text in, next text out) the Applier writes;
 * `unmergeTomlTable` edits the file in place (undeploy).
 */
import { parse, stringify } from 'smol-toml';
import { messageOf, PalmError } from '../core/errors.js';
import type { MergedRecord, RecordState } from '../domain/merged-record.js';
import { deepEqual, isRecord } from '../lib/object.js';
import { atomicWrite, readTextOrUndefined, removeFileIfExists } from './fs-utils.js';
import { matchesRendered } from './placeholder-match.js';

type TomlTableRecord = Extract<MergedRecord, { type: 'toml-table' }>;

type Table = Record<string, unknown>;

function parseToml(text: string, file: string): Table {
  if (text.trim() === '') return {};
  try {
    return parse(text) as Table;
  } catch (e) {
    throw new PalmError(
      'E_PARSE',
      `cannot parse ${file}: ${messageOf(e)}`,
      'fix the TOML syntax or move the file aside',
    );
  }
}

function getPath(doc: Table, p: readonly string[]): unknown {
  let node: unknown = doc;
  for (const seg of p) {
    if (!isRecord(node)) return undefined;
    node = node[seg];
  }
  return node;
}

function setPath(doc: Table, p: readonly string[], value: unknown, file: string): void {
  let node: Table = doc;
  p.slice(0, -1).forEach((seg, i) => {
    const child = node[seg];
    if (child === undefined) node[seg] = {};
    else if (!isRecord(child)) {
      throw new PalmError('E_PARSE', `${file}: ${p.slice(0, i + 1).join('.')} is not a table`);
    }
    node = node[seg] as Table;
  });
  node[p.at(-1) as string] = value;
}

function deletePath(doc: Table, p: readonly string[]): void {
  const parent = getPath(doc, p.slice(0, -1));
  if (isRecord(parent)) delete parent[p.at(-1) as string];
}

/** Drop ancestors of `p` that became empty tables (`mcp_servers = {}` after removing the last server). */
function pruneEmptyAncestors(doc: Table, p: readonly string[]): Table {
  for (let i = p.length - 1; i > 0; i--) {
    const node = getPath(doc, p.slice(0, i));
    if (isRecord(node) && Object.keys(node).length === 0) deletePath(doc, p.slice(0, i));
    else break;
  }
  return doc;
}

function nest(p: readonly string[], value: unknown): Table {
  return p.reduceRight<unknown>((acc, seg) => ({ [seg]: acc }), value) as Table;
}

export interface TomlHeader {
  path: string[];
  array: boolean;
}

function skipWs(s: string, i: number): number {
  let j = i;
  while (s[j] === ' ' || s[j] === '\t') j++;
  return j;
}

/** A `"basic"` key starting at `s[i]`, with its escapes decoded. */
function readBasicKey(s: string, i: number): { seg: string; end: number } | undefined {
  let j = i + 1;
  while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
  if (j >= s.length) return undefined;
  try {
    return { seg: JSON.parse(s.slice(i, j + 1)) as string, end: j + 1 };
  } catch {
    return undefined;
  }
}

/** One dotted-key segment starting at `s[i]`: bare, `"basic"` or `'literal'`. */
function readKey(s: string, i: number): { seg: string; end: number } | undefined {
  if (s[i] === '"') return readBasicKey(s, i);
  if (s[i] === "'") {
    const j = s.indexOf("'", i + 1);
    return j < 0 ? undefined : { seg: s.slice(i + 1, j), end: j + 1 };
  }
  const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
  return m ? { seg: m[0], end: i + m[0].length } : undefined;
}

/** Parse a `[a."b".c]` or `[[a.b]]` header line; undefined for any other line. */
export function parseTomlHeader(line: string): TomlHeader | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[')) return undefined;
  const array = trimmed.startsWith('[[');
  const s = trimmed.slice(array ? 2 : 1);
  const path: string[] = [];
  let i = skipWs(s, 0);
  for (;;) {
    const key = readKey(s, i);
    if (!key) return undefined;
    path.push(key.seg);
    i = skipWs(s, key.end);
    if (s[i] !== '.') break;
    i = skipWs(s, i + 1);
  }
  const close = array ? ']]' : ']';
  if (!s.startsWith(close, i)) return undefined;
  const rest = s.slice(i + close.length).trim();
  if (rest !== '' && !rest.startsWith('#')) return undefined;
  return { path, array };
}

function hasPrefix(p: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= p.length && prefix.every((seg, i) => p[i] === seg);
}

/** Cut the `[prefix]` and `[prefix.*]` sections (header through the line before the next foreign header). */
function removeTableText(text: string, tablePath: readonly string[]): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let removing = false;
  let removed = false;
  for (const line of lines) {
    const h = parseTomlHeader(line);
    if (h) removing = hasPrefix(h.path, tablePath);
    if (removing) {
      removed = true;
      continue;
    }
    out.push(line);
  }
  if (!removed) return text;
  const joined = out.join('\n');
  return joined.trim() === '' ? '' : `${joined.replace(/\s*$/, '')}\n`;
}

/** Append `[tablePath]` (stringified by smol-toml) after one blank line. */
function appendTableText(text: string, tablePath: readonly string[], value: Table): string {
  const fragment = stringify(nest(tablePath, value));
  if (text.trim() === '') return fragment;
  return `${text.replace(/\n*$/, '\n')}\n${fragment}`;
}

/** One table merge, for `mergeTableText`. */
export interface TomlEdit {
  /** The file (for error messages). */
  file: string;
  /** `['mcp_servers', name]`. */
  path: readonly string[];
  value: Record<string, unknown>;
  onConflict?: 'overwrite' | 'error';
  displayFile?: string;
}

/** The text edit (append, or cut and append) when it parses to `expected`; else a full re-stringify. */
function mergedText(text: string, edit: TomlEdit, replace: boolean, expected: Table): string {
  try {
    const base = replace ? removeTableText(text, edit.path) : text;
    const candidate = appendTableText(base, edit.path, edit.value);
    if (deepEqual(parse(candidate), expected)) return candidate;
  } catch {
    // fall through to the whole-document rewrite
  }
  return stringify(expected);
}

/**
 * `text` with table `edit.path` set to `edit.value`; undefined when it already holds it. An
 * existing different table is replaced or, with `onConflict: 'error'`, refused (E_CONFLICT).
 */
export function mergeTableText(text: string | undefined, edit: TomlEdit): string | undefined {
  const src = text ?? '';
  const doc = parseToml(src, edit.file);
  const current = getPath(doc, edit.path);
  if (deepEqual(current, edit.value)) return undefined;
  if (current !== undefined && edit.onConflict === 'error') {
    throw new PalmError(
      'E_CONFLICT',
      `refusing to overwrite ${edit.displayFile ?? edit.file} ([${edit.path.join('.')}] already exists with different content)`,
      'to overwrite it, run',
      { retryWith: '--force' },
    );
  }
  const expected = structuredClone(doc);
  setPath(expected, edit.path, structuredClone(edit.value), edit.file);
  return mergedText(src, edit, current !== undefined, expected);
}

/**
 * Whether `text` holds the table `rec` names: `missing` when absent, `held` when it matches the
 * rendered value (`${VAR}` matching any text), `changed` otherwise (an unparseable file too).
 */
export function tomlRecordState(text: string | undefined, rec: TomlTableRecord): RecordState {
  if (text === undefined) return 'missing';
  let current: unknown;
  try {
    current = getPath(parseToml(text, rec.file), rec.path);
  } catch {
    return 'changed';
  }
  if (current === undefined) return 'missing';
  return matchesRendered(current, rec.value) ? 'held' : 'changed';
}

/** The table `rec` names in `text`; undefined when absent or unparseable. */
export function tomlRecordValue(text: string | undefined, rec: TomlTableRecord): unknown {
  if (text === undefined) return undefined;
  try {
    return getPath(parseToml(text, rec.file), rec.path);
  } catch {
    return undefined;
  }
}

/**
 * Remove the table `record` names (`['mcp_servers', name]`); a file left empty is deleted.
 * Missing file/table is a no-op.
 */
export async function unmergeTomlTable(file: string, record: TomlTableRecord): Promise<void> {
  const text = await readTextOrUndefined(file);
  if (text === undefined || text.trim() === '') return;
  const doc = parseToml(text, file);
  const tablePath = record.path;
  if (tablePath.length === 0) return;
  if (getPath(doc, tablePath) === undefined) return;
  const expected = structuredClone(doc);
  deletePath(expected, tablePath);
  pruneEmptyAncestors(expected, tablePath);
  let next: string | undefined;
  try {
    const candidate = removeTableText(text, tablePath);
    const actual = candidate.trim() === '' ? {} : (parse(candidate) as Table);
    if (
      deepEqual(
        pruneEmptyAncestors(actual, tablePath),
        pruneEmptyAncestors(structuredClone(expected), tablePath),
      )
    )
      next = candidate;
  } catch {
    next = undefined;
  }
  next ??= stringify(expected);
  // A file left with nothing in it (palm created it, or the user's last table went) is deleted.
  if (next.trim() === '') await removeFileIfExists(file);
  else await atomicWrite(file, next);
}
