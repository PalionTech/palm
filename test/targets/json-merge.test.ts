import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fragmentKey } from '../../src/domain/lock.js';
import type { MergedRecord } from '../../src/domain/merged-record.js';
import { formatPointer } from '../../src/lib/json-pointer.js';
import {
  appendItemText,
  ensureKeyText,
  type JsonEdit,
  jsonRecordState,
  setKeyText,
  unmergeJsonFile,
} from '../../src/targets/json-merge.js';
import { applyText, cleanupTmp, exists, read, readJson, tmpDir, write } from './helpers.js';

afterEach(cleanupTmp);

type JsonRecord = Extract<MergedRecord, { type: 'json-item' | 'json-key' }>;

/** Merge an array item the way an apply does; the record its fragment names. */
async function appendItem(file: string, segs: string[], value: unknown): Promise<JsonRecord> {
  await applyText(file, (text) => appendItemText(text, { file, path: segs, value }));
  const key = fragmentKey(formatPointer(segs), value);
  return { type: 'json-item', file, path: segs, id: 'palm:hook:x:0', key, value };
}

/** Set an object key the way an apply does; the record its fragment names. */
async function setKey(
  file: string,
  segs: string[],
  value: unknown,
  opts: Partial<JsonEdit> = {},
): Promise<JsonRecord> {
  await applyText(file, (text) => setKeyText(text, { ...opts, file, path: segs, value }));
  return { type: 'json-key', file, path: segs, id: 'palm:mcp:x:0', key: segs.at(-1) ?? '', value };
}

const HOOK = { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 5 }] };

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

  it('finds an item by key: identical is a no-op, other keys are appended', async () => {
    const file = path.join(await tmpDir(), 'hooks.json');
    await appendItem(file, ['hooks', 'stop'], { command: 'a' });
    expect(
      appendItemText(await read(file), { file, path: ['hooks', 'stop'], value: { command: 'a' } }),
    ).toBeUndefined();
    await appendItem(file, ['hooks', 'stop'], { command: 'b' });
    expect(await readJson(file)).toEqual({ hooks: { stop: [{ command: 'a' }, { command: 'b' }] } });
  });

  it('an item found by key with another value is replaced in place, or E_CONFLICT', () => {
    const text = JSON.stringify({ hooks: { PreToolUse: [{ command: 'user' }, HOOK] } });
    const edited = { ...HOOK, hooks: [{ ...HOOK.hooks[0], timeout: 60 }] };
    const edit = { file: 's.json', path: ['hooks', 'PreToolUse'], value: edited };
    expect(() => appendItemText(text, { ...edit, onConflict: 'error' })).toThrow(
      expect.objectContaining({ code: 'E_CONFLICT' }),
    );
    expect(JSON.parse(appendItemText(text, edit) as string)).toEqual({
      hooks: { PreToolUse: [{ command: 'user' }, edited] },
    });
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
    expect(formatPointer(rec.path)).toBe('/servers/io.github~1x~0y');
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

describe('jsonRecordState', () => {
  it('json-item: found by key; a changed value is `changed`, an absent key `missing`', async () => {
    const file = path.join(await tmpDir(), 'settings.json');
    const rec = await appendItem(file, ['hooks', 'PreToolUse'], HOOK);
    expect(jsonRecordState(await read(file), rec)).toBe('held');
    const edited = { ...HOOK, hooks: [{ ...HOOK.hooks[0], timeout: 60 }] };
    await write(file, JSON.stringify({ hooks: { PreToolUse: [edited] } }));
    expect(jsonRecordState(await read(file), rec)).toBe('changed');
    await write(file, JSON.stringify({ hooks: { PreToolUse: [{ ...HOOK, matcher: 'Edit' }] } }));
    expect(jsonRecordState(await read(file), rec)).toBe('missing');
    expect(jsonRecordState(undefined, rec)).toBe('missing');
    expect(jsonRecordState('{', rec)).toBe('changed');
  });

  it('json-key: `${VAR}` in what palm writes matches a literal on disk; another value is changed', () => {
    const rec: JsonRecord = {
      type: 'json-key',
      file: 'm.json',
      path: ['mcpServers', 's'],
      id: 'palm:mcp:s:0',
      key: 's',
      value: { command: 'x', env: { TOKEN: '${TOKEN}' } },
    };
    const on = (s: unknown) => JSON.stringify({ mcpServers: { s } });
    expect(jsonRecordState(on({ command: 'x', env: { TOKEN: 'abc' } }), rec)).toBe('held');
    expect(jsonRecordState(on({ command: 'y', env: { TOKEN: 'abc' } }), rec)).toBe('changed');
    expect(jsonRecordState(on({ command: 'x', env: { TOKEN: 'a' }, extra: 1 }), rec)).toBe(
      'changed',
    );
    expect(jsonRecordState('{}', rec)).toBe('missing');
  });
});

describe('unmergeJsonFile', () => {
  it('removes the item and the key found by key, leaving everything else', async () => {
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

  it('removes by key even when the value changed (the engine decides before undeploy)', async () => {
    const file = path.join(await tmpDir(), 's.json');
    const rec = await appendItem(file, ['hooks', 'PreToolUse'], HOOK);
    const edited = { ...HOOK, hooks: [{ ...HOOK.hooks[0], timeout: 60 }] };
    await write(file, JSON.stringify({ theme: 'x', hooks: { PreToolUse: [edited] } }));
    await unmergeJsonFile(file, rec);
    expect(await readJson(file)).toEqual({ theme: 'x' });
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

  it('is a no-op for missing files, paths and keys', async () => {
    const dir = await tmpDir();
    const rec = (type: JsonRecord['type'], segs: string[], file: string): JsonRecord => ({
      type,
      file,
      path: segs,
      id: 'palm:x:y:0',
      key: 'k',
      value: 1,
    });
    await unmergeJsonFile(path.join(dir, 'nope.json'), rec('json-key', ['a', 'b'], 'x'));
    const file = path.join(dir, 'f.json');
    await write(file, '{"a":1,"hooks":{"Stop":[{"command":"u"}]}}');
    await unmergeJsonFile(file, rec('json-key', ['b', 'c'], file));
    await unmergeJsonFile(file, rec('json-item', ['a'], file));
    await unmergeJsonFile(file, rec('json-item', ['hooks', 'Stop'], file));
    expect(await read(file)).toBe('{"a":1,"hooks":{"Stop":[{"command":"u"}]}}');
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
