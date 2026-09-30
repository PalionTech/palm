/**
 * Whether a shared file holds a fragment palm merges into it (`.mcp.json` keys, hook entries,
 * Codex `[mcp_servers.<name>]` tables, `AGENTS.md` blocks), for the engine's drift checks:
 * bare `palm install` restores what is missing and keeps what changed, `palm check` reports both.
 */
import type { MergedRecord, RecordState } from '../domain/merged-record.js';
import { readTextOrUndefined } from './fs-utils.js';
import { jsonRecordState } from './json-merge.js';
import { blockState } from './managed-block.js';
import { tomlRecordState } from './toml-merge.js';

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
