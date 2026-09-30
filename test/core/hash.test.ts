import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPath, hashValue, short, treeHash } from '../../src/core/hash.js';
import { shouldSkipFile } from '../../src/domain/ignore.js';
import { walkFiles } from '../../src/lib/fs.js';
import { removeDir, tempDir, writeFiles } from '../support/sandbox.js';

/** The copy walk targets deploy with: COPY_SKIP by name, links only inside the boundary. */
const copyWalk = (root: string, opts: { boundary?: string } = {}) =>
  walkFiles(root, { ...opts, skip: (name) => shouldSkipFile(name) });

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

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

describe('hashPath: LF content hashes are unchanged by the walker and CRLF rewrite', () => {
  // Recorded with the pre-wave-2D implementation (lstat walk, `.git` skipped, raw bytes).
  it.each([
    [
      'vercel-like/skills/react-best-practices',
      'sha256:905ae7881666bb0123164f88b3cc50eee785a6f5c308613c75207d02cfbbcefe',
    ],
    [
      'anthropics-skills-like/skills/pdf',
      'sha256:5589e92464ea180e55a60898a3c7479f65ae71aea3a940ce9a7184af6bc7e640',
    ],
    [
      'anthropics-skills-like/skills/pdf/SKILL.md',
      'sha256:c717af2cd29f06b9127873121971bb1f12f165f693fbbb1c5ca3b1861627cc47',
    ],
    [
      'claude-plugins-official-like',
      'sha256:1fbb70c14867e3fd3a28589983b874cea7b430dc0729ebdd5ff79bd2be232ac7',
    ],
  ])('%s', async (rel, hash) => {
    expect(await hashPath(join(FIXTURES, rel))).toBe(hash);
  });
});

describe('hashPath: CRLF', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => removeDir(dir));

  const LF = '---\nname: s\n---\n\nline one\nline two\n';
  const CRLF = LF.replaceAll('\n', '\r\n');

  it('a core.autocrlf checkout hashes like the LF checkout (files and directories)', async () => {
    await writeFiles(join(dir, 'lf'), { 'SKILL.md': LF, 'scripts/run.sh': 'echo hi\n' });
    await writeFiles(join(dir, 'crlf'), { 'SKILL.md': CRLF, 'scripts/run.sh': 'echo hi\r\n' });
    expect(await hashPath(join(dir, 'crlf'))).toBe(await hashPath(join(dir, 'lf')));
    expect(await hashPath(join(dir, 'crlf', 'SKILL.md'))).toBe(
      await hashPath(join(dir, 'lf', 'SKILL.md')),
    );
  });

  it('leaves binary content (a NUL in the first 8 KB) and lone CRs alone', async () => {
    const binLf = Buffer.from('\u0000bin\nary\n', 'latin1');
    const binCrlf = Buffer.from('\u0000bin\r\nary\r\n', 'latin1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'lf.bin'), binLf);
    await writeFile(join(dir, 'crlf.bin'), binCrlf);
    expect(await hashPath(join(dir, 'crlf.bin'))).not.toBe(await hashPath(join(dir, 'lf.bin')));
    await writeFile(join(dir, 'cr.txt'), 'a\rb\r');
    await writeFile(join(dir, 'lf.txt'), 'a\nb\n');
    expect(await hashPath(join(dir, 'cr.txt'))).not.toBe(await hashPath(join(dir, 'lf.txt')));
  });

  it('a NUL after the first 8 KB still counts as text', async () => {
    const head = 'x'.repeat(8192);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'crlf.txt'), `${head}\r\n\u0000`);
    await writeFile(join(dir, 'lf.txt'), `${head}\n\u0000`);
    expect(await hashPath(join(dir, 'crlf.txt'))).toBe(await hashPath(join(dir, 'lf.txt')));
  });
});

