import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPath, hashValue } from '../../src/core/hash.js';
import { removeDir, tempDir, writeFiles } from '../support/sandbox.js';

describe('hashPath', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => removeDir(dir));

  it('is deterministic for directories and ignores .git', async () => {
    await writeFiles(join(dir, 'a'), {
      'SKILL.md': 'hello',
      'scripts/run.sh': 'echo hi',
      '.git/HEAD': 'x',
    });
    await writeFiles(join(dir, 'b'), { 'scripts/run.sh': 'echo hi', 'SKILL.md': 'hello' });
    const ha = await hashPath(join(dir, 'a'));
    expect(ha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await hashPath(join(dir, 'a'))).toBe(ha);
    expect(await hashPath(join(dir, 'b'))).toBe(ha);
    await writeFile(join(dir, 'b', 'SKILL.md'), 'changed');
    expect(await hashPath(join(dir, 'b'))).not.toBe(ha);
  });

  it('distinguishes renamed files', async () => {
    await writeFiles(join(dir, 'a'), { 'x.md': 'same' });
    await writeFiles(join(dir, 'b'), { 'y.md': 'same' });
    expect(await hashPath(join(dir, 'a'))).not.toBe(await hashPath(join(dir, 'b')));
  });

  it('hashes single files and fails on missing paths', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'f.md'), 'content');
    expect(await hashPath(join(dir, 'f.md'))).toBe(await hashPath(join(dir, 'f.md')));
    await expect(hashPath(join(dir, 'missing'))).rejects.toMatchObject({ code: 'E_IO' });
  });

  it('hashValue ignores key order', () => {
    expect(hashValue({ a: 1, b: [1, 2] })).toBe(hashValue({ b: [1, 2], a: 1 }));
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });
});
