import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchSource } from '../../src/core/git.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { commitFile, git, makeRemote } from './gitrepo.js';

/** Every file under `dir` (relative paths, sorted): the victim's object store. */
async function listTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length))
    .sort();
}

async function snapshot(victim: string) {
  return {
    head: await readFile(join(victim, '.git', 'HEAD'), 'utf8'),
    ref: await git(victim, 'rev-parse', 'HEAD'),
    index: await readFile(join(victim, '.git', 'index')),
    objects: await listTree(join(victim, '.git', 'objects')),
    files: (await readdir(victim)).sort(),
  };
}

const REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'] as const;

describe('git runs with a clean environment (PLAN §2 item 1)', () => {
  let sb: Sandbox;
  let victim: string;
  beforeEach(async () => {
    sb = await sandbox();
    victim = join(sb.root, 'victim');
    await execa('git', ['init', '-q', '-b', 'main', victim]);
    await commitFile(victim, 'mine.txt', 'my work', 'victim commit');
  });
  afterEach(async () => {
    for (const name of REDIRECTS) delete process.env[name];
    await removeDir(sb.root);
  });

  it('GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE pointing at another repo change nothing there', async () => {
    const remote = await makeRemote(sb.root);
    const before = await snapshot(victim);
    // What a palm started from a git hook of the victim repository inherits.
    process.env.GIT_DIR = join(victim, '.git');
    process.env.GIT_WORK_TREE = victim;
    process.env.GIT_INDEX_FILE = join(victim, '.git', 'index');
    process.env.GIT_OBJECT_DIRECTORY = join(victim, '.git', 'objects');
    const ctx = await makeContext(sb);
    const co = await fetchSource(ctx, { name: 'r', type: 'git', url: remote.bare });
    const again = await fetchSource(ctx, {
      name: 'r',
      type: 'git',
      url: remote.bare,
      ref: 'main',
    });
    for (const name of REDIRECTS) delete process.env[name];

    expect(await snapshot(victim)).toEqual(before);
    expect(existsSync(join(victim, 'a.txt'))).toBe(false);
    expect(co.repoDir.startsWith(join(sb.palmHome, 'cache'))).toBe(true);
    expect(co.sha).toBe(remote.shas['v1.1.0']);
    expect(await readFile(join(co.root, 'a.txt'), 'utf8')).toBe('v1.1.0');
    expect(await git(co.repoDir, 'rev-parse', 'HEAD')).toBe(remote.shas['v1.1.0']);
    expect(again.sha).toBe(remote.shas.main);
  });
});
