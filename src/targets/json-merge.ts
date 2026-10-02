/**
 * Merge/unmerge single values into shared JSON config files (settings.json, hooks.json,
 * .mcp.json, mcp.json, ~/.claude.json, opencode.json), keyed by (path, key).
 *
 * - Missing file → `{}`. JSONC comments and trailing commas are tolerated on read; the file is
 *   written back as plain JSON with 2-space indent (comments are lost).
 * - Merges are pure text transforms (`appendItemText`, `setKeyText`, `ensureKeyText`): current
 *   text in, next text out (undefined when unchanged). The Applier (apply.ts) writes the result
 *   atomically and restores the file on failure.
 * - An array item is found by its fragment key (`fragmentKey(at, item)`: the identity fields of
 *   a hook entry, the string of an OpenCode instruction), an object key by its name. An item
 *   found by key with a different value is "changed", not "missing", so an edited hook is
 *   reported as modified and is never appended twice.
 * - `unmergeJsonFile` removes a fragment by (path, key) in place (undeploy).
 */

import { messageOf, PalmError } from '../core/errors.js';
import { fragmentKey } from '../domain/lock.js';
import type { MergedRecord, RecordState } from '../domain/merged-record.js';
import { parseJson, stringifyJson } from '../lib/json.js';
import { formatPointer } from '../lib/json-pointer.js';
import { deepEqual, isRecord } from '../lib/object.js';
import { atomicWrite, readTextOrUndefined, removeFileIfExists } from './fs-utils.js';
import { equivalentHookIndex } from './hook-equivalence.js';
import { matchesRendered } from './placeholder-match.js';

type JsonRecord = Extract<MergedRecord, { type: 'json-item' | 'json-key' }>;

/** One edit of a JSON file, for the pure text transforms. */
export interface JsonEdit {
  /** The file (for error messages). */
  file: string;
  /** Array path (`appendItemText`) or key path, last segment = the key (`setKeyText`, `ensureKeyText`). */
  path: readonly string[];
  /** `appendItemText`: the fragment key the item is found by (default: the value's own key). */
  key?: string;
  /**
   * `appendItemText`: palm wrote this item before (the lock lists it). When no item has its key,
   * the one item of the array with its matcher is palm's, changed on disk (D3): it is replaced
   * in place, never appended beside.
   */
  owned?: boolean;
  value: unknown;
  onConflict?: 'overwrite' | 'error';
  displayFile?: string;
  /**
   * `appendItemText`: called when no item has the key but one is an equivalent hook (O11): that
   * item is adopted (replaced by the value in place), never appended beside.
   */
  onAdopt?: () => void;
}

/** Parse a JSON object file's text (JSONC tolerated); `{}` when empty. */
function parseJsonObject(text: string | undefined, file: string): Record<string, unknown> {
  if (text === undefined || text.trim() === '') return {};
  let doc: unknown;
  try {
    doc = parseJson(text, { tolerant: true });
  } catch (e) {
    throw new PalmError(
      'E_PARSE',
      `cannot parse ${file}: ${messageOf(e)}`,
      'fix the JSON syntax or move the file aside',
    );
  }
  if (!isRecord(doc))
    throw new PalmError('E_PARSE', `${file}: expected a JSON object at the top level`);
  return doc;
}

/** Value at the path `segs`, or undefined. */
function getAt(doc: unknown, segs: readonly string[]): unknown {
  let node: unknown = doc;
  for (const seg of segs) {
    if (Array.isArray(node)) node = node[Number(seg)];
    else if (isRecord(node)) node = node[seg];
    else return undefined;
  }
  return node;
}

type Container = Record<string, unknown> | unknown[];

/** `node[seg]`, created when missing; undefined when it exists with the wrong container type. */
function childOf(
  node: Record<string, unknown>,
  seg: string,
  wantArray: boolean,
): Container | undefined {
  const child = node[seg];
  if (child === undefined || child === null) {
    const fresh: Container = wantArray ? [] : {};
    node[seg] = fresh;
    return fresh;
  }
  if (wantArray ? Array.isArray(child) : isRecord(child)) return child as Container;
  return undefined;
}

