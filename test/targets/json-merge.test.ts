import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { ensureJsonKey, mergeJsonFile, parseJsonc, unmergeJsonFile } from '../../src/targets/json-merge.js';
import { cleanupTmp, exists, read, readJson, tmpDir, write } from './helpers.js';

afterEach(cleanupTmp);

describe('mergeJsonFile', () => {
  it('creates the file and intermediate objects, records the key pointer', async () => {
    const file = path.join(await tmpDir(), 'sub', '.mcp.json');
    const rec = await mergeJsonFile(file, '/mcpServers', 'fs', { command: 'npx' }, { dryRun: false });
    expect(rec).toEqual({ file, pointer: '/mcpServers/fs', value: { command: 'npx' } });
    expect(await read(file)).toBe('{\n  "mcpServers": {\n    "fs": {\n      "command": "npx"\n    }\n  }\n}\n');
  });

  it('tolerates JSONC comments and trailing commas, keeps unrelated keys, writes plain JSON', async () => {
    const file = path.join(await tmpDir(), 'settings.json');
    await write(file, '{\n  // user comment\n  "theme": "dark", /* inline */\n  "url": "http://x//y",\n  "hooks": {},\n}\n');
    await mergeJsonFile(file, '/hooks/Stop', undefined, { hooks: [{ type: 'command', command: 'x' }] }, { dryRun: false });
    expect(await readJson(file)).toEqual({
      theme: 'dark',
      url: 'http://x//y',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
    });
    expect(await read(file)).not.toContain('comment');
  });

  it('appends array items idempotently', async () => {
    const file = path.join(await tmpDir(), 'hooks.json');
    const item = { command: 'a' };
    await mergeJsonFile(file, '/hooks/stop', undefined, item, { dryRun: false });
    await mergeJsonFile(file, '/hooks/stop', undefined, item, { dryRun: false });
    await mergeJsonFile(file, '/hooks/stop', undefined, { command: 'b' }, { dryRun: false });
    expect(await readJson(file)).toEqual({ hooks: { stop: [{ command: 'a' }, { command: 'b' }] } });
  });

  it('conflicting key: error mode throws E_CONFLICT, default overwrites', async () => {
    const file = path.join(await tmpDir(), 'mcp.json');
    await write(file, '{"mcpServers":{"fs":{"command":"old"}}}');
    await expect(mergeJsonFile(file, '/mcpServers', 'fs', { command: 'new' }, { dryRun: false, onConflict: 'error' })).rejects.toMatchObject({
      code: 'E_CONFLICT',
    });
    await mergeJsonFile(file, '/mcpServers', 'fs', { command: 'new' }, { dryRun: false });
    expect(await readJson(file)).toEqual({ mcpServers: { fs: { command: 'new' } } });
  });

  it('identical key value is not a conflict', async () => {
    const file = path.join(await tmpDir(), 'mcp.json');
    await write(file, '{"mcpServers":{"fs":{"command":"same"}}}');
    await expect(mergeJsonFile(file, '/mcpServers', 'fs', { command: 'same' }, { dryRun: false, onConflict: 'error' })).resolves.toBeDefined();
  });

  it('dryRun computes the record without writing', async () => {
    const file = path.join(await tmpDir(), 'x.json');
    const rec = await mergeJsonFile(file, '/a', 'b', 1, { dryRun: true });
    expect(rec.pointer).toBe('/a/b');
    expect(await exists(file)).toBe(false);
  });

  it('escapes pointer segments', async () => {
    const file = path.join(await tmpDir(), 'x.json');
    const rec = await mergeJsonFile(file, '/servers', 'io.github/x~y', { url: 'u' }, { dryRun: false });
    expect(rec.pointer).toBe('/servers/io.github~1x~0y');
    await unmergeJsonFile(file, rec);
    // `servers` became empty and was pruned; a file left as `{}` is deleted.
    expect(await exists(file)).toBe(false);
  });

  it('rejects a non-object where an object is needed', async () => {
    const file = path.join(await tmpDir(), 'x.json');
    await write(file, '{"hooks": []}');
    await expect(mergeJsonFile(file, '/hooks/Stop', undefined, {}, { dryRun: false })).rejects.toMatchObject({ code: 'E_PARSE' });
  });
});

