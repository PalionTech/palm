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

import { PalmError } from '../core/errors.js';
import type { MergedRecord } from '../core/types.js';
import { containsAll, deepEqual, isPlainObject } from './deep-equal.js';
import { atomicWrite, readTextOrUndefined, removeFileIfExists } from './fs-utils.js';
import { formatPointer, joinPointer, parsePointer } from './json-pointer.js';

export interface JsonMergeOptions {
  dryRun: boolean;
  /** Existing object key with a different value: overwrite (default) or throw E_CONFLICT. */
  onConflict?: 'overwrite' | 'error';
  /** Name used in error messages (defaults to `file`). */
  displayFile?: string;
}

/** Remove `//` and `/* *\/` comments outside of strings. */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i]!;
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Remove commas directly before `}` or `]` (outside strings). Expects comment-free input. */
export function stripTrailingCommas(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

/** Parse JSON, falling back to JSONC (comments + trailing commas). */
export function parseJsonc(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
    } catch (e) {
      throw new PalmError(
        'E_PARSE',
        `cannot parse ${file}: ${(e as Error).message}`,
        'fix the JSON syntax or move the file aside',
      );
    }
  }
}

/** Read a JSON object file; `{}` when missing or empty. */
export async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  const text = await readTextOrUndefined(file);
  if (text === undefined || text.trim() === '') return {};
  const doc = parseJsonc(text, file);
  if (!isPlainObject(doc))
    throw new PalmError('E_PARSE', `${file}: expected a JSON object at the top level`);
  return doc;
}

export function serializeJson(doc: unknown): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Value at `pointer`, or undefined. */
export function getAtPointer(doc: unknown, pointer: string): unknown {
  let node: unknown = doc;
  for (const seg of parsePointer(pointer)) {
    if (Array.isArray(node)) node = node[Number(seg)];
    else if (isPlainObject(node)) node = node[seg];
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
    } else if (wantArray ? !Array.isArray(child) : !isPlainObject(child)) {
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
  if (changed && !opts.dryRun) await atomicWrite(file, serializeJson(doc));
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
  if (!opts.dryRun) await atomicWrite(file, serializeJson(doc));
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
  const segs = parsePointer(record.pointer);
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
    else if (isPlainObject(parent)) delete parent[last];
    changed = true;
    emptied = segs.slice(0, -1);
  }
  if (!changed) return;
  if (emptied) pruneEmptyContainers(doc, emptied);
  if (Object.keys(doc).length === 0) {
    await removeFileIfExists(file);
    return;
  }
  await atomicWrite(file, serializeJson(doc));
}

/** Delete the container at `segs` and its ancestors while they are empty (never the root). */
function pruneEmptyContainers(doc: Record<string, unknown>, segs: string[]): void {
  for (let i = segs.length; i > 0; i--) {
    const node = getAtPointer(doc, formatPointer(segs.slice(0, i)));
    const empty = Array.isArray(node)
      ? node.length === 0
      : isPlainObject(node) && Object.keys(node).length === 0;
    if (!empty) return;
    const parent = getAtPointer(doc, formatPointer(segs.slice(0, i - 1)));
    if (isPlainObject(parent)) delete parent[segs[i - 1]!];
    else return;
  }
}
