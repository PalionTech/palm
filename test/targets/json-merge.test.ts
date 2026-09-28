import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonItemRecord, JsonKeyRecord } from '../../src/domain/merged-record.js';
import { toStored } from '../../src/domain/merged-record.js';
import {
  appendItemText,
  ensureKeyText,
  type JsonEdit,
  setKeyText,
  unmergeJsonFile,
} from '../../src/targets/json-merge.js';
import { applyText, cleanupTmp, exists, read, readJson, tmpDir, write } from './helpers.js';

afterEach(cleanupTmp);

/** Plan-and-write an array item the way a deploy does; the record the planner stores. */
async function appendItem(file: string, path: string[], value: unknown): Promise<JsonItemRecord> {
  await applyText(file, (text) => appendItemText(text, { file, path, value }));
  return { type: 'json-item', file, path, value };
}

/** Plan-and-write an object key the way a deploy does; the record the planner stores. */
async function setKey(
  file: string,
  path: string[],
  value: unknown,
  opts: Partial<JsonEdit> = {},
): Promise<JsonKeyRecord> {
  await applyText(file, (text) => setKeyText(text, { ...opts, file, path, value }));
  return { type: 'json-key', file, path, value };
}

describe('setKeyText / appendItemText', () => {
  it('creates the document and intermediate objects', () => {
    expect(
      setKeyText(undefined, { file: 'f', path: ['mcpServers', 'fs'], value: { command: 'npx' } }),
    ).toBe('{\n  "mcpServers": {\n    "fs": {\n      "command": "npx"\n    }\n  }\n}\n');
  });

  it('tolerates JSONC comments and trailing commas, keeps unrelated keys, writes plain JSON', () => {
    const text =
      '{\n  // user comment\n  "theme": "dark", /* inline */\n  "url": "http://x//y",\n  "hooks": {},\n}\n';
    const next = appendItemText(text, {
      file: 'settings.json',
      path: ['hooks', 'Stop'],
      value: { hooks: [{ type: 'command', command: 'x' }] },
    });
    expect(JSON.parse(next as string)).toEqual({
      theme: 'dark',
      url: 'http://x//y',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
    });
    expect(next).not.toContain('comment');
  });

  it('appends array items idempotently (a deep-equal item is unchanged)', async () => {
    const file = path.join(await tmpDir(), 'hooks.json');
    await appendItem(file, ['hooks', 'stop'], { command: 'a' });
    expect(
      appendItemText(await read(file), { file, path: ['hooks', 'stop'], value: { command: 'a' } }),
    ).toBeUndefined();
    await appendItem(file, ['hooks', 'stop'], { command: 'b' });
    expect(await readJson(file)).toEqual({ hooks: { stop: [{ command: 'a' }, { command: 'b' }] } });
  });

  it('conflicting key: error mode throws E_CONFLICT, default overwrites', () => {
    const text = '{"mcpServers":{"fs":{"command":"old"}}}';
    const edit = { file: 'mcp.json', path: ['mcpServers', 'fs'], value: { command: 'new' } };
    expect(() => setKeyText(text, { ...edit, onConflict: 'error' })).toThrow(
      expect.objectContaining({ code: 'E_CONFLICT' }),
    );
    expect(JSON.parse(setKeyText(text, edit) as string)).toEqual({
      mcpServers: { fs: { command: 'new' } },
    });
  });

  it('identical key value is not a conflict (and not a change)', () => {
    const text = '{"mcpServers":{"fs":{"command":"same"}}}';
    expect(
      setKeyText(text, {
        file: 'mcp.json',
        path: ['mcpServers', 'fs'],
        value: { command: 'same' },
        onConflict: 'error',
      }),
    ).toBeUndefined();
  });

  it('escapes pointer segments', async () => {
    const file = path.join(await tmpDir(), 'x.json');
    const rec = await setKey(file, ['servers', 'io.github/x~y'], { url: 'u' });
    expect(toStored(rec).pointer).toBe('/servers/io.github~1x~0y');
    await unmergeJsonFile(file, rec);
    // `servers` became empty and was pruned; a file left as `{}` is deleted.
    expect(await exists(file)).toBe(false);
  });

  it('rejects a non-object where an object is needed; the root is E_INTERNAL', () => {
    expect(() =>
      appendItemText('{"hooks": []}', { file: 'x.json', path: ['hooks', 'Stop'], value: {} }),
    ).toThrow(expect.objectContaining({ code: 'E_PARSE' }));
    expect(() => appendItemText('{}', { file: 'x.json', path: [], value: 1 })).toThrow(
      expect.objectContaining({ code: 'E_INTERNAL' }),
    );
    expect(() => setKeyText('{}', { file: 'x.json', path: [], value: 1 })).toThrow(
      expect.objectContaining({ code: 'E_INTERNAL' }),
    );
  });
});

