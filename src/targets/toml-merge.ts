/**
 * Merge/unmerge tables in TOML files (Codex `config.toml`, `[mcp_servers.<name>]`).
 *
 * Strategy: edit the text so comments and unrelated formatting survive — append a
 * freshly stringified `[a.b]` section, or cut the lines of the `[a.b]` / `[a.b.*]`
 * sections. The edited text is re-parsed and compared with the expected document;
 * when that check fails (dotted keys, inline tables, headers inside multi-line
 * strings, ...) the whole document is re-stringified with smol-toml instead.
 *
 * Unmerge removes the table when it still contains every key/value palm wrote
 * (keys the user added are tolerated; a table whose palm-written values were
 * edited is left alone).
 */
import { parse, stringify } from 'smol-toml';
import { PalmError } from '../core/errors.js';
import type { MergedRecord } from '../core/types.js';
import { containsAll, deepEqual, isPlainObject } from './deep-equal.js';
import { atomicWrite, readTextOrUndefined } from './fs-utils.js';
import { formatPointer, parsePointer } from './json-pointer.js';

export interface TomlMergeOptions {
  dryRun: boolean;
  /** Existing table with different content: overwrite (default) or throw E_CONFLICT. */
  onConflict?: 'overwrite' | 'error';
  displayFile?: string;
}

type Table = Record<string, unknown>;

function parseToml(text: string, file: string): Table {
  if (text.trim() === '') return {};
  try {
    return parse(text) as Table;
  } catch (e) {
    throw new PalmError(
      'E_PARSE',
      `cannot parse ${file}: ${(e as Error).message}`,
      'fix the TOML syntax or move the file aside',
    );
  }
}

function getPath(doc: Table, p: readonly string[]): unknown {
  let node: unknown = doc;
  for (const seg of p) {
    if (!isPlainObject(node)) return undefined;
    node = node[seg];
  }
  return node;
}

function setPath(doc: Table, p: readonly string[], value: unknown, file: string): void {
  let node: Table = doc;
  p.slice(0, -1).forEach((seg, i) => {
    const child = node[seg];
    if (child === undefined) node[seg] = {};
    else if (!isPlainObject(child)) {
      throw new PalmError('E_PARSE', `${file}: ${p.slice(0, i + 1).join('.')} is not a table`);
    }
    node = node[seg] as Table;
  });
  node[p[p.length - 1]!] = value;
}

function deletePath(doc: Table, p: readonly string[]): void {
  const parent = getPath(doc, p.slice(0, -1));
  if (isPlainObject(parent)) delete parent[p[p.length - 1]!];
}

/** Drop ancestors of `p` that became empty tables (`mcp_servers = {}` after removing the last server). */
function pruneEmptyAncestors(doc: Table, p: readonly string[]): Table {
  for (let i = p.length - 1; i > 0; i--) {
    const node = getPath(doc, p.slice(0, i));
    if (isPlainObject(node) && Object.keys(node).length === 0) deletePath(doc, p.slice(0, i));
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

/** Parse a `[a."b".c]` or `[[a.b]]` header line; undefined for any other line. */
export function parseTomlHeader(line: string): TomlHeader | undefined {
  let s = line.trim();
  let array = false;
  if (s.startsWith('[[')) {
    array = true;
    s = s.slice(2);
  } else if (s.startsWith('[')) s = s.slice(1);
  else return undefined;
  const path: string[] = [];
  let i = 0;
  const skipWs = (): void => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  for (;;) {
    skipWs();
    if (s[i] === '"') {
      let j = i + 1;
      let buf = '"';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\') {
          buf += s[j]! + (s[j + 1] ?? '');
          j += 2;
          continue;
        }
        buf += s[j];
        j++;
      }
      if (j >= s.length) return undefined;
      try {
        path.push(JSON.parse(buf + '"') as string);
      } catch {
        return undefined;
      }
      i = j + 1;
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return undefined;
      path.push(s.slice(i + 1, j));
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return undefined;
      path.push(m[0]);
      i += m[0].length;
    }
    skipWs();
    if (s[i] === '.') {
      i++;
      continue;
    }
    break;
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
export function removeTableText(text: string, tablePath: readonly string[]): string {
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
  return joined.trim() === '' ? '' : joined.replace(/\s*$/, '') + '\n';
}

/** Append `[tablePath]` (stringified by smol-toml) after one blank line. */
export function appendTableText(text: string, tablePath: readonly string[], value: Table): string {
  const fragment = stringify(nest(tablePath, value));
  if (text.trim() === '') return fragment;
  return text.replace(/\n*$/, '\n') + '\n' + fragment;
}

/** Set table `tablePath` to `value` in `file`. Record pointer: `/<seg>/<seg>` (e.g. `/mcp_servers/fs`). */
export async function mergeTomlTable(
  file: string,
  tablePath: string[],
  value: Record<string, unknown>,
  opts: TomlMergeOptions,
): Promise<MergedRecord> {
  const text = (await readTextOrUndefined(file)) ?? '';
  const doc = parseToml(text, file);
  const current = getPath(doc, tablePath);
  const record: MergedRecord = { file, pointer: formatPointer(tablePath), value };
  if (deepEqual(current, value)) return record;
  if (current !== undefined && opts.onConflict === 'error') {
    throw new PalmError(
      'E_CONFLICT',
      `refusing to overwrite ${opts.displayFile ?? file} ([${tablePath.join('.')}] already exists with different content)`,
      'rerun with --force',
    );
  }
  const expected = structuredClone(doc);
  setPath(expected, tablePath, structuredClone(value), file);
  let next: string | undefined;
  try {
    const base = current === undefined ? text : removeTableText(text, tablePath);
    const candidate = appendTableText(base, tablePath, value);
    if (deepEqual(parse(candidate), expected)) next = candidate;
  } catch {
    next = undefined;
  }
  next ??= stringify(expected);
  if (!opts.dryRun) await atomicWrite(file, next);
  return record;
}

/** Remove the table recorded by `record` (pointer `/mcp_servers/<name>`). Missing file/table is a no-op. */
export async function unmergeTomlTable(file: string, record: MergedRecord): Promise<void> {
  const text = await readTextOrUndefined(file);
  if (text === undefined || text.trim() === '') return;
  const doc = parseToml(text, file);
  const tablePath = parsePointer(record.pointer);
  if (tablePath.length === 0) return;
  const current = getPath(doc, tablePath);
  if (current === undefined || !containsAll(current, record.value)) return;
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
  await atomicWrite(file, next);
}
