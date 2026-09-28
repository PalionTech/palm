/**
 * Whether a shared file still holds a fragment palm merged into it (`.mcp.json` keys, hook
 * entries, Codex `[mcp_servers.<name>]` tables, `AGENTS.md` blocks), for drift checks: bare
 * `palm install` re-merges what is missing or changed, `--frozen` lists it as a difference and
 * `palm doctor` reports it.
 */
import type { MergedRecord as StoredMergedRecord } from '../core/types.js';
import { parseMergedRecord, type RecordState } from '../domain/merged-record.js';
import { readTextOrUndefined } from './fs-utils.js';
import { jsonRecordState } from './json-merge.js';
import { blockState } from './managed-block.js';
import { tomlRecordState } from './toml-merge.js';

/** The state of one recorded fragment (`file` absolute); an unreadable record or file counts as changed. */
export async function mergedRecordState(stored: StoredMergedRecord): Promise<RecordState> {
  const rec = parseMergedRecord(stored);
  const text = await readTextOrUndefined(rec.file);
  switch (rec.type) {
    case 'md-block':
      return blockState(text, rec.id, rec.content);
    case 'toml-table':
      return tomlRecordState(text, rec);
    case 'json-item':
    case 'json-key':
      return jsonRecordState(text, rec);
  }
}
