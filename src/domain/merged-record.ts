/**
 * A fragment palm merged into a shared file, as a tagged union (DESIGN.md sections 2 and 4). The
 * lock stores `{ file, at, id, key }` (`LockMerged`); a render adds the `value`
 * (`RenderedFragment`). `id` is palm's identity (`palm:<kind>:<name>:<n>`); `key` finds the
 * fragment on disk:
 *
 * | type         | written by                        | `at`                       | `key`                        |
 * |--------------|-----------------------------------|----------------------------|------------------------------|
 * | `json-item`  | hook entries appended to an array | `/hooks/<event>`           | sha256:8 of matcher+commands |
 * | `json-item`  | OpenCode instruction file paths   | `/instructions`            | sha256:8 of the string       |
 * | `json-key`   | MCP servers set as an object key  | `/mcpServers/<name>`, …    | the object key (`<name>`)    |
 * | `toml-table` | Codex `[mcp_servers.<name>]`      | `/mcp_servers/<name>`      | the table name (`<name>`)    |
 * | `md-block`   | `<!-- palm:begin <id> -->` blocks | `block:<id>`               | the block id                 |
 *
 * `file` keeps whatever form it was given: absolute while a target works with it, the lock form
 * once recorded. `fragmentKey`, `fragmentId` and `renderHashOf` (lock.ts) build on these rules.
 */
import { messageOf, PalmError } from '../core/errors.js';
import type { LockMerged, RenderedFragment } from '../core/types.js';
import { sha256, short } from '../lib/digest.js';
import { canonicalJson } from '../lib/json.js';
import { formatPointer, parsePointer } from '../lib/json-pointer.js';
import { isRecord } from '../lib/object.js';

const BLOCK_PREFIX = 'block:';

/** Pointer segment under which JSON hook files keep their per-event arrays. */
const HOOKS_KEY = 'hooks';

/** Top-level array OpenCode lists instruction files in (`opencode.json#/instructions`). */
const INSTRUCTIONS_KEY = 'instructions';

export type MergedRecord =
  | { type: 'json-item'; file: string; path: string[]; id: string; key: string; value: unknown }
  | { type: 'json-key'; file: string; path: string[]; id: string; key: string; value: unknown }
  | { type: 'toml-table'; file: string; path: string[]; id: string; key: string; value: unknown }
  | { type: 'md-block'; file: string; id: string; key: string; content: string };

/**
 * Whether a shared file still holds a fragment as palm wrote it: `held`, `missing` (no file or
 * nothing under `key`) or `changed` (found by key, another value, or the file no longer parses).
 */
export type RecordState = 'held' | 'missing' | 'changed';

/** True when pointer segments name an array palm appends items to (hook events, OpenCode instructions). */
function isArrayPath(path: readonly string[]): boolean {
  return (
    (path.length === 2 && path[0] === HOOKS_KEY) ||
    (path.length === 1 && path[0] === INSTRUCTIONS_KEY)
  );
}

/** Every `command` (and, for prompt hooks, `prompt`) string in a hook item, in order. */
function hookCommands(value: Record<string, unknown>): string[] {
  const items = Array.isArray(value.hooks) ? value.hooks : [value];
  return items.flatMap((h) => {
    if (!isRecord(h)) return [];
    const text = typeof h.command === 'string' ? h.command : h.prompt;
    return typeof text === 'string' ? [text] : [];
  });
}

/**
 * The identity fields of an appended array item: the string itself, or a hook's matcher and
 * command strings (sorted, so reordering them keeps the identity). Other fields (timeouts,
 * types, key order) are not identity.
 */
function itemIdentity(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return value;
  const matcher = typeof value.matcher === 'string' ? value.matcher : '';
  return { matcher, commands: hookCommands(value).sort() };
}

/**
 * The key that finds a fragment inside `at` on disk: the block id for `block:<id>`, the
 * sha256:8 of the item's identity fields for an appended array item, else the last pointer
 * segment (the object key or TOML table name). The root pointer is E_INTERNAL.
 */
export function fragmentKey(at: string, value: unknown): string {
  if (at.startsWith(BLOCK_PREFIX)) return at.slice(BLOCK_PREFIX.length);
  const path = pointerPath(at);
  if (isArrayPath(path)) return `sha256:${short(sha256(canonicalJson(itemIdentity(value))))}`;
  return path[path.length - 1] as string;
}

/** palm's identity of the `n`th fragment of an entry: `palm:<kind>:<name>:<n>`. */
export function fragmentId(entry: { kind: string; name: string }, n: number): string {
  return `palm:${entry.kind}:${entry.name}:${n}`;
}

function invalid(at: string, file: string, why: string): PalmError {
  return new PalmError(
    'E_INTERNAL',
    `lock record for ${file}: ${why} ("${at}")`,
    'restore palm.lock.yaml from git, then run palm install',
  );
}

/** Pointer segments of `at`; the root or a malformed pointer is E_INTERNAL. */
function pointerPath(at: string, file = '?'): string[] {
  let path: string[];
  try {
    path = parsePointer(at);
  } catch (e) {
    throw invalid(at, file, messageOf(e));
  }
  if (path.length === 0) throw invalid(at, file, 'pointer names the whole file');
  return path;
}

/**
 * The union form of a fragment. `block:` pointers are markdown blocks, `.toml` files hold
 * tables, `/hooks/<event>` and `/instructions` are arrays palm appends to, and any other JSON
 * pointer names an object key. The root pointer and malformed pointers are E_INTERNAL.
 */
export function parseMergedRecord(stored: RenderedFragment): MergedRecord {
  const { file, at, id, key, value } = stored;
  if (typeof at !== 'string') throw invalid(String(at), file, 'missing pointer');
  if (at.startsWith(BLOCK_PREFIX)) {
    if (at === BLOCK_PREFIX) throw invalid(at, file, 'empty block id');
    return { type: 'md-block', file, id, key, content: typeof value === 'string' ? value : '' };
  }
  const path = pointerPath(at, file);
  if (file.endsWith('.toml')) return { type: 'toml-table', file, path, id, key, value };
  if (isArrayPath(path)) return { type: 'json-item', file, path, id, key, value };
  return { type: 'json-key', file, path, id, key, value };
}

/** The `at` pointer of a record (`block:<key>` for a markdown block). */
export function pointerOf(rec: MergedRecord): string {
  return rec.type === 'md-block' ? `${BLOCK_PREFIX}${rec.key}` : formatPointer(rec.path);
}

/** The lock form of a record: `{ file, at, id, key }`, without the value. */
export function toLockMerged(rec: MergedRecord): LockMerged {
  return { file: rec.file, at: pointerOf(rec), id: rec.id, key: rec.key };
}
