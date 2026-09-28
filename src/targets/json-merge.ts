/**
 * Merge/unmerge single values into shared JSON config files (settings.json,
 * hooks.json, .mcp.json, mcp.json, ~/.claude.json).
 *
 * - Missing file → `{}`. JSONC comments and trailing commas are tolerated on read;
 *   the file is written back as plain JSON with 2-space indent (comments are lost).
 * - Writes are atomic (temp + rename) and skipped when nothing changed.
 * - The returned MergedRecord carries the absolute `file`; callers convert it to
 *   the lock form (scope-relative for project scope).
 * - Pointer semantics of the record: for array appends (`key === undefined`) the
 *   pointer names the array and `value` is the item; for object keys the pointer
 *   names the key itself (`/mcpServers/<name>`).
 */

import { messageOf, PalmError } from '../core/errors.js';
import type { MergedRecord } from '../core/types.js';
import { parseJson, stringifyJson } from '../lib/json.js';
import { formatPointer, joinPointer, parsePointer } from '../lib/json-pointer.js';
import { deepEqual, isRecord } from '../lib/object.js';
import { atomicWrite, readTextOrUndefined, removeFileIfExists } from './fs-utils.js';
import { containsAll, recordedPath } from './recorded.js';

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

/** Value at `pointer`, or undefined. */
function getAtPointer(doc: unknown, pointer: string): unknown {
  let node: unknown = doc;
  for (const seg of parsePointer(pointer)) {
    if (Array.isArray(node)) node = node[Number(seg)];
    else if (isRecord(node)) node = node[seg];
    else return undefined;
  }
  return node;
}

type Container = Record<string, unknown> | unknown[];

function walkCreate(
  doc: Record<string, unknown>,
  segs: string[],
  lastIsArray: boolean,
  file: string,
): Container {
  let node: Container = doc;
  segs.forEach((seg, i) => {
    const wantArray = lastIsArray && i === segs.length - 1;
    if (Array.isArray(node)) {
      throw new PalmError(
        'E_PARSE',
        `${file}: ${formatPointer(segs.slice(0, i))} is an array, expected an object`,
      );
    }
    let child: unknown = node[seg];
    if (child === undefined || child === null) {
      child = wantArray ? [] : {};
      node[seg] = child;
    } else if (wantArray ? !Array.isArray(child) : !isRecord(child)) {
      throw new PalmError(
        'E_PARSE',
        `${file}: expected ${wantArray ? 'an array' : 'an object'} at ${formatPointer(segs.slice(0, i + 1))}`,
      );
    }
    node = child as Container;
  });
  return node;
}

/**
 * Insert `value` into the JSON file. `key === undefined`: the container at `pointer`
 * is an array and `value` is appended unless a deep-equal item already exists.
 * Otherwise `container[key] = value`. Intermediate objects are created.
 */
export async function mergeJsonFile(
  file: string,
  pointer: string,
  key: string | undefined,
  value: unknown,
  opts: JsonMergeOptions,
): Promise<MergedRecord> {
  const doc = await readJsonObject(file);
  const segs = parsePointer(pointer);
  let changed = false;
  let record: MergedRecord;
  if (key === undefined) {
    if (segs.length === 0)
      throw new PalmError('E_INTERNAL', `cannot append to the root of ${file}`);
    const arr = walkCreate(doc, segs, true, file) as unknown[];
    if (!arr.some((item) => deepEqual(item, value))) {
      arr.push(structuredClone(value));
      changed = true;
    }
    record = { file, pointer: formatPointer(segs), value };
  } else {
    const obj = walkCreate(doc, segs, false, file) as Record<string, unknown>;
    const current = obj[key];
    if (!deepEqual(current, value)) {
      if (current !== undefined && opts.onConflict === 'error') {
        throw new PalmError(
          'E_CONFLICT',
          `refusing to overwrite ${opts.displayFile ?? file} (${joinPointer(pointer, key)} already exists with different content)`,
          'rerun with --force',
        );
      }
      obj[key] = structuredClone(value);
      changed = true;
    }
    record = { file, pointer: joinPointer(pointer, key), value };
  }
  if (changed && !opts.dryRun) await atomicWrite(file, stringifyJson(doc));
  return record;
}

/** Set `container[key] = value` only when the key is missing. Not recorded (never removed by unmerge). */
export async function ensureJsonKey(
  file: string,
  pointer: string,
  key: string,
  value: unknown,
  opts: { dryRun: boolean },
): Promise<boolean> {
  const doc = await readJsonObject(file);
  const obj = walkCreate(doc, parsePointer(pointer), false, file) as Record<string, unknown>;
  if (obj[key] !== undefined) return false;
  obj[key] = structuredClone(value);
  if (!opts.dryRun) await atomicWrite(file, stringifyJson(doc));
  return true;
}

/**
 * Remove what `record` inserted. Array pointer → the first deep-equal item is removed.
 * Key pointer → the key is deleted when its current value still contains everything
 * palm wrote (keys the user added are tolerated; values the user changed are kept).
 * Containers left empty by the removal (`"SessionStart": []`, `"hooks": {}`,
 * `"mcpServers": {}`) are pruned, and a file that ends up as `{}` is deleted.
 * Missing file/pointer is a no-op.
 */
export async function unmergeJsonFile(file: string, record: MergedRecord): Promise<void> {
  const text = await readTextOrUndefined(file);
  if (text === undefined || text.trim() === '') return;
  const doc = await readJsonObject(file);
  const segs = recordedPath(record.pointer);
  if (segs.length === 0) return;
  const parent = getAtPointer(doc, formatPointer(segs.slice(0, -1)));
  const last = segs[segs.length - 1]!;
  const node = getAtPointer(doc, record.pointer);
  let changed = false;
  let emptied: string[] | undefined;
  if (Array.isArray(node) && !deepEqual(node, record.value)) {
    const idx = node.findIndex((item) => deepEqual(item, record.value));
    if (idx >= 0) {
      node.splice(idx, 1);
      changed = true;
      emptied = segs;
    }
  } else if (node !== undefined && containsAll(node, record.value)) {
    if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else if (isRecord(parent)) delete parent[last];
    changed = true;
    emptied = segs.slice(0, -1);
  }
  if (!changed) return;
  if (emptied) pruneEmptyContainers(doc, emptied);
  if (Object.keys(doc).length === 0) {
    await removeFileIfExists(file);
    return;
  }
  await atomicWrite(file, stringifyJson(doc));
}

/** Delete the container at `segs` and its ancestors while they are empty (never the root). */
function pruneEmptyContainers(doc: Record<string, unknown>, segs: string[]): void {
  for (let i = segs.length; i > 0; i--) {
    const node = getAtPointer(doc, formatPointer(segs.slice(0, i)));
    const empty = Array.isArray(node)
      ? node.length === 0
      : isRecord(node) && Object.keys(node).length === 0;
    if (!empty) return;
    const parent = getAtPointer(doc, formatPointer(segs.slice(0, i - 1)));
    if (isRecord(parent)) delete parent[segs[i - 1]!];
    else return;
  }
}
