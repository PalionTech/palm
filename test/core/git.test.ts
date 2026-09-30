import { existsSync } from 'node:fs';
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitDate,
  fetchSource,
  fileAtSha,
  latestSemverTag,
  listRemoteRefs,
  resolveRef,
} from '../../src/core/git.js';
import type { Source } from '../../src/core/types.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox, write } from '../support/sandbox.js';
import { commitFile, git, makeRemote } from './gitrepo.js';

describe('latestSemverTag', () => {
  it.each<[string[], string | undefined]>([
    [['v1.0.0', 'v1.1.0', 'v2.0.0-beta.1'], 'v1.1.0'],
    [['1.2.3', 'v1.10.0', 'v1.9.9'], 'v1.10.0'],
    [['v2.0.0-beta.1', 'v2.0.0-beta.2', 'v2.0.0-alpha'], 'v2.0.0-beta.2'],
    [['1.0.0-rc.1', '1.0.0-beta.9'], '1.0.0-rc.1'],
    [['v1.0.0-rc.1', 'v1.0.0-rc.1+build'], 'v1.0.0-rc.1'],
    [['latest', 'release-1', 'v1'], undefined],
    [[], undefined],
  ])('%j → %s', (tags, expected) => {
    expect(latestSemverTag(tags)).toBe(expected);
  });
});

