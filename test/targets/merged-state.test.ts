/** Whether a shared file still holds a fragment palm merges into it, found by key. */
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fragmentKey } from '../../src/domain/lock.js';
import type { MergedRecord } from '../../src/domain/merged-record.js';
import { mergedRecordState } from '../../src/targets/merged-state.js';
import { cleanupTmp, tmpDir, write } from './helpers.js';

vi.mock('../../src/domain/lock.js', async (orig) =>
  (await import('./fakes.js')).withLock(await orig()),
);

afterEach(cleanupTmp);

describe('mergedRecordState', () => {
  it('json-key: held (placeholders match a literal), changed, missing', async () => {
    const file = path.join(await tmpDir(), '.mcp.json');
    const rec: MergedRecord = {
      type: 'json-key',
      file,
      path: ['mcpServers', 'docs'],
      id: 'palm:mcp:docs:0',
      key: 'docs',
      value: { url: 'https://d/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
    };
    expect(await mergedRecordState(rec)).toBe('missing');
    await write(
      file,
      JSON.stringify({
        mcpServers: { docs: { url: 'https://d/mcp', headers: { Authorization: 'Bearer sk-1' } } },
      }),
    );
    expect(await mergedRecordState(rec)).toBe('held');
    await write(file, JSON.stringify({ mcpServers: { docs: { url: 'https://evil/mcp' } } }));
    expect(await mergedRecordState(rec)).toBe('changed');
    await write(file, JSON.stringify({ mcpServers: {} }));
    expect(await mergedRecordState(rec)).toBe('missing');
    await write(file, '{ not json');
    expect(await mergedRecordState(rec)).toBe('changed');
  });

  it('json-item (hook entry, OpenCode instruction path): found by key; an edit is changed', async () => {
    const file = path.join(await tmpDir(), 'settings.json');
    const item = { hooks: [{ type: 'command', command: './fmt.sh' }] };
    const rec: MergedRecord = {
      type: 'json-item',
      file,
      path: ['hooks', 'PostToolUse'],
      id: 'palm:hook:fmt:0',
      key: fragmentKey('/hooks/PostToolUse', item),
      value: item,
    };
    await write(file, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'x' }, item] } }));
    expect(await mergedRecordState(rec)).toBe('held');
    const edited = { hooks: [{ type: 'command', command: './fmt.sh', timeout: 9 }] };
    await write(file, JSON.stringify({ hooks: { PostToolUse: [edited] } }));
    expect(await mergedRecordState(rec)).toBe('changed');
    await write(file, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'x' }] } }));
    expect(await mergedRecordState(rec)).toBe('missing');
  });

  it('toml-table and md-block', async () => {
    const dir = await tmpDir();
    const toml = path.join(dir, 'config.toml');
    const table: MergedRecord = {
      type: 'toml-table',
      file: toml,
      path: ['mcp_servers', 'fs'],
      id: 'palm:mcp:fs:0',
      key: 'fs',
      value: { command: 'npx', args: ['x'] },
    };
    await write(toml, '[mcp_servers.fs]\ncommand = "npx"\nargs = ["x"]\n');
    expect(await mergedRecordState(table)).toBe('held');
    await write(toml, '[mcp_servers.fs]\ncommand = "node"\n');
    expect(await mergedRecordState(table)).toBe('changed');
    await write(toml, '# nothing\n');
    expect(await mergedRecordState(table)).toBe('missing');

    const md = path.join(dir, 'AGENTS.md');
    const block: MergedRecord = {
      type: 'md-block',
      file: md,
      id: 'palm:instruction:a:0',
      key: 'instruction:a',
      content: 'Be terse.',
    };
    await write(
      md,
      '# Mine\n\n<!-- palm:begin instruction:a -->\nBe terse.\n<!-- palm:end instruction:a -->\n',
    );
    expect(await mergedRecordState(block)).toBe('held');
    await write(
      md,
      '<!-- palm:begin instruction:a -->\nBe verbose.\n<!-- palm:end instruction:a -->\n',
    );
    expect(await mergedRecordState(block)).toBe('changed');
    await write(md, '# Mine\n');
    expect(await mergedRecordState(block)).toBe('missing');
  });
});
