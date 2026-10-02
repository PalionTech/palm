/**
 * lib rulings from the 0.2 persona rerun (FINDINGS-v2.md): a write under a dangling directory
 * link creates the link's target and goes through it in one run (Z4), and the did-you-mean
 * helper the manifest loader and the matcher share.
 */
import { lstat, mkdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDir, writeFileAtomic } from '../../src/lib/fs.js';
import { closestWord, editDistance } from '../../src/lib/text.js';
import { cleanupTmp, tmpDir } from '../support/sandbox.js';

afterEach(cleanupTmp);

describe('Z4 a dangling directory link is written through in one run', () => {
  it('Z4 creates the target of .claude/skills/x -> ../../.agents/skills/x and writes the file', async () => {
    const root = await tmpDir();
    await mkdir(join(root, '.claude', 'skills'), { recursive: true });
    const link = join(root, '.claude', 'skills', 'convex');
    await symlink('../../.agents/skills/convex', link);
    await writeFileAtomic(join(link, 'SKILL.md'), 'Convex.\n');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(root, '.agents', 'skills', 'convex', 'SKILL.md'), 'utf8')).toBe(
      'Convex.\n',
    );
    expect(await readFile(join(link, 'SKILL.md'), 'utf8')).toBe('Convex.\n');
  });

  it('Z4 ensureDir goes through a dangling link too, and a plain missing path still works', async () => {
    const root = await tmpDir();
    await symlink(join(root, 'real', 'dir'), join(root, 'link'));
    await ensureDir(join(root, 'link', 'sub'));
    expect((await lstat(join(root, 'real', 'dir', 'sub'))).isDirectory()).toBe(true);
    await writeFileAtomic(join(root, 'a', 'b', 'c.txt'), 'x');
    expect(await readFile(join(root, 'a', 'b', 'c.txt'), 'utf8')).toBe('x');
  });
});

describe('did-you-mean', () => {
  it('B4 closestWord finds a near key and nothing for a far one', () => {
    expect(closestWord('target', ['name', 'targets', 'at'])).toBe('targets');
    expect(closestWord('reff', ['url', 'ref', 'root'])).toBe('ref');
    expect(closestWord('registry', ['transport', 'command', 'url'])).toBeUndefined();
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});
