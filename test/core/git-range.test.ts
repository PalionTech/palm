import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fetchSource,
  isSemverRange,
  listRemoteRefs,
  maxSatisfyingTag,
  resolveRef,
} from '../../src/core/git.js';
import type { Source } from '../../src/core/types.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { commitFile, git } from './gitrepo.js';

describe('isSemverRange', () => {
  it.each<[string, boolean]>([
    ['^1.2', true],
    ['~1.2', true],
    ['>=1.2 <2', true],
    ['1.x', true],
    ['1', true],
    ['v1', true],
    ['*', true],
    ['1.2.3', false],
    ['v1.2.3', false],
    ['main', false],
    ['release/1.x-hotfix', false],
    ['abc1234', false],
    ['1234567', false],
    ['0123456789abcdef0123456789abcdef01234567', false],
  ])('%s → %s', (ref, expected) => {
    expect(isSemverRange(ref)).toBe(expected);
  });
});

describe('maxSatisfyingTag', () => {
  const tags = ['v1.0.0', 'v1.2.0', 'v1.3.0', 'v2.0.0', '2.1.0-beta.1', 'latest', 'v1.2.5'];
  it.each<[string, string | undefined]>([
    ['^1.2', 'v1.3.0'],
    ['~1.2', 'v1.2.5'],
    ['>=1.2 <2', 'v1.3.0'],
    ['1.x', 'v1.3.0'],
    ['*', 'v2.0.0'],
    ['^2.1.0-beta', '2.1.0-beta.1'],
    ['^3', undefined],
  ])('%s → %s', (range, expected) => {
    expect(maxSatisfyingTag(tags, range)).toBe(expected);
  });
});

describe('resolveRef and fetchSource with ranges (local bare remote)', () => {
  let sb: Sandbox;
  let bare: string;
  const shas: Record<string, string> = {};
  beforeEach(async () => {
    sb = await sandbox();
    const work = join(sb.root, 'work');
    bare = join(sb.root, 'remote.git');
    await execa('git', ['init', '-q', '-b', 'main', work]);
    for (const tag of ['v1.0.0', 'v1.2.0', 'v1.3.0', 'v2.0.0']) {
      shas[tag] = await commitFile(work, 'a.txt', tag, tag);
      await git(work, 'tag', tag);
    }
    await git(work, 'branch', '3.x');
    shas.main = await commitFile(work, 'a.txt', 'main', 'head');
    await execa('git', ['clone', '-q', '--bare', work, bare]);
  });
  afterEach(async () => removeDir(sb.root));

  const spec = (ref?: string): Source => ({ name: 'r', type: 'git', url: bare, ref });
  const resolved = async (ref?: string) => (await resolveRef(bare, ref)).resolved;

  it('resolves ranges to the highest satisfying tag, exact refs as given', async () => {
    expect(await resolved('^1.2')).toBe('v1.3.0');
    expect(await resolved('~1.2')).toBe('v1.2.0');
    expect(await resolved('>=1.2 <2')).toBe('v1.3.0');
    expect(await resolved('1.x')).toBe('v1.3.0');
    expect(await resolved('v1.0.0')).toBe('v1.0.0');
    expect(await resolved('main')).toBe('main');
    expect(await resolved(undefined)).toBe('v2.0.0');
    expect(await resolveRef(bare, undefined)).toEqual({
      ref: '^2.0',
      resolved: 'v2.0.0',
      sha: shas['v2.0.0'],
    });
    expect((await resolveRef(bare, '^1.2')).sha).toBe(shas['v1.3.0']);
  });

  it('listRemoteRefs reports each branch and tag with its commit (annotated tags peeled)', async () => {
    const work = join(sb.root, 'work');
    await git(work, 'tag', '-a', 'v3.0.0', '-m', 'release');
    await git(work, 'push', '-q', bare, 'v3.0.0');
    const refs = await listRemoteRefs(bare);
    expect(refs.tags.sort()).toEqual(['v1.0.0', 'v1.2.0', 'v1.3.0', 'v2.0.0', 'v3.0.0']);
    expect(refs.headShas).toEqual({ '3.x': shas['v2.0.0'], main: shas.main });
    expect(refs.tagShas).toEqual({
      'v1.0.0': shas['v1.0.0'],
      'v1.2.0': shas['v1.2.0'],
      'v1.3.0': shas['v1.3.0'],
      'v2.0.0': shas['v2.0.0'],
      'v3.0.0': shas.main, // the commit, not the tag object
    });
  });

  it('prefers a branch or tag named exactly like the range', async () => {
    expect(await resolved('3.x')).toBe('3.x');
  });

  it('fails with E_SOURCE naming the nearest tags when nothing satisfies the range', async () => {
    const err = await resolveRef(bare, '^4').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'E_SOURCE' });
    expect((err as Error).message).toBe(
      `no tag of ${bare} satisfies "^4" (nearest: v2.0.0, v1.3.0, v1.2.0)`,
    );
    expect((err as { hint?: string }).hint).toBe(`git ls-remote --tags ${bare}`);
    await expect(resolveRef(bare, '^0.1')).rejects.toThrow(
      '(nearest: v2.0.0, v1.3.0, v1.2.0, v1.0.0)',
    );
  });

  it('fetchSource checks out the resolved tag and records the intent beside it', async () => {
    const ctx = await makeContext(sb);
    const co = await fetchSource(ctx, spec('^1.2'));
    expect(co.ref).toBe('v1.3.0');
    expect(co.sha).toBe(shas['v1.3.0']);
    expect(await readFile(join(co.root, 'a.txt'), 'utf8')).toBe('v1.3.0');
    const meta = JSON.parse(await readFile(`${co.repoDir}.json`, 'utf8'));
    expect(meta).toMatchObject({ sha: shas['v1.3.0'], refs: { '^1.2': { resolved: 'v1.3.0' } } });

    // A cache hit needs no network; offline works from the cache too.
    await execa('mv', [bare, `${bare}.hidden`]);
    expect((await fetchSource(ctx, spec('^1.2'))).ref).toBe('v1.3.0');
    const offline = await makeContext(sb, { flags: { offline: true } });
    expect((await fetchSource(offline, spec('^1.2'))).sha).toBe(shas['v1.3.0']);
    await execa('mv', [`${bare}.hidden`, bare]);

    await expect(fetchSource(ctx, spec('^9'))).rejects.toMatchObject({ code: 'E_SOURCE' });
  });
});