describe('fetchSource and resolveRef (local bare remote)', () => {
  let sb: Sandbox;
  let remote: Awaited<ReturnType<typeof makeRemote>>;
  beforeEach(async () => {
    sb = await sandbox();
    remote = await makeRemote(sb.root);
  });
  afterEach(async () => removeDir(sb.root));

  const source = (extra: Partial<Source> = {}): Source => ({
    name: 'r',
    type: 'git',
    url: remote.bare,
    ...extra,
  });

  it('lists branches and tags with their commits', async () => {
    const refs = await listRemoteRefs(remote.bare);
    expect(refs.tags.sort()).toEqual(['v1.0.0', 'v1.1.0', 'v2.0.0-beta.1']);
    expect(refs.heads).toEqual(['main']);
    expect(refs.tagShas['v1.1.0']).toBe(remote.shas['v1.1.0']);
    expect(refs.headShas.main).toBe(remote.shas.main);
  });

  it('resolveRef: no ref gives ^major.minor of the latest release, a tag or branch its commit', async () => {
    expect(await resolveRef(remote.bare, undefined)).toEqual({
      ref: '^1.1',
      resolved: 'v1.1.0',
      sha: remote.shas['v1.1.0'],
    });
    expect(await resolveRef(remote.bare, 'main')).toEqual({
      ref: 'main',
      resolved: 'main',
      sha: remote.shas.main,
    });
    expect(await resolveRef(remote.bare, '^1.0')).toEqual({
      ref: '^1.0',
      resolved: 'v1.1.0',
      sha: remote.shas['v1.1.0'],
    });
    const full = remote.shas['v1.0.0'] as string;
    expect(await resolveRef(join(sb.root, 'gone.git'), full)).toEqual({
      ref: full,
      resolved: full,
      sha: full,
    });
    expect(await resolveRef(remote.bare, full.slice(0, 9))).toMatchObject({ sha: full });
    await expect(resolveRef(remote.bare, 'nope')).rejects.toMatchObject({
      code: 'E_SOURCE',
      hint: `git ls-remote --tags --heads ${remote.bare}`,
    });
    await expect(resolveRef(remote.bare, '^3')).rejects.toMatchObject({
      code: 'E_SOURCE',
      message: expect.stringContaining('nearest'),
    });
  });

  it('checks out one directory per commit with a record beside it, mode 0700 cache', async () => {
    const ctx = await makeContext(sb);
    const co = await fetchSource(ctx, source());
    expect(co).toMatchObject({ ref: 'v1.1.0', sha: remote.shas['v1.1.0'] });
    expect(co.repoDir).toBe(
      join(sb.palmHome, 'cache', co.sourceId, `sha-${remote.shas['v1.1.0']}`),
    );
    expect(await readFile(join(co.root, 'a.txt'), 'utf8')).toBe('v1.1.0');
    const record = JSON.parse(await readFile(`${co.repoDir}.json`, 'utf8'));
    expect(record).toMatchObject({
      url: remote.bare,
      sha: remote.shas['v1.1.0'],
      refs: { '': { resolved: 'v1.1.0' } },
    });
    expect((await stat(join(sb.palmHome, 'cache'))).mode & 0o777).toBe(0o700);
    const main = await fetchSource(ctx, source({ ref: 'main' }));
    expect(main.repoDir).not.toBe(co.repoDir);
    expect(await readFile(join(co.root, 'a.txt'), 'utf8')).toBe('v1.1.0');
    const dirs = (await readdir(join(sb.palmHome, 'cache', co.sourceId))).filter(
      (n) => !n.endsWith('.json'),
    );
    expect(dirs.sort()).toEqual([`sha-${remote.shas['v1.1.0']}`, `sha-${remote.shas.main}`].sort());
  });

  it('a later fetch of the same intent is a cache hit until refresh re-resolves it', async () => {
    const ctx = await makeContext(sb);
    const first = await fetchSource(ctx, source({ ref: '^1' }));
    await rename(remote.bare, `${remote.bare}.hidden`);
    expect((await fetchSource(ctx, source({ ref: '^1' }))).sha).toBe(first.sha);
    await rename(`${remote.bare}.hidden`, remote.bare);
    const sha = await commitFile(remote.work, 'a.txt', 'v1.2.0', 'five');
    await git(remote.work, 'tag', 'v1.2.0');
    await git(remote.work, 'push', '-q', remote.bare, 'main', 'v1.2.0');
    expect((await fetchSource(ctx, source({ ref: '^1' }))).sha).toBe(first.sha);
    const fresh = await fetchSource(ctx, source({ ref: '^1' }), { refresh: true });
    expect(fresh).toMatchObject({ ref: 'v1.2.0', sha });
    expect((await fetchSource(ctx, source({ ref: '^1' }))).sha).toBe(sha);
  });

  it('takes a locked sha as is, from the cache when it holds it (file:// transport)', async () => {
    const ctx = await makeContext(sb);
    const url = pathToFileURL(remote.bare).href;
    const sha = remote.shas['v1.0.0'] as string;
    const co = await fetchSource(ctx, source({ url, ref: '^1' }), { sha });
    expect(co.sha).toBe(sha);
    expect(await readFile(join(co.root, 'a.txt'), 'utf8')).toBe('v1.0.0');
    await rename(remote.bare, `${remote.bare}.hidden`);
    const offline = await makeContext(sb, { flags: { offline: true } });
    expect((await fetchSource(offline, source({ url, ref: '^1' }), { sha })).sha).toBe(sha);
  });

  it('offline: the cache or E_NETWORK, never the network', async () => {
    const offline = await makeContext(sb, { flags: { offline: true } });
    await expect(fetchSource(offline, source())).rejects.toMatchObject({ code: 'E_NETWORK' });
    await expect(fetchSource(offline, source(), { sha: remote.shas.main })).rejects.toMatchObject({
      code: 'E_NETWORK',
    });
    await fetchSource(await makeContext(sb), source());
    expect((await fetchSource(offline, source(), { refresh: true })).ref).toBe('v1.1.0');
  });

  it('falls back to the default branch when there are no tags', async () => {
    for (const t of ['v1.0.0', 'v1.1.0', 'v2.0.0-beta.1']) await git(remote.bare, 'tag', '-d', t);
    const co = await fetchSource(await makeContext(sb), source());
    expect(co).toMatchObject({ ref: 'main', sha: remote.shas.main });
  });

  it('checks a root and refuses unsafe values before git sees them', async () => {
    const ctx = await makeContext(sb);
    await expect(fetchSource(ctx, source({ root: 'missing' }))).rejects.toMatchObject({
      code: 'E_SOURCE',
    });
    for (const bad of [
      { ref: '--upload-pack=touch x' },
      { url: '--upload-pack=x' },
      { root: '../outside' },
    ])
      await expect(fetchSource(ctx, source(bad)), JSON.stringify(bad)).rejects.toMatchObject({
        code: 'E_SOURCE',
      });
    await expect(listRemoteRefs('-oops')).rejects.toMatchObject({ code: 'E_SOURCE' });
    await expect(
      fetchSource(ctx, source({ url: join(sb.root, 'no-such.git') })),
    ).rejects.toMatchObject({
      code: 'E_SOURCE',
      message: `repository not found or private: ${join(sb.root, 'no-such.git')}`,
    });
  });

  it('reads the author date and a file at a commit, trailing newline kept', async () => {
    const co = await fetchSource(await makeContext(sb), source({ ref: 'main' }));
    expect(await commitDate(co.repoDir, co.sha as string)).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await commitDate(co.repoDir, 'not-a-sha')).toBeUndefined();
    await write(join(remote.work, 'b.txt'), 'line\n');
    await git(remote.work, 'add', 'b.txt');
    await git(remote.work, 'commit', '-q', '-m', 'b');
    await git(remote.work, 'push', '-q', remote.bare, 'main');
    const b = await fetchSource(await makeContext(sb), source({ ref: 'main' }), { refresh: true });
    expect(await fileAtSha(b.repoDir, b.sha as string, 'b.txt')).toBe('line\n');
    expect(await fileAtSha(b.repoDir, b.sha as string, 'a.txt')).toBe('main');
    expect(await fileAtSha(b.repoDir, b.sha as string, 'missing.txt')).toBeUndefined();
    expect(await fileAtSha(b.repoDir, b.sha as string, '../x')).toBeUndefined();
  });

  it('uses a local source in place with its tree hash, leaving outputs and excluded paths out', async () => {
    const ctx = await makeContext(sb);
    const kit = join(sb.project, 'agent-kit');
    await write(join(kit, 'skills/review/SKILL.md'), '---\nname: review\n---\n');
    const local: Source = { name: './agent-kit', type: 'local', path: kit };
    const co = await fetchSource(ctx, local);
    expect(co).toMatchObject({
      root: kit,
      repoDir: kit,
      sourceId: expect.stringMatching(/^local__agent-kit-/),
    });
    expect(co.tree).toMatch(/^sha256:/);
    expect(co.sha).toBeUndefined();
    expect(existsSync(join(sb.palmHome, 'cache'))).toBe(false);
    await write(join(kit, '.claude/skills/x/SKILL.md'), 'output');
    await write(join(kit, 'notes.md'), 'owned by the lock');
    expect((await fetchSource(ctx, local, { exclude: new Set(['notes.md']) })).tree).toBe(co.tree);
    await writeFile(join(kit, 'skills/review/SKILL.md'), '---\nname: review\n---\nmore\n');
    expect((await fetchSource(ctx, local)).tree).not.toBe(co.tree);
    await expect(
      fetchSource(ctx, { ...local, path: join(sb.project, 'moved') }),
    ).rejects.toMatchObject({
      code: 'E_SOURCE',
    });
  });
});
