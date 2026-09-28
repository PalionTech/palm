import { chmod, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { walkFiles } from '../../src/lib/fs.js';
import { cleanupTmp, tmpDir, write } from '../support/sandbox.js';

afterEach(cleanupTmp);

describe('walkFiles', () => {
  it('lists regular files depth first with sorted names, posix rel paths and modes', async () => {
    const root = await tmpDir();
    await write(join(root, 'b.md'), 'b');
    await write(join(root, 'a/z.md'), 'z');
    await write(join(root, 'a/y/x.sh'), 'x', 0o755);
    await write(join(root, 'a-c.md'), 'c');
    const { files, skipped } = await walkFiles(root);
    expect(files.map((f) => f.rel)).toEqual(['a/y/x.sh', 'a/z.md', 'a-c.md', 'b.md']);
    expect(files[0]).toEqual({ rel: 'a/y/x.sh', abs: join(root, 'a/y/x.sh'), mode: 0o755 });
    expect(skipped).toEqual([]);
  });

  it('skip() drops entries by name before they are examined, at any depth', async () => {
    const root = await tmpDir();
    await write(join(root, 'keep.md'), 'k');
    await write(join(root, 'junk/a.md'), 'j');
    await write(join(root, 'sub/junk'), 'file named junk');
    await symlink('/nonexistent', join(root, 'junk-link'));
    const seen: string[] = [];
    const { files, skipped } = await walkFiles(root, {
      skip: (name, rel) => {
        seen.push(rel);
        return name.startsWith('junk');
      },
    });
    expect(files.map((f) => f.rel)).toEqual(['keep.md']);
    expect(skipped).toEqual([]); // the broken link was skipped by name, never examined
    expect(seen).toContain('sub/junk');
  });

  it('follows links inside the boundary, reports links leaving it and broken ones', async () => {
    const origin = await tmpDir();
    const outside = await tmpDir();
    await write(join(outside, 'secret'), 'nope');
    await write(join(origin, 'shared/ref.md'), 'shared');
    const skill = join(origin, 'skills/s');
    await write(join(skill, 'SKILL.md'), 'skill');
    await symlink(join(origin, 'shared'), join(skill, 'shared'));
    await symlink(join(origin, 'shared/ref.md'), join(skill, 'ref.md'));
    await symlink(join(outside, 'secret'), join(skill, 'leak.md'));
    await symlink(outside, join(skill, 'out'));
    await symlink(join(skill, 'missing'), join(skill, 'broken'));

    const inOrigin = await walkFiles(skill, { boundary: origin });
    expect(inOrigin.files.map((f) => f.rel)).toEqual(['SKILL.md', 'ref.md', 'shared/ref.md']);
    expect(inOrigin.files.find((f) => f.rel === 'ref.md')?.abs).toBe(join(skill, 'ref.md'));
    expect(inOrigin.skipped).toEqual(['broken', 'leak.md', 'out']);

    // Default boundary: the root itself, so links to siblings in the origin are not followed.
    const own = await walkFiles(skill);
    expect(own.files.map((f) => f.rel)).toEqual(['SKILL.md']);
    expect(own.skipped).toEqual(['broken', 'leak.md', 'out', 'ref.md', 'shared']);
  });

  it('a root that resolves outside the boundary yields nothing', async () => {
    const origin = await tmpDir();
    const outside = await tmpDir();
    await write(join(outside, 'x.md'), 'x');
    await symlink(outside, join(origin, 'link'));
    expect(await walkFiles(join(origin, 'link'), { boundary: origin })).toEqual({
      files: [],
      skipped: ['.'],
    });
    // Without a boundary a symlinked root is its own boundary.
    expect((await walkFiles(join(origin, 'link'))).files.map((f) => f.rel)).toEqual(['x.md']);
  });

  it('walks each real directory once, so links cannot loop', async () => {
    const root = await tmpDir();
    await write(join(root, 'a/f.md'), 'f');
    await symlink(root, join(root, 'a/up'));
    await symlink(join(root, 'a'), join(root, 'b'));
    const { files, skipped } = await walkFiles(root);
    expect(files.map((f) => f.rel)).toEqual(['a/f.md']);
    expect(skipped).toEqual([]);
  });

  it('propagates readdir errors: a missing root, an unreadable directory', async () => {
    const root = await tmpDir();
    await mkdir(join(root, 'locked'));
    await write(join(root, 'ok.md'), 'ok');
    await expect(walkFiles(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    await chmod(join(root, 'locked'), 0o000);
    try {
      if (process.getuid?.() === 0) return; // root reads anything
      await expect(walkFiles(root)).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(join(root, 'locked'), 0o755);
    }
  });
});
