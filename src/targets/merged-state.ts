/**
 * Whether a shared file holds a fragment palm merges into it (`.mcp.json` keys, hook entries,
 * Codex `[mcp_servers.<name>]` tables, `AGENTS.md` blocks), for the engine's drift checks:
 * bare `palm install` restores what is missing and keeps what changed, `palm check` reports both.
 * `mergedRecordValue` reads what the file holds under the key, so the engine can hash the disk
 * the way the render was hashed.
 */
import type { MergedRecord, RecordState } from '../domain/merged-record.js';
import { readTextOrUndefined } from './fs-utils.js';
import { jsonRecordState, jsonRecordValue } from './json-merge.js';
import { blockState, blockValue } from './managed-block.js';
import { tomlRecordState, tomlRecordValue } from './toml-merge.js';

/**
 * The state of one fragment (`rec.file` absolute), found by its key: `held` when what is there
 * matches what palm would write (`${VAR}` matching any text), `changed` when the key holds
 * something else, `missing` when the key is absent.
 */
export async function mergedRecordState(rec: MergedRecord): Promise<RecordState> {
  const text = await readTextOrUndefined(rec.file);
  switch (rec.type) {
    case 'md-block':
      return blockState(text, rec.key, rec.content);
    case 'toml-table':
      return tomlRecordState(text, rec);
    case 'json-item':
    case 'json-key':
      return jsonRecordState(text, rec);
  }
}

/**
 * What the shared file (`rec.file` absolute) holds under the fragment's key, in the form a render
 * gives the value (a block's content ends with the newlines of `rec.content`); undefined when
 * the key is absent or the file does not parse.
 */
export async function mergedRecordValue(rec: MergedRecord): Promise<unknown> {
  const text = await readTextOrUndefined(rec.file);
  switch (rec.type) {
    case 'md-block':
      return blockValue(text, rec.key, rec.content);
    case 'toml-table':
      return tomlRecordValue(text, rec);
    case 'json-item':
    case 'json-key':
      return jsonRecordValue(text, rec);
  }
}
