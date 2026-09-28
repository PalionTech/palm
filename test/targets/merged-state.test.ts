/** Whether a shared file still holds what palm merged into it (H3 drift checks). */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergedRecordState } from '../../src/targets/merged-state.js';
import { cleanupTmp, tmpDir, write } from './helpers.js';

afterEach(cleanupTmp);

describe('mergedRecordState', () => {
  it('json-key: held (extra user keys fine, placeholders match a literal), changed, missing', async () => {
    const file = path.join(await tmpDir(), '.mcp.json');
    const rec = {
      file,
      pointer: '/mcpServers/docs',
      value: { url: 'https://d/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
    };
    expect(await mergedRecordState(rec)).toBe('missing');
    await write(
      file,
      JSON.stringify({
        mcpServers: {
          docs: { url: 'https://d/mcp', headers: { Authorization: 'Bearer sk-1' }, timeout: 5 },
        },
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

  it('json-item (hook entry, OpenCode instruction path): held while an equal item is there', async () => {
    const file = path.join(await tmpDir(), 'settings.json');
    const item = { hooks: [{ type: 'command', command: './fmt.sh' }] };
    const rec = { file, pointer: '/hooks/PostToolUse', value: item };
    await write(file, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'x' }, item] } }));
    expect(await mergedRecordState(rec)).toBe('held');
    await write(file, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'x' }] } }));
    expect(await mergedRecordState(rec)).toBe('missing');
  });

  it('toml-table and md-block', async () => {
    const dir = await tmpDir();
    const toml = path.join(dir, 'config.toml');
    const table = { file: toml, pointer: '/mcp_servers/fs', value: { command: 'npx' } };
    await write(toml, '[mcp_servers.fs]\ncommand = "npx"\nargs = ["x"]\n');
    expect(await mergedRecordState(table)).toBe('held');
    await write(toml, '[mcp_servers.fs]\ncommand = "node"\n');
    expect(await mergedRecordState(table)).toBe('changed');
    await write(toml, '# nothing\n');
    expect(await mergedRecordState(table)).toBe('missing');

    const md = path.join(dir, 'AGENTS.md');
    const block = { file: md, pointer: 'block:instruction:a', value: 'Be terse.' };
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