describe('unmergeJsonFile', () => {
  it('removes array items by deep equality and object keys, leaving everything else', async () => {
    const file = path.join(await tmpDir(), 'settings.json');
    await write(
      file,
      JSON.stringify({
        theme: 'dark',
        hooks: { Stop: [{ command: 'user' }] },
        mcpServers: { mine: { command: 'x' } },
      }),
    );
    const a = await appendItem(file, ['hooks', 'Stop'], { command: 'palm' });
    const b = await setKey(file, ['mcpServers', 'palm'], { command: 'y' });
    await unmergeJsonFile(file, a);
    await unmergeJsonFile(file, b);
    expect(await readJson(file)).toEqual({
      theme: 'dark',
      hooks: { Stop: [{ command: 'user' }] },
      mcpServers: { mine: { command: 'x' } },
    });
  });

  it('keeps a key whose palm-written value was changed; tolerates added keys', async () => {
    const file = path.join(await tmpDir(), 'm.json');
    const rec = await setKey(file, ['mcpServers', 's'], { command: 'x' });
    await write(file, JSON.stringify({ mcpServers: { s: { command: 'changed' } } }));
    await unmergeJsonFile(file, rec);
    expect(await readJson(file)).toEqual({ mcpServers: { s: { command: 'changed' } } });
    await write(
      file,
      JSON.stringify({ mcpServers: { s: { command: 'x', disabled: true } }, theme: 'dark' }),
    );
    await unmergeJsonFile(file, rec);
    expect(await readJson(file)).toEqual({ theme: 'dark' });
  });

  it('prunes containers it emptied (never the root) and deletes a file left as {}', async () => {
    const file = path.join(await tmpDir(), 'settings.json');
    await write(file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));
    const rec = await appendItem(file, ['hooks', 'SessionStart'], {
      hooks: [{ type: 'command', command: 'x' }],
    });
    await unmergeJsonFile(file, rec);
    expect(await readJson(file)).toEqual({ permissions: { allow: ['Bash(ls:*)'] } });
    const only = path.join(path.dirname(file), '.mcp.json');
    const r2 = await setKey(only, ['mcpServers', 'fs'], { command: 'npx' });
    await unmergeJsonFile(only, r2);
    expect(await exists(only)).toBe(false);
  });

  it('is a no-op for missing files and pointers', async () => {
    const dir = await tmpDir();
    await unmergeJsonFile(path.join(dir, 'nope.json'), {
      type: 'json-key',
      file: 'x',
      path: ['a', 'b'],
      value: 1,
    });
    const file = path.join(dir, 'f.json');
    await write(file, '{"a":1}');
    await unmergeJsonFile(file, { type: 'json-key', file, path: ['b', 'c'], value: 1 });
    await unmergeJsonFile(file, { type: 'json-item', file, path: ['a'], value: 1 });
    expect(await read(file)).toBe('{"a":1}');
  });
});

describe('ensureKeyText', () => {
  it('sets a missing key once and never replaces an existing one', () => {
    const edit = { file: 'hooks.json', path: ['version'], value: 1 };
    expect(ensureKeyText(undefined, edit)).toBe('{\n  "version": 1\n}\n');
    expect(ensureKeyText('{"version":2}', edit)).toBeUndefined();
  });

  it('JSONC reading keeps comment-like text inside strings; invalid JSON is E_PARSE', () => {
    const edit = { file: '/x/settings.json', path: ['c'], value: 1 };
    const next = ensureKeyText('{"a":"/* x */ // y", /* c */ "b":[1,2,],}', edit);
    expect(JSON.parse(next as string)).toEqual({ a: '/* x */ // y', b: [1, 2], c: 1 });
    expect(() => ensureKeyText('{"a":', edit)).toThrow(
      expect.objectContaining({
        code: 'E_PARSE',
        message: expect.stringMatching(/^cannot parse .*settings\.json: /),
      }),
    );
  });
});
