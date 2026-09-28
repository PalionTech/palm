import path from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { toStored } from '../../src/domain/merged-record.js';
import { mergeTomlTable, parseTomlHeader, unmergeTomlTable } from '../../src/targets/toml-merge.js';
import { cleanupTmp, read, tmpDir, write } from './helpers.js';

afterEach(cleanupTmp);

const ORIGINAL = `# my codex config
model = "gpt-6-astra" # favourite

[mcp_servers.mine]
command = "mine" # keep me

[profiles.fast]
model = "gpt-5.6-luna"
`;

describe('mergeTomlTable', () => {
  it('appends a table and preserves comments and other tables byte-for-byte', async () => {
    const file = path.join(await tmpDir(), 'config.toml');
    await write(file, ORIGINAL);
    const rec = await mergeTomlTable(
      file,
      ['mcp_servers', 'fs'],
      { command: 'npx', args: ['-y', 'fs'], env: { A: 'b' } },
      { dryRun: false },
    );
    expect(rec).toMatchObject({ type: 'toml-table', path: ['mcp_servers', 'fs'] });
    expect(toStored(rec)).toEqual({
      file,
      pointer: '/mcp_servers/fs',
      value: { command: 'npx', args: ['-y', 'fs'], env: { A: 'b' } },
    });
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
    const rec = await mergeTomlTable(
      file,
      ['mcp_servers', 'fs'],
      { command: 'npx', env: { A: 'b' } },
      { dryRun: false },
    );
    await unmergeTomlTable(file, rec);
    expect(await read(file)).toBe(ORIGINAL);
  });

  it('creates a missing file; idempotent; conflict detection', async () => {
    const file = path.join(await tmpDir(), 'config.toml');
    await mergeTomlTable(file, ['mcp_servers', 'x'], { url: 'https://a' }, { dryRun: false });
    const first = await read(file);
    expect(first).toBe('[mcp_servers.x]\nurl = "https://a"\n');
    await mergeTomlTable(
      file,
      ['mcp_servers', 'x'],
      { url: 'https://a' },
      { dryRun: false, onConflict: 'error' },
    );
    expect(await read(file)).toBe(first);
    await expect(
      mergeTomlTable(
        file,
        ['mcp_servers', 'x'],
        { url: 'https://b' },
        { dryRun: false, onConflict: 'error' },
      ),
    ).rejects.toMatchObject({
      code: 'E_CONFLICT',
    });
    await mergeTomlTable(file, ['mcp_servers', 'x'], { url: 'https://b' }, { dryRun: false });
    expect(await read(file)).toBe('[mcp_servers.x]\nurl = "https://b"\n');
  });

  it('replaces an existing section in place of text when updating', async () => {
    const file = path.join(await tmpDir(), 'config.toml');
    await write(
      file,
      '[mcp_servers.x]\nurl = "old"\n\n[mcp_servers.x.http_headers]\nA = "1"\n\n[other]\nk = 1\n',
    );
    await mergeTomlTable(file, ['mcp_servers', 'x'], { url: 'new' }, { dryRun: false });
    expect(await read(file)).toBe('[other]\nk = 1\n\n[mcp_servers.x]\nurl = "new"\n');
  });

  it('falls back to a full re-stringify when the text edit cannot express the change', async () => {
    const file = path.join(await tmpDir(), 'config.toml');
    await write(file, 'mcp_servers = { other = { command = "o" } }\n');
    const rec = await mergeTomlTable(
      file,
      ['mcp_servers', 'x'],
      { command: 'c' },
      { dryRun: false },
    );
    expect(parse(await read(file))).toEqual({
      mcp_servers: { other: { command: 'o' }, x: { command: 'c' } },
    });
    await unmergeTomlTable(file, rec);
    expect(parse(await read(file))).toEqual({ mcp_servers: { other: { command: 'o' } } });
  });

  it('dryRun does not write', async () => {
    const file = path.join(await tmpDir(), 'config.toml');
    await write(file, ORIGINAL);
    await mergeTomlTable(file, ['mcp_servers', 'fs'], { command: 'x' }, { dryRun: true });
    expect(await read(file)).toBe(ORIGINAL);
  });

  it('quoted table names', async () => {
    const file = path.join(await tmpDir(), 'config.toml');
    const rec = await mergeTomlTable(
      file,
      ['mcp_servers', 'io.github/x'],
      { url: 'u' },
      { dryRun: false },
    );
    expect(await read(file)).toBe('[mcp_servers."io.github/x"]\nurl = "u"\n');
    await unmergeTomlTable(file, rec);
    expect(await read(file)).toBe('');
  });
});

describe('unmergeTomlTable', () => {
  it('leaves a table whose palm-written values were edited', async () => {
    const file = path.join(await tmpDir(), 'config.toml');
    const rec = await mergeTomlTable(
      file,
      ['mcp_servers', 'x'],
      { command: 'c' },
      { dryRun: false },
    );
    await write(file, '[mcp_servers.x]\ncommand = "edited"\n');
    await unmergeTomlTable(file, rec);
    expect(await read(file)).toBe('[mcp_servers.x]\ncommand = "edited"\n');
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
