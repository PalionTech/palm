/**
 * B1: the lock's directory removed by another process between palm's `mkdir` and its O_EXCL
 * create (or during the `mkdir` itself, which then fails with ENOENT) is made again and the
 * create tried once more. The removal is injected, since the real one is a narrow race.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withLock } from '../../src/core/lock-file.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';

/** How many of the next calls fail with ENOENT, as if the directory had just gone. */
const gone = vi.hoisted(() => ({ mkdir: 0, create: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  /** Throws ENOENT for `call` while `gone[key]` lasts, counting it down. */
  const failNext = (key: keyof typeof gone, call: string, p: unknown): void => {
    if (gone[key] === 0) return;
    gone[key]--;
    const err = new Error(`ENOENT: no such file or directory, ${call} '${String(p)}'`);
    throw Object.assign(err, { code: 'ENOENT' });
  };
  const mkdir = async (...args: Parameters<typeof fs.mkdir>) => {
    failNext('mkdir', 'mkdir', args[0]);
    return fs.mkdir(...args);
  };
  const writeFile = async (...args: Parameters<typeof fs.writeFile>) => {
    const opts = args[2];
    if (typeof opts === 'object' && opts?.flag === 'wx') failNext('create', 'open', args[0]);
    return fs.writeFile(...args);
  };
  return { ...fs, mkdir, writeFile };
});

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  gone.mkdir = 0;
  gone.create = 0;
  await removeDir(sb.root);
});

describe('B1 the lock directory removed under a waiting run', () => {
  it('B1 a directory gone before the exclusive create is made again', async () => {
    const file = join(sb.project, '.palm', 'local', 'lock');
    gone.create = 1;
    expect(await withLock(file, async () => existsSync(file))).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('B1 a directory gone while mkdir checked it is made again', async () => {
    const file = join(sb.project, '.palm', 'local', 'lock');
    gone.mkdir = 1;
    expect(await withLock(file, async () => existsSync(file))).toBe(true);
  });

  it('B1 a directory that keeps going is reported, not waited on forever', async () => {
    const file = join(sb.project, '.palm', 'local', 'lock');
    gone.create = 2;
    await expect(withLock(file, async () => 'ran')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
