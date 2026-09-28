/**
 * Merge/unmerge single values into shared JSON config files (settings.json,
 * hooks.json, .mcp.json, mcp.json, ~/.claude.json).
 *
 * - Missing file → `{}`. JSONC comments and trailing commas are tolerated on read;
 *   the file is written back as plain JSON with 2-space indent (comments are lost).
 * - Writes are atomic (temp + rename) and skipped when nothing changed.
 * - The returned record carries the absolute `file`; callers convert it to the lock form
 *   (scope-relative for project scope). `appendJsonItem` gives a `json-item` record (the
 *   path names the array, `value` is the item), `setJsonKey` a `json-key` record (the path
 *   names the key itself, `/mcpServers/<name>`).
 */

import { messageOf, PalmError } from '../core/errors.js';
import type { JsonItemRecord, JsonKeyRecord, JsonRecord } from '../domain/merged-record.js';
import { parseJson, stringifyJson } from '../lib/json.js';
import { formatPointer } from '../lib/json-pointer.js';
import { deepEqual, isRecord } from '../lib/object.js';
import { atomicWrite, readTextOrUndefined, removeFileIfExists } from './fs-utils.js';
import { containsAll } from './recorded.js';

export interface JsonMergeOptions {
  dryRun: boolean;
  /** Existing object key with a different value: overwrite (default) or throw E_CONFLICT. */
  onConflict?: 'overwrite' | 'error';
  /** Name used in error messages (defaults to `file`). */
  displayFile?: string;
}

/** Read a JSON object file (JSONC tolerated); `{}` when missing or empty. */
async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  const text = await readTextOrUndefined(file);
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

/**
 * Append `item` to the array at `arrayPath` unless a deep-equal item is already there.
 * Missing intermediate objects and the array itself are created.
 */
export async function appendJsonItem(
  file: string,
  arrayPath: readonly string[],
  item: unknown,
  opts: JsonMergeOptions,
): Promise<JsonItemRecord> {
  if (arrayPath.length === 0)
    throw new PalmError('E_INTERNAL', `cannot append to the root of ${file}`);
  const doc = await readJsonObject(file);
  const arr = walkCreate(doc, arrayPath, true, file) as unknown[];
  if (!arr.some((x) => deepEqual(x, item))) {
    arr.push(structuredClone(item));
    if (!opts.dryRun) await atomicWrite(file, stringifyJson(doc));
  }
  return { type: 'json-item', file, path: [...arrayPath], value: item };
}

/**
 * Set the object key at `keyPath` (last segment = the key) to `value`. Missing intermediate
 * objects are created; an existing different value is overwritten or, with
 * `onConflict: 'error'`, refused with E_CONFLICT.
 */
export async function setJsonKey(
  file: string,
  keyPath: readonly string[],
  value: unknown,
  opts: JsonMergeOptions,
): Promise<JsonKeyRecord> {
  const key = keyPath.at(-1);
  if (key === undefined) throw new PalmError('E_INTERNAL', `cannot replace the root of ${file}`);
  const doc = await readJsonObject(file);
  const obj = walkCreate(doc, keyPath.slice(0, -1), false, file) as Record<string, unknown>;
  const current = obj[key];
  if (!deepEqual(current, value)) {
    if (current !== undefined && opts.onConflict === 'error') {
      throw new PalmError(
        'E_CONFLICT',
        `refusing to overwrite ${opts.displayFile ?? file} (${formatPointer(keyPath)} already exists with different content)`,
        'rerun with --force',
      );
    }
    obj[key] = structuredClone(value);
    if (!opts.dryRun) await atomicWrite(file, stringifyJson(doc));
  }
  return { type: 'json-key', file, path: [...keyPath], value };
}

/** Set the object key at `keyPath` only when it is missing. Not recorded (never removed by unmerge). */
export async function ensureJsonKey(
  file: string,
  keyPath: readonly string[],
  value: unknown,
  opts: { dryRun: boolean },
): Promise<boolean> {
  const key = keyPath.at(-1);
  if (key === undefined) throw new PalmError('E_INTERNAL', `cannot replace the root of ${file}`);
  const doc = await readJsonObject(file);
  const obj = walkCreate(doc, keyPath.slice(0, -1), false, file) as Record<string, unknown>;
  if (obj[key] !== undefined) return false;
  obj[key] = structuredClone(value);
  if (!opts.dryRun) await atomicWrite(file, stringifyJson(doc));
  return true;
}

/**
 * Remove what `record` inserted. `json-item` → the first deep-equal item of the array is
 * removed. `json-key` → the key is deleted when its current value still contains everything
 * palm wrote (keys the user added are tolerated; values the user changed are kept).
 * Containers left empty by the removal (`"SessionStart": []`, `"hooks": {}`,
 * `"mcpServers": {}`) are pruned, and a file that ends up as `{}` is deleted.
 * Missing file/path is a no-op.
 */
export async function unmergeJsonFile(file: string, record: JsonRecord): Promise<void> {
  const text = await readTextOrUndefined(file);
  if (text === undefined || text.trim() === '') return;
  const doc = await readJsonObject(file);
  const emptied = record.type === 'json-item' ? removeItem(doc, record) : removeKey(doc, record);
  if (!emptied) return;
  pruneEmptyContainers(doc, emptied);
  if (Object.keys(doc).length === 0) {
    await removeFileIfExists(file);
    return;
  }
  await atomicWrite(file, stringifyJson(doc));
}

/** Remove the recorded item from its array; the array path when something was removed. */
function removeItem(doc: Record<string, unknown>, record: JsonItemRecord): string[] | undefined {
  const node = getAt(doc, record.path);
  if (!Array.isArray(node)) return undefined;
  const idx = node.findIndex((item) => deepEqual(item, record.value));
  if (idx < 0) return undefined;
  node.splice(idx, 1);
  return record.path;
}

/** Delete the recorded key if it still holds palm's value; the parent path when deleted. */
function removeKey(doc: Record<string, unknown>, record: JsonKeyRecord): string[] | undefined {
  const parentPath = record.path.slice(0, -1);
  const parent = getAt(doc, parentPath);
  const key = record.path.at(-1);
  if (key === undefined || !isRecord(parent)) return undefined;
  const node = parent[key];
  if (node === undefined || !containsAll(node, record.value)) return undefined;
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