describe('hashPath: one walk policy with the copy (the copy walk)', () => {
  let origin: string;
  let outside: string;
  beforeEach(async () => {
    origin = await tempDir();
    outside = await tempDir();
  });
  afterEach(async () => {
    await removeDir(origin);
    await removeDir(outside);
  });

  it('skips what the copy skips: .git, node_modules, .DS_Store, *.zip', async () => {
    await writeFiles(join(origin, 'a'), { 'SKILL.md': 'x' });
    await writeFiles(join(origin, 'b'), {
      'SKILL.md': 'x',
      '.git/HEAD': 'ref',
      'node_modules/x/index.js': 'junk',
      '.DS_Store': 'finder',
      'bundle.ZIP': 'PK',
    });
    expect(await hashPath(join(origin, 'b'))).toBe(await hashPath(join(origin, 'a')));
    const { files } = await copyWalk(join(origin, 'b'));
    expect(files.map((f) => f.rel)).toEqual(['SKILL.md']);
  });

  it('an in-origin symlinked file is hashed by content: link or file, the hash is the same', async () => {
    await writeFiles(origin, {
      'shared/ref.md': 'v1',
      'shared/other.md': 'v2',
      'skills/linked/SKILL.md': 's',
      'skills/plain/SKILL.md': 's',
      'skills/plain/ref.md': 'v1',
    });
    const linked = join(origin, 'skills/linked');
    const plain = join(origin, 'skills/plain');
    await symlink(join(origin, 'shared/ref.md'), join(linked, 'ref.md'));
    const hash = (p: string) => hashPath(p, { boundary: origin });

    const before = await hash(linked);
    expect(before).toBe(await hash(plain));
    // The copy deploys the same file set.
    expect((await copyWalk(linked, { boundary: origin })).files.map((f) => f.rel)).toEqual([
      'SKILL.md',
      'ref.md',
    ]);

    // Changing the file behind the link changes the hash exactly like editing a real file.
    await writeFile(join(origin, 'shared/ref.md'), 'v2');
    await writeFile(join(plain, 'ref.md'), 'v2');
    const edited = await hash(linked);
    expect(edited).not.toBe(before);
    expect(edited).toBe(await hash(plain));

    // Re-pointing the link at another file with that content leaves the hash alone.
    await rm(join(linked, 'ref.md'));
    await symlink(join(origin, 'shared/other.md'), join(linked, 'ref.md'));
    expect(await hash(linked)).toBe(edited);
  });

  it('a symlink leaving the origin is neither copied nor hashed', async () => {
    await writeFile(join(outside, 'secret'), 'id_rsa');
    await writeFiles(origin, { 'skills/s/SKILL.md': 's', 'skills/clean/SKILL.md': 's' });
    const skill = join(origin, 'skills/s');
    await symlink(join(outside, 'secret'), join(skill, 'leak.md'));
    await symlink(outside, join(skill, 'refs'));

    const hashed = await hashPath(skill, { boundary: origin });
    expect(hashed).toBe(await hashPath(join(origin, 'skills/clean'), { boundary: origin }));
    await writeFile(join(outside, 'secret'), 'rotated');
    expect(await hashPath(skill, { boundary: origin })).toBe(hashed);

    const { files, skipped } = await copyWalk(skill, { boundary: origin });
    expect(files.map((f) => f.rel)).toEqual(['SKILL.md']);
    expect(skipped).toEqual(['leak.md', 'refs']);
  });

  it('a symlinked entity root inside the origin is hashed; one leaving it is an E_IO error', async () => {
    await writeFiles(origin, { 'real/SKILL.md': 's' });
    await symlink(join(origin, 'real'), join(origin, 'alias'));
    expect(await hashPath(join(origin, 'alias'), { boundary: origin })).toBe(
      await hashPath(join(origin, 'real')),
    );
    await writeFiles(outside, { 'SKILL.md': 's' });
    await symlink(outside, join(origin, 'escape'));
    await expect(hashPath(join(origin, 'escape'), { boundary: origin })).rejects.toMatchObject({
      code: 'E_IO',
    });
  });
});

describe('treeHash', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => removeDir(dir));
  const none = { skip: () => false };

  it('lists files with 755/644 modes and content hashes, sorted', async () => {
    await writeFiles(dir, { 'b.md': 'b', 'hooks/run.sh': 'echo\n' });
    await chmod(join(dir, 'hooks/run.sh'), 0o700);
    const { tree, files } = await treeHash(dir, none);
    expect(tree).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(files.map((f) => [f.path, f.mode])).toEqual([
      ['b.md', 0o644],
      ['hooks/run.sh', 0o755],
    ]);
    expect(files[0]?.hash).toMatch(/^sha256:/);
    expect(short(tree)).toHaveLength(8);
  });

  it('does not depend on creation order or line endings, and moves with a byte or a mode', async () => {
    const names = ['z.md', 'a/b.md', 'a/c.sh', 'm.txt'];
    const make = async (root: string, order: string[], eol: string) => {
      for (const n of order) await writeFiles(root, { [n]: `line one${eol}line two${eol}` });
      return (await treeHash(root, none)).tree;
    };
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(names, { minLength: 4, maxLength: 4 }),
        async (order) => {
          run++;
          expect(await make(join(dir, `crlf-${run}`), order, '\r\n')).toBe(
            await make(join(dir, `lf-${run}`), names, '\n'),
          );
        },
      ),
      { numRuns: 5 },
    );
    const base = join(dir, 'base');
    const tree = await make(base, names, '\n');
    await writeFile(join(base, 'm.txt'), 'line one\nline 2\n');
    expect((await treeHash(base, none)).tree).not.toBe(tree);
    await writeFile(join(base, 'm.txt'), 'line one\nline two\n');
    expect((await treeHash(base, none)).tree).toBe(tree);
    await chmod(join(base, 'a/c.sh'), 0o755);
    expect((await treeHash(base, none)).tree).not.toBe(tree);
  });

  it('skip(rel) leaves files and directories out', async () => {
    await writeFiles(dir, { 'keep.md': 'k', 'out/x.md': 'x', '.claude/skills/s/SKILL.md': 's' });
    const skip = (rel: string) => rel === 'out' || rel.startsWith('.claude');
    const { files } = await treeHash(dir, { skip });
    expect(files.map((f) => f.path)).toEqual(['keep.md']);
  });
});
