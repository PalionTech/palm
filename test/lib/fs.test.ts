import { mkdir, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureDir,
  errnoCode,
  isEnoent,
  isWithin,
  pathExists,
  readJsonFile,
  readJsonIfExists,
  readTextIfExists,
  removeEmptyParents,
  removeEmptyTree,
  toPosix,
  writeFileAtomic,
  writeJsonFile,
} from '../../src/lib/fs.js';
import { cleanupTmp, exists, read, tmpDir, write } from '../support/sandbox.js';

afterEach(cleanupTmp);

const modeOf = async (p: string) => (await stat(p)).mode & 0o777;

describe('errnoCode / isEnoent', () => {
  it('reads string codes only', () => {
    expect(errnoCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT');
    expect(errnoCode({ code: 42 })).toBeUndefined();
    expect(errnoCode(new Error('x'))).toBeUndefined();
    expect(errnoCode(null)).toBeUndefined();
    expect(errnoCode('ENOENT')).toBeUndefined();
  });

  it('recognizes a real missing-file error', async () => {
    const dir = await tmpDir();
    const err = await stat(join(dir, 'missing')).catch((e: unknown) => e);
    expect(isEnoent(err)).toBe(true);
    expect(isEnoent(new Error('x'))).toBe(false);
  });
});

describe('isWithin', () => {
  it('is lexical containment, inclusive unless strict', () => {
    expect(isWithin('/a/b/c', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b', { strict: true })).toBe(false);
    expect(isWithin('/a/b/c', '/a/b', { strict: true })).toBe(true);
    expect(isWithin('/a/bc', '/a/b')).toBe(false);
    expect(isWithin('/a', '/a/b')).toBe(false);
    expect(isWithin('/x/y', '/a/b')).toBe(false);
    expect(isWithin('/a/b/../c', '/a/b')).toBe(false);
  });

  it('accepts names that merely start with two dots', () => {
    expect(isWithin('/a/b/..c', '/a/b')).toBe(true);
    expect(isWithin('/a/b/..', '/a/b')).toBe(false);
  });
});

describe('small helpers', () => {
  it('toPosix keeps posix paths', () => {
    expect(toPosix('a/b/c.md')).toBe('a/b/c.md');
  });

  it('pathExists and ensureDir', async () => {
    const dir = await tmpDir();
    const nested = join(dir, 'x', 'y');
    expect(await pathExists(nested)).toBe(false);
    await ensureDir(nested);
    await ensureDir(nested);
    expect(await pathExists(nested)).toBe(true);
    await symlink(join(dir, 'nowhere'), join(dir, 'broken'));
    expect(await pathExists(join(dir, 'broken'))).toBe(false);
  });

  it('readTextIfExists: undefined only for a missing file', async () => {
    const dir = await tmpDir();
    await write(join(dir, 'a.txt'), 'hi');
    expect(await readTextIfExists(join(dir, 'a.txt'))).toBe('hi');
    expect(await readTextIfExists(join(dir, 'missing.txt'))).toBeUndefined();
    await expect(readTextIfExists(dir)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('writeFileAtomic', () => {
  it('creates parent dirs and leaves no temp files', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'deep', 'er', 'f.txt');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, Buffer.from('two'));
    expect(await read(file)).toBe('two');
    expect(await readdir(join(dir, 'deep', 'er'))).toEqual(['f.txt']);
  });

  it('applies mode 0600 on create and on overwrite', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'secret.json');
    await writeFileAtomic(file, '{}', { mode: 0o600 });
    expect(await modeOf(file)).toBe(0o600);
    await write(file, 'x', 0o644);
    await writeFileAtomic(file, '{}', { mode: 0o600 });
    expect(await modeOf(file)).toBe(0o600);
  });

  it('keeps the existing permission bits without a mode', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'script.sh');
    await write(file, 'old', 0o750);
    await writeFileAtomic(file, 'new');
    expect(await modeOf(file)).toBe(0o750);
    expect(await read(file)).toBe('new');
  });

  it('removes the temp file and rethrows when the rename fails', async () => {
    const dir = await tmpDir();
    const target = join(dir, 'occupied');
    await mkdir(join(target, 'child'), { recursive: true });
    await expect(writeFileAtomic(target, 'x')).rejects.toHaveProperty('code');
    expect((await readdir(dir)).sort()).toEqual(['occupied']);
  });
});

describe('JSON files', () => {
  it('writeJsonFile + readJsonFile round-trip with 2-space indent', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'a', 'x.json');
    await writeJsonFile(file, { a: [1, 'b'] }, { mode: 0o600 });
    expect(await read(file)).toBe('{\n  "a": [\n    1,\n    "b"\n  ]\n}\n');
    expect(await modeOf(file)).toBe(0o600);
    expect(await readJsonFile(file)).toEqual({ a: [1, 'b'] });
  });

  it('readJsonFile ignores a BOM and tolerates JSONC on request', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'settings.json');
    await write(file, '﻿{\n  // "hooks": {},\n  "url": "https://a//b", /* c */\n  "x": [1,],\n}\n');
    await expect(readJsonFile(file)).rejects.toThrow(`invalid JSON in ${file}`);
    expect(await readJsonFile(file, { tolerant: true })).toEqual({ url: 'https://a//b', x: [1] });
  });

  it('readJsonFile propagates fs errors unchanged', async () => {
    const dir = await tmpDir();
    await expect(readJsonFile(join(dir, 'missing.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('readJsonIfExists: undefined for missing or blank files', async () => {
    const dir = await tmpDir();
    expect(await readJsonIfExists(join(dir, 'missing.json'))).toBeUndefined();
    await write(join(dir, 'blank.json'), ' \n');
    expect(await readJsonIfExists(join(dir, 'blank.json'))).toBeUndefined();
    await write(join(dir, 'ok.json'), '{"a":1}');
    expect(await readJsonIfExists(join(dir, 'ok.json'))).toEqual({ a: 1 });
    await write(join(dir, 'bad.json'), '{');
    await expect(readJsonIfExists(join(dir, 'bad.json'))).rejects.toThrow('invalid JSON');
  });
});

describe('removeEmptyTree', () => {
  it('removes a directory holding only empty directories, keeps one with a file or a link', async () => {
    const root = await tmpDir();
    await mkdir(join(root, 'a/b/c'), { recursive: true });
    await mkdir(join(root, 'a/d'), { recursive: true });
    expect(await removeEmptyTree(join(root, 'a'))).toBe(true);
    expect(await exists(join(root, 'a'))).toBe(false);
    await write(join(root, 'k/x/file.txt'), 'x');
    await mkdir(join(root, 'k/empty'), { recursive: true });
    expect(await removeEmptyTree(join(root, 'k'))).toBe(false);
    expect(await exists(join(root, 'k/x/file.txt'))).toBe(true);
    expect(await exists(join(root, 'k/empty'))).toBe(false); // empty branches still go
    await mkdir(join(root, 'l'));
    await symlink(join(root, 'nowhere'), join(root, 'l/link'));
    expect(await removeEmptyTree(join(root, 'l'))).toBe(false);
    expect(await removeEmptyTree(join(root, 'missing'))).toBe(false);
  });
});

describe('removeEmptyParents', () => {
  it('removes empty parents up to, but not including, stopAt', async () => {
    const dir = await tmpDir();
    const stop = join(dir, 'skills');
    await mkdir(join(stop, 'a', 'b', 'c'), { recursive: true });
    const removed = await removeEmptyParents(join(stop, 'a', 'b', 'c', 'SKILL.md'), stop);
    expect(removed).toEqual([join(stop, 'a', 'b', 'c'), join(stop, 'a', 'b'), join(stop, 'a')]);
    expect(await exists(stop)).toBe(true);
  });

  it('skips missing directories and stops at a non-empty one', async () => {
    const dir = await tmpDir();
    await write(join(dir, 'a', 'keep.txt'), 'x');
    const removed = await removeEmptyParents(join(dir, 'a', 'gone', 'deeper', 'f'), dir);
    expect(removed).toEqual([]);
    expect(await exists(join(dir, 'a', 'keep.txt'))).toBe(true);
  });

  it('never touches anything outside stopAt', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, 'outside', 'empty'), { recursive: true });
    await mkdir(join(dir, 'stop'));
    expect(await removeEmptyParents(join(dir, 'outside', 'empty', 'f'), join(dir, 'stop'))).toEqual(
      [],
    );
    expect(await exists(join(dir, 'outside', 'empty'))).toBe(true);
  });
});
