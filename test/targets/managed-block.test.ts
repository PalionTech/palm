import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeManagedBlock, upsertManagedBlock } from '../../src/targets/managed-block.js';
import { cleanupTmp, exists, read, tmpDir, write } from './helpers.js';

afterEach(cleanupTmp);

const USER = '# Project\n\nUser text stays.\n';

describe('managed blocks', () => {
  it('creates the file when missing and records the block', async () => {
    const file = path.join(await tmpDir(), 'AGENTS.md');
    const rec = await upsertManagedBlock(file, 'instruction:ts', 'Use strict.\n', {
      dryRun: false,
    });
    expect(rec).toEqual({ file, pointer: 'block:instruction:ts', value: 'Use strict.\n' });
    expect(await read(file)).toBe(
      '<!-- palm:begin instruction:ts -->\nUse strict.\n<!-- palm:end instruction:ts -->\n',
    );
  });

  it('upserting twice yields one block; update keeps surrounding text byte-identical', async () => {
    const file = path.join(await tmpDir(), 'AGENTS.md');
    await write(file, USER);
    await upsertManagedBlock(file, 'instruction:ts', 'A\n', { dryRun: false });
    await upsertManagedBlock(file, 'instruction:ts', 'A\n', { dryRun: false });
    const once = `${USER}\n<!-- palm:begin instruction:ts -->\nA\n<!-- palm:end instruction:ts -->\n`;
    expect(await read(file)).toBe(once);
    await write(file, once + '\nMore user text.\n');
    await upsertManagedBlock(file, 'instruction:ts', 'B\nC\n', { dryRun: false });
    expect(await read(file)).toBe(
      `${USER}\n<!-- palm:begin instruction:ts -->\nB\nC\n<!-- palm:end instruction:ts -->\n\nMore user text.\n`,
    );
  });

  it('adds a trailing newline and a separating blank line to files without one', async () => {
    const file = path.join(await tmpDir(), 'AGENTS.md');
    await write(file, 'no newline');
    await upsertManagedBlock(file, 'x', 'c', { dryRun: false });
    expect(await read(file)).toBe('no newline\n\n<!-- palm:begin x -->\nc\n<!-- palm:end x -->\n');
  });

  it('conflict mode and dryRun', async () => {
    const file = path.join(await tmpDir(), 'AGENTS.md');
    await upsertManagedBlock(file, 'x', 'one', { dryRun: false });
    await expect(
      upsertManagedBlock(file, 'x', 'two', { dryRun: false, onConflict: 'error' }),
    ).rejects.toMatchObject({ code: 'E_CONFLICT' });
    await upsertManagedBlock(file, 'y', 'two', { dryRun: true });
    expect(await read(file)).toBe('<!-- palm:begin x -->\none\n<!-- palm:end x -->\n');
  });

  it('removal restores the original text and deletes files left empty', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'AGENTS.md');
    await write(file, USER);
    await upsertManagedBlock(file, 'a', 'A', { dryRun: false });
    await upsertManagedBlock(file, 'b', 'B', { dryRun: false });
    await removeManagedBlock(file, 'a');
    await removeManagedBlock(file, 'b');
    expect(await read(file)).toBe(USER);
    await removeManagedBlock(file, 'b');
    const other = path.join(dir, 'other.md');
    await upsertManagedBlock(other, 'a', 'A', { dryRun: false });
    await removeManagedBlock(other, 'a');
    expect(await exists(other)).toBe(false);
    await removeManagedBlock(path.join(dir, 'missing.md'), 'a');
  });
});