/** The container at `segs`, creating missing objects (and the final array when `lastIsArray`). */
function walkCreate(
  doc: Record<string, unknown>,
  segs: readonly string[],
  lastIsArray: boolean,
  file: string,
): Container {
  let node: Container = doc;
  segs.forEach((seg, i) => {
    if (Array.isArray(node)) {
      throw new PalmError(
        'E_PARSE',
        `${file}: ${formatPointer(segs.slice(0, i))} is an array, expected an object`,
      );
    }
    const wantArray = lastIsArray && i === segs.length - 1;
    const child = childOf(node, seg, wantArray);
    if (!child) {
      throw new PalmError(
        'E_PARSE',
        `${file}: expected ${wantArray ? 'an array' : 'an object'} at ${formatPointer(segs.slice(0, i + 1))}`,
      );
    }
    node = child;
  });
  return node;
}

/** Index of the item of `arr` (the array at `segs`) whose fragment key is `key`; -1 when none. */
function indexByKey(arr: readonly unknown[], segs: readonly string[], key: string): number {
  const at = formatPointer(segs);
  return arr.findIndex((item) => fragmentKey(at, item) === key);
}

function matcherOf(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  return typeof item.matcher === 'string' ? item.matcher : '';
}

/**
 * D3: the hook item palm wrote whose command was changed on disk, found by its matcher: the one
 * item of the array with the same matcher as `value` (-1 when none, or when several could be).
 */
function tamperedIndex(arr: readonly unknown[], value: unknown): number {
  const matcher = matcherOf(value);
  if (matcher === undefined) return -1;
  const hits = arr.flatMap((item, i) => (matcherOf(item) === matcher ? [i] : []));
  return hits.length === 1 ? (hits[0] as number) : -1;
}

function conflict(edit: JsonEdit, what: string): PalmError {
  return new PalmError(
    'E_CONFLICT',
    `refusing to overwrite ${edit.displayFile ?? edit.file} (${what} already exists with different content)`,
    'to overwrite it, run',
    { retryWith: '--force' },
  );
}

/** `arr` with `edit.value` adopting its equivalent hook (O11), or appended when none is. */
function appendOrAdopt(arr: unknown[], edit: JsonEdit): void {
  const same = equivalentHookIndex(arr, edit.value);
  if (same < 0) {
    arr.push(structuredClone(edit.value));
    return;
  }
  arr[same] = structuredClone(edit.value);
  edit.onAdopt?.();
}

/**
 * `text` with `edit.value` in the array at `edit.path`, found by its key: appended when no item
 * has the key (an equivalent hook is adopted in its place, O11), undefined when the item with
 * the key deep-equals the value, replaced in place when it differs (or E_CONFLICT with
 * `onConflict: 'error'`).
 */
export function appendItemText(text: string | undefined, edit: JsonEdit): string | undefined {
  if (edit.path.length === 0)
    throw new PalmError('E_INTERNAL', `cannot append to the root of ${edit.file}`);
  const doc = parseJsonObject(text, edit.file);
  const arr = walkCreate(doc, edit.path, true, edit.file) as unknown[];
  const key = edit.key ?? fragmentKey(formatPointer(edit.path), edit.value);
  const found = indexByKey(arr, edit.path, key);
  const idx = found < 0 && edit.owned ? tamperedIndex(arr, edit.value) : found;
  if (idx < 0) appendOrAdopt(arr, edit);
  else if (deepEqual(arr[idx], edit.value)) return undefined;
  else if (edit.onConflict === 'error')
    throw conflict(edit, `an entry of ${formatPointer(edit.path)}`);
  else arr[idx] = structuredClone(edit.value);
  return stringifyJson(doc);
}

/** The object holding the key `edit.path` names, and the key; missing objects are created. */
function keyParent(
  doc: Record<string, unknown>,
  edit: JsonEdit,
): { obj: Record<string, unknown>; key: string } {
  const key = edit.path.at(-1);
  if (key === undefined)
    throw new PalmError('E_INTERNAL', `cannot replace the root of ${edit.file}`);
  const obj = walkCreate(doc, edit.path.slice(0, -1), false, edit.file) as Record<string, unknown>;
  return { obj, key };
}

/**
 * `text` with the key at `edit.path` set to `edit.value`; undefined when it already holds it.
 * An existing different value is overwritten or, with `onConflict: 'error'`, refused (E_CONFLICT).
 */
export function setKeyText(text: string | undefined, edit: JsonEdit): string | undefined {
  const doc = parseJsonObject(text, edit.file);
  const { obj, key } = keyParent(doc, edit);
  const current = obj[key];
  if (deepEqual(current, edit.value)) return undefined;
  if (current !== undefined && edit.onConflict === 'error')
    throw conflict(edit, formatPointer(edit.path));
  obj[key] = structuredClone(edit.value);
  return stringifyJson(doc);
}

