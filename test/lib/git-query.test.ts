import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit } from '../../src/core/git-exec.js';
import { gitToplevel, isGitIgnored, isGitTracked } from '../../src/lib/fs.js';
import { setGitRunner } from '../../src/lib/git-query.js';
import { cleanupTmp, tmpDir } from '../support/sandbox.js';

afterEach(async () => {
  setGitRunner(undefined);
  await cleanupTmp();
});

describe('git queries', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await tmpDir();
    await execa('git', ['init', '-q', repo]);
    await writeFile(join(repo, '.gitignore'), 'ignored/\n');
    await mkdir(join(repo, 'ignored'));
    await writeFile(join(repo, 'tracked.md'), 't');
    await writeFile(join(repo, 'loose.md'), 'l');
    await execa('git', ['add', 'tracked.md', '.gitignore'], { cwd: repo });
  });

  it('answer undefined without a runner', async () => {
    expect(await gitToplevel(repo)).toBeUndefined();
    expect(await isGitIgnored(join(repo, 'ignored/x'), repo)).toBeUndefined();
    expect(await isGitTracked(join(repo, 'tracked.md'), repo)).toBeUndefined();
  });

  it('go through the injected runner', async () => {
    setGitRunner((args, cwd) => runGit(args, { cwd }));
    expect(await gitToplevel(join(repo, 'ignored/missing/deeper'))).toBe(repo);
    expect(await isGitIgnored(join(repo, 'ignored/x.md'), repo)).toBe(true);
    expect(await isGitIgnored(join(repo, 'loose.md'), repo)).toBe(false);
    expect(await isGitTracked(join(repo, 'tracked.md'), repo)).toBe(true);
    expect(await isGitTracked(join(repo, 'loose.md'), repo)).toBe(false);
  });

  it('answer undefined outside a repository', async () => {
    setGitRunner((args, cwd) => runGit(args, { cwd }));
    const plain = await tmpDir();
    expect(await gitToplevel(plain)).toBeUndefined();
    expect(await isGitIgnored(join(plain, 'x'), plain)).toBeUndefined();
    expect(await isGitTracked(join(plain, 'x'), plain)).toBeUndefined();
  });
});
