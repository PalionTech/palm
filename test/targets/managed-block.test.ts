import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type MdBlockRecord, toStored } from '../../src/domain/merged-record.js';
import {
  type BlockEdit,
  removeManagedBlock,
  upsertBlockText,
} from '../../src/targets/managed-block.js';
import { applyText, cleanupTmp, exists, read, tmpDir, write } from './helpers.js';

afterEach(cleanupTmp);

const USER = '# Project\n\nUser text stays.\n';

/** Plan-and-write a block the way a deploy does; the record the planner stores. */
async function upsert(
  file: string,
  id: string,
  content: string,
  opts: Partial<BlockEdit> = {},
): Promise<MdBlockRecord> {
  await applyText(file, (text) => upsertBlockText(text, { ...opts, file, id, content }));
  return { type: 'md-block', file, id, content };
}

describe('managed blocks', () => {
  it('creates the file when missing and records the block', async () => {
    const file = path.join(await tmpDir(), 'AGENTS.md');
    const rec = await upsert(file, 'instruction:ts', 'Use strict.\n');
    // lockfile form
    expect(toStored(rec)).toEqual({
      file,
      pointer: 'block:instruction:ts',
      value: 'Use strict.\n',
    });
    expect(await read(file)).toBe(
      '<!-- palm:begin instruction:ts -->\nUse strict.\n<!-- palm:end instruction:ts -->\n',
    );
  });

  it('upserting twice yields one block; update keeps surrounding text byte-identical', async () => {
    const file = path.join(await tmpDir(), 'AGENTS.md');
    await write(file, USER);
    await upsert(file, 'instruction:ts', 'A\n');
    await upsert(file, 'instruction:ts', 'A\n');
    const once = `${USER}\n<!-- palm:begin instruction:ts -->\nA\n<!-- palm:end instruction:ts -->\n`;
    expect(await read(file)).toBe(once);
    expect(upsertBlockText(once, { file, id: 'instruction:ts', content: 'A\n' })).toBeUndefined();
    await write(file, `${once}\nMore user text.\n`);
    await upsert(file, 'instruction:ts', 'B\nC\n');
    expect(await read(file)).toBe(
      `${USER}\n<!-- palm:begin instruction:ts -->\nB\nC\n<!-- palm:end instruction:ts -->\n\nMore user text.\n`,
    );
  });

  it('adds a trailing newline and a separating blank line to files without one', () => {
    expect(upsertBlockText('no newline', { file: 'AGENTS.md', id: 'x', content: 'c' })).toBe(
      'no newline\n\n<!-- palm:begin x -->\nc\n<!-- palm:end x -->\n',
    );
  });

  it('conflict mode: a different block is E_CONFLICT, default replaces it', () => {
    const text = '<!-- palm:begin x -->\none\n<!-- palm:end x -->\n';
    const edit = { file: 'AGENTS.md', id: 'x', content: 'two' };
    expect(() => upsertBlockText(text, { ...edit, onConflict: 'error' })).toThrow(
      expect.objectContaining({ code: 'E_CONFLICT' }),
    );
    expect(upsertBlockText(text, edit)).toBe('<!-- palm:begin x -->\ntwo\n<!-- palm:end x -->\n');
  });

  it('removal restores the original text and deletes files left empty', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'AGENTS.md');
    await write(file, USER);
    await upsert(file, 'a', 'A');
    await upsert(file, 'b', 'B');
    await removeManagedBlock(file, 'a');
    await removeManagedBlock(file, 'b');
    expect(await read(file)).toBe(USER);
    await removeManagedBlock(file, 'b');
    const other = path.join(dir, 'other.md');
    await upsert(other, 'a', 'A');
    await removeManagedBlock(other, 'a');
    expect(await exists(other)).toBe(false);
    await removeManagedBlock(path.join(dir, 'missing.md'), 'a');
  });
});