/** `text` with the key at `edit.path` set when it is missing; undefined when it exists. */
export function ensureKeyText(text: string | undefined, edit: JsonEdit): string | undefined {
  const doc = parseJsonObject(text, edit.file);
  const { obj, key } = keyParent(doc, edit);
  if (obj[key] !== undefined) return undefined;
  obj[key] = structuredClone(edit.value);
  return stringifyJson(doc);
}

/** What `rec` finds in `doc`: the item found by key (or, `owned`, by matcher: D3), or the key's value. */
function foundValue(doc: Record<string, unknown>, rec: JsonRecord, owned = false): unknown {
  const node = getAt(doc, rec.path);
  if (rec.type === 'json-key') return node;
  if (!Array.isArray(node)) return undefined;
  const found = indexByKey(node, rec.path, rec.key);
  const idx = found < 0 && owned ? tamperedIndex(node, rec.value) : found;
  return idx < 0 ? undefined : node[idx];
}

/**
 * Whether `text` holds the fragment `rec` names: `missing` when no item has its key (or the key
 * is absent), `held` when what is there matches the rendered value (`${VAR}` matching any
 * text), `changed` otherwise. A hook item palm wrote before (`owned`) whose command was changed
 * on disk is found by its matcher and is `changed` (D3). A file that no longer parses counts as
 * changed.
 */
export function jsonRecordState(
  text: string | undefined,
  rec: JsonRecord,
  owned = false,
): RecordState {
  if (text === undefined) return 'missing';
  let doc: Record<string, unknown>;
  try {
    doc = parseJsonObject(text, rec.file);
  } catch {
    return 'changed';
  }
  const found = foundValue(doc, rec, owned);
  if (found === undefined) return 'missing';
  return matchesRendered(found, rec.value) ? 'held' : 'changed';
}

/** What `text` holds for the fragment `rec` names; undefined when missing or unparseable. */
export function jsonRecordValue(text: string | undefined, rec: JsonRecord): unknown {
  if (text === undefined) return undefined;
  try {
    return foundValue(parseJsonObject(text, rec.file), rec);
  } catch {
    return undefined;
  }
}

/**
 * Remove the fragment `record` names, by key: the array item with its key (`json-item`) or the
 * object key (`json-key`). Containers left empty by the removal (`"SessionStart": []`,
 * `"hooks": {}`, `"mcpServers": {}`) are pruned, and a file that ends up as `{}` is deleted.
 * A missing file, path or key is a no-op.
 */
export async function unmergeJsonFile(file: string, record: JsonRecord): Promise<void> {
  const text = await readTextOrUndefined(file);
  if (text === undefined || text.trim() === '') return;
  const doc = parseJsonObject(text, file);
  const emptied = record.type === 'json-item' ? removeItem(doc, record) : removeKey(doc, record);
  if (!emptied) return;
  pruneEmptyContainers(doc, emptied);
  if (Object.keys(doc).length === 0) {
    await removeFileIfExists(file);
    return;
  }
  await atomicWrite(file, stringifyJson(doc));
}

/** Remove the item with the record's key from its array; the array path when removed. */
function removeItem(doc: Record<string, unknown>, record: JsonRecord): string[] | undefined {
  const node = getAt(doc, record.path);
  if (!Array.isArray(node)) return undefined;
  const idx = indexByKey(node, record.path, record.key);
  if (idx < 0) return undefined;
  node.splice(idx, 1);
  return record.path;
}

/** Delete the recorded key; the parent path when deleted. */
function removeKey(doc: Record<string, unknown>, record: JsonRecord): string[] | undefined {
  const parentPath = record.path.slice(0, -1);
  const parent = getAt(doc, parentPath);
  const key = record.path.at(-1);
  if (key === undefined || !isRecord(parent) || parent[key] === undefined) return undefined;
  delete parent[key];
  return parentPath;
}

function isEmptyContainer(node: unknown): boolean {
  return Array.isArray(node) ? node.length === 0 : isRecord(node) && Object.keys(node).length === 0;
}

/** Delete the container at `segs` and its ancestors while they are empty (never the root). */
function pruneEmptyContainers(doc: Record<string, unknown>, segs: readonly string[]): void {
  for (let i = segs.length; i > 0; i--) {
    if (!isEmptyContainer(getAt(doc, segs.slice(0, i)))) return;
    const parent = getAt(doc, segs.slice(0, i - 1));
    if (!isRecord(parent)) return;
    delete parent[segs[i - 1] as string];
  }
}
