/**
 * A fragment palm merged into a shared file, as a tagged union. The lockfile stores
 * `{ file, pointer, value }` (core `MergedRecord`); `parseMergedRecord` / `toStored` convert
 * between the two without changing that format:
 *
 * | type         | written by                        | stored pointer              | value            |
 * |--------------|-----------------------------------|-----------------------------|------------------|
 * | `json-item`  | hook entries appended to an array | `/hooks/<event>`            | the item         |
 * | `json-item`  | OpenCode instruction file paths   | `/instructions`             | the path         |
 * | `json-key`   | MCP servers set as an object key  | `/mcpServers/<name>`, …     | the key's value  |
 * | `toml-table` | Codex `[mcp_servers.<name>]`      | `/mcp_servers/<name>`       | the table        |
 * | `md-block`   | `<!-- palm:begin <id> -->` blocks | `block:<id>`                | the block text   |
 *
 * `file` keeps whatever form it was given: absolute while a target works with it, the lock
 * form (scope-relative at project scope) once recorded.
 */
import { messageOf, PalmError } from '../core/errors.js';
import type { MergedRecord as StoredMergedRecord } from '../core/types.js';
import { formatPointer, parsePointer } from '../lib/json-pointer.js';

export type { StoredMergedRecord };

const BLOCK_POINTER_PREFIX = 'block:';

/** Pointer segment under which JSON hook files keep their per-event arrays. */
const HOOKS_KEY = 'hooks';

/** Top-level array OpenCode lists instruction files in (`opencode.json#/instructions`). */
const INSTRUCTIONS_KEY = 'instructions';

/** An item appended to the JSON array at `path`; removal deletes the first deep-equal item. */
export interface JsonItemRecord {
  type: 'json-item';
  file: string;
  path: string[];
  value: unknown;
}

/** The value of the JSON object key at `path` (last segment = the key). */
export interface JsonKeyRecord {
  type: 'json-key';
  file: string;
  path: string[];
  value: unknown;
}

/** The TOML table at `path` (`['mcp_servers', name]`). */
export interface TomlTableRecord {
  type: 'toml-table';
  file: string;
  path: string[];
  value: unknown;
}

/** A palm-managed markdown block (`instruction:<name>`). */
export interface MdBlockRecord {
  type: 'md-block';
  file: string;
  id: string;
  content: string;
}

export type JsonRecord = JsonItemRecord | JsonKeyRecord;
export type MergedRecord = JsonRecord | TomlTableRecord | MdBlockRecord;

function invalid(stored: StoredMergedRecord, why: string): PalmError {
  return new PalmError(
    'E_INTERNAL',
    `lockfile record for ${stored.file}: ${why} ("${stored.pointer}")`,
    'reinstall the entity (palm install --force) or remove the record from the lockfile',
  );
}

/**
 * The union form of a lockfile record. `block:` pointers are markdown blocks, `.toml` files
 * hold tables, JSON pointers of the form `/hooks/<event>` name hook arrays, `/instructions`
 * names OpenCode's instruction list, and any other JSON pointer names an object key. The root pointer and malformed pointers are E_INTERNAL.
 */
export function parseMergedRecord(stored: StoredMergedRecord): MergedRecord {
  const { file, pointer, value } = stored;
  if (typeof pointer !== 'string') throw invalid(stored, 'missing pointer');
  if (pointer.startsWith(BLOCK_POINTER_PREFIX)) {
    const id = pointer.slice(BLOCK_POINTER_PREFIX.length);
    if (id === '') throw invalid(stored, 'empty block id');
    return { type: 'md-block', file, id, content: typeof value === 'string' ? value : '' };
  }
  let path: string[];
  try {
    path = parsePointer(pointer);
  } catch (e) {
    throw invalid(stored, messageOf(e));
  }
  if (path.length === 0) throw invalid(stored, 'pointer names the whole file');
  if (file.endsWith('.toml')) return { type: 'toml-table', file, path, value };
  if (path.length === 2 && path[0] === HOOKS_KEY) return { type: 'json-item', file, path, value };
  if (path.length === 1 && path[0] === INSTRUCTIONS_KEY)
    return { type: 'json-item', file, path, value };
  return { type: 'json-key', file, path, value };
}

/** The stored pointer of the markdown block `id`. */
export function blockPointer(id: string): string {
  return `${BLOCK_POINTER_PREFIX}${id}`;
}

/** The pointer string stored in the lockfile (and used in `ownedFiles` as `file#pointer`). */
export function pointerOf(rec: MergedRecord): string {
  return rec.type === 'md-block' ? blockPointer(rec.id) : formatPointer(rec.path);
}

/** The lockfile form: `{ file, pointer, value }`. */
export function toStored(rec: MergedRecord): StoredMergedRecord {
  return {
    file: rec.file,
    pointer: pointerOf(rec),
    value: rec.type === 'md-block' ? rec.content : rec.value,
  };
}
