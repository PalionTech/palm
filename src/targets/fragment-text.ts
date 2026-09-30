/**
 * The text a merged fragment adds to its shared file, in that file's own language (ruling R20'):
 * a Codex server as its `[mcp_servers.<name>]` TOML table, a markdown block as its text, a JSON
 * value as indented JSON. `describe` shows it under each harness.
 */
import type { RenderedFragment } from '../core/types.js';
import { parseMergedRecord } from '../domain/merged-record.js';
import { mergeTableText } from './toml-merge.js';

/** The lines `fragment` writes into its file, as `palm describe` prints them. */
export function fragmentText(fragment: Pick<RenderedFragment, 'file' | 'at' | 'value'>): string {
  const rec = parseMergedRecord({ ...fragment, id: '', key: '' });
  if (rec.type === 'md-block') return rec.content.replace(/\n+$/, '');
  if (rec.type === 'toml-table') {
    const value = rec.value as Record<string, unknown>;
    const edit = { file: rec.file, path: rec.path, value };
    return (mergeTableText('', edit) ?? '').replace(/\n+$/, '');
  }
  return JSON.stringify(rec.value, null, 2);
}
