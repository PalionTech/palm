import path from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import type { MergedRecord } from '../../src/domain/merged-record.js';
import {
  mergeTableText,
  parseTomlHeader,
  type TomlEdit,
  tomlRecordState,
  unmergeTomlTable,
} from '../../src/targets/toml-merge.js';
import { applyText, cleanupTmp, exists, read, tmpDir, write } from './helpers.js';

afterEach(cleanupTmp);

type TomlTableRecord = Extract<MergedRecord, { type: 'toml-table' }>;

const ORIGINAL = `# my codex config
model = "gpt-6-astra" # favourite

[mcp_servers.mine]
command = "mine" # keep me

[profiles.fast]
model = "gpt-5.6-luna"
`;

/** Merge a table the way an apply does; the record its fragment names. */
async function mergeTable(
  file: string,
  path: string[],
  value: Record<string, unknown>,
  opts: Partial<TomlEdit> = {},
): Promise<TomlTableRecord> {
  await applyText(file, (text) => mergeTableText(text, { ...opts, file, path, value }));
  return { type: 'toml-table', file, path, id: 'palm:mcp:x:0', key: path.at(-1) ?? '', value };
}

describe('mergeTableText', () => {
  it('appends a table and preserves comments and other tables byte-for-byte', async () => {
    const file = path.join(await tmpDir(), 'config.toml');
    await write(file, ORIGINAL);
    const value = { command: 'npx', args: ['-y', 'fs'], env: { A: 'b' } };
    const rec = await mergeTable(file, ['mcp_servers', 'fs'], value);
    expect(rec.key).toBe('fs');
    const text = await read(file);
    expect(text).toBe(
      `${ORIGINAL}\n[mcp_servers.fs]\ncommand = "npx"\nargs = [ "-y", "fs" ]\n\n[mcp_servers.fs.env]\nA = "b"\n`,
    );
    expect(parse(text)).toMatchObject({
      model: 'gpt-6-astra',
      mcp_servers: { mine: { command: 'mine' }, fs: { command: 'npx' } },
    });
  });

  it('round-trips: merge then unmerge restores the original text', async () => {
    const file = path.join(await tmpDir(), 'config.toml');
    await write(file, ORIGINAL);
    const rec = await mergeTable(file, ['mcp_servers', 'fs'], { command: 'npx', env: { A: 'b' } });
    await unmergeTomlTable(file, rec);
    expect(await read(file)).toBe(ORIGINAL);
  });

  it('creates a missing document; idempotent; conflict detection', () => {
    const edit = { file: 'config.toml', path: ['mcp_servers', 'x'], value: { url: 'https://a' } };
    const first = mergeTableText(undefined, edit);
    expect(first).toBe('[mcp_servers.x]\nurl = "https://a"\n');
    expect(mergeTableText(first, { ...edit, onConflict: 'error' })).toBeUndefined();
    const changed = { ...edit, value: { url: 'https://b' } };
    expect(() => mergeTableText(first, { ...changed, onConflict: 'error' })).toThrow(
      expect.objectContaining({ code: 'E_CONFLICT' }),
    );
    expect(mergeTableText(first, changed)).toBe('[mcp_servers.x]\nurl = "https://b"\n');
  });

  it('replaces an existing section in place of text when updating', () => {
    const text =
      '[mcp_servers.x]\nurl = "old"\n\n[mcp_servers.x.http_headers]\nA = "1"\n\n[other]\nk = 1\n';
    expect(
      mergeTableText(text, {
        file: 'config.toml',
        path: ['mcp_servers', 'x'],
        value: { url: 'new' },
      }),
    ).toBe('[other]\nk = 1\n\n[mcp_servers.x]\nurl = "new"\n');
  });

  it('falls back to a full re-stringify when the text edit cannot express the change', async () => {
    const file = path.join(await tmpDir(), 'config.toml');
    await write(file, 'mcp_servers = { other = { command = "o" } }\n');
    const rec = await mergeTable(file, ['mcp_servers', 'x'], { command: 'c' });
    expect(parse(await read(file))).toEqual({
      mcp_servers: { other: { command: 'o' }, x: { command: 'c' } },
    });
    await unmergeTomlTable(file, rec);
    expect(parse(await read(file))).toEqual({ mcp_servers: { other: { command: 'o' } } });
  });

  it('unparseable TOML is E_PARSE', () => {
    expect(() =>
      mergeTableText('[a\n', { file: 'config.toml', path: ['mcp_servers', 'x'], value: {} }),
    ).toThrow(expect.objectContaining({ code: 'E_PARSE' }));
  });

  it('quoted table names', async () => {
    const file = path.join(await tmpDir(), 'config.toml');
    const rec = await mergeTable(file, ['mcp_servers', 'io.github/x'], { url: 'u' });
    expect(await read(file)).toBe('[mcp_servers."io.github/x"]\nurl = "u"\n');
    await unmergeTomlTable(file, rec);
    expect(await exists(file)).toBe(false); // left empty: deleted, no 0-byte config.toml (L10)
  });
});

describe('unmergeTomlTable', () => {
  it('removes the table by its path even when edited (the engine decides before undeploy)', async () => {
    const file = path.join(await tmpDir(), 'config.toml');
    const rec = await mergeTable(file, ['mcp_servers', 'x'], { command: 'c' });
    await write(file, 'model = "m"\n\n[mcp_servers.x]\ncommand = "edited"\n');
    await unmergeTomlTable(file, rec);
    expect(await read(file)).toBe('model = "m"\n');
  });
});

describe('tomlRecordState', () => {
  it('held, changed (placeholders match any text), missing', () => {
    const rec: TomlTableRecord = {
      type: 'toml-table',
      file: 'config.toml',
      path: ['mcp_servers', 'x'],
      id: 'palm:mcp:x:0',
      key: 'x',
      value: { command: 'c', env: { T: '${T}' } },
    };
    expect(tomlRecordState('[mcp_servers.x]\ncommand = "c"\nenv = { T = "abc" }\n', rec)).toBe(
      'held',
    );
    expect(tomlRecordState('[mcp_servers.x]\ncommand = "d"\n', rec)).toBe('changed');
    expect(tomlRecordState('model = "m"\n', rec)).toBe('missing');
    expect(tomlRecordState('[broken', rec)).toBe('changed');
  });
});

describe('parseTomlHeader', () => {
  it('parses bare, quoted and array headers', () => {
    expect(parseTomlHeader('[a.b]')).toEqual({ path: ['a', 'b'], array: false });
    expect(parseTomlHeader(' [ a . "b.c" . \'d\' ] # c')).toEqual({
      path: ['a', 'b.c', 'd'],
      array: false,
    });
    expect(parseTomlHeader('[[x.y]]')).toEqual({ path: ['x', 'y'], array: true });
    expect(parseTomlHeader('a = [1]')).toBeUndefined();
    expect(parseTomlHeader('[a] x')).toBeUndefined();
  });
});