describe('unmergeJsonFile', () => {
  it('removes array items by deep equality and object keys, leaving everything else', async () => {
    const file = path.join(await tmpDir(), 'settings.json');
    await write(file, JSON.stringify({ theme: 'dark', hooks: { Stop: [{ command: 'user' }] }, mcpServers: { mine: { command: 'x' } } }));
    const a = await mergeJsonFile(file, '/hooks/Stop', undefined, { command: 'palm' }, { dryRun: false });
    const b = await mergeJsonFile(file, '/mcpServers', 'palm', { command: 'y' }, { dryRun: false });
    await unmergeJsonFile(file, a);
    await unmergeJsonFile(file, b);
    expect(await readJson(file)).toEqual({ theme: 'dark', hooks: { Stop: [{ command: 'user' }] }, mcpServers: { mine: { command: 'x' } } });
  });

  it('keeps a key whose palm-written value was changed; tolerates added keys', async () => {
    const file = path.join(await tmpDir(), 'm.json');
    const rec = await mergeJsonFile(file, '/mcpServers', 's', { command: 'x' }, { dryRun: false });
    await write(file, JSON.stringify({ mcpServers: { s: { command: 'changed' } } }));
    await unmergeJsonFile(file, rec);
    expect(await readJson(file)).toEqual({ mcpServers: { s: { command: 'changed' } } });
    await write(file, JSON.stringify({ mcpServers: { s: { command: 'x', disabled: true } }, theme: 'dark' }));
    await unmergeJsonFile(file, rec);
    expect(await readJson(file)).toEqual({ theme: 'dark' });
  });

  it('prunes containers it emptied (never the root) and deletes a file left as {}', async () => {
    const file = path.join(await tmpDir(), 'settings.json');
    await write(file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));
    const rec = await mergeJsonFile(file, '/hooks/SessionStart', undefined, { hooks: [{ type: 'command', command: 'x' }] }, { dryRun: false });
    await unmergeJsonFile(file, rec);
    expect(await readJson(file)).toEqual({ permissions: { allow: ['Bash(ls:*)'] } });
    const only = path.join(path.dirname(file), '.mcp.json');
    const r2 = await mergeJsonFile(only, '/mcpServers', 'fs', { command: 'npx' }, { dryRun: false });
    await unmergeJsonFile(only, r2);
    expect(await exists(only)).toBe(false);
  });

  it('is a no-op for missing files and pointers', async () => {
    const dir = await tmpDir();
    await unmergeJsonFile(path.join(dir, 'nope.json'), { file: 'x', pointer: '/a/b', value: 1 });
    const file = path.join(dir, 'f.json');
    await write(file, '{"a":1}');
    await unmergeJsonFile(file, { file, pointer: '/b/c', value: 1 });
    expect(await read(file)).toBe('{"a":1}');
  });
});

describe('helpers', () => {
  it('ensureJsonKey sets a missing key once', async () => {
    const file = path.join(await tmpDir(), 'hooks.json');
    expect(await ensureJsonKey(file, '', 'version', 1, { dryRun: false })).toBe(true);
    await write(file, '{"version":2}');
    expect(await ensureJsonKey(file, '', 'version', 1, { dryRun: false })).toBe(false);
    expect(await readJson(file)).toEqual({ version: 2 });
  });

  it('parseJsonc keeps comment-like text inside strings', () => {
    expect(parseJsonc('{"a":"/* x */ // y", /* c */ "b":[1,2,],}', 'f')).toEqual({ a: '/* x */ // y', b: [1, 2] });
    expect(() => parseJsonc('{"a":', 'f')).toThrowError(/cannot parse f/);
  });
});
