import { existsSync } from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchOrigin, latestSemverTag, listRemoteTags } from '../../src/core/git.js';
import type { OriginSpec } from '../../src/core/types.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { commitFile, git, makeRemote } from './gitrepo.js';

describe('latestSemverTag', () => {
  it.each<[string[], string | undefined]>([
    [['v1.0.0', 'v1.1.0', 'v2.0.0-beta.1'], 'v1.1.0'],
    [['1.2.3', 'v1.10.0', 'v1.9.9'], 'v1.10.0'],
    [['v2.0.0-beta.1', 'v2.0.0-beta.2', 'v2.0.0-alpha'], 'v2.0.0-beta.2'],
    [['1.0.0-alpha', '1.0.0-alpha.1'], '1.0.0-alpha.1'],
    [['1.0.0-alpha.1', '1.0.0-alpha'], '1.0.0-alpha.1'],
    [['1.0.0-alpha', '1.0.0-1'], '1.0.0-alpha'],
    [['1.0.0-1', '1.0.0-alpha'], '1.0.0-alpha'],
    [['1.0.0-2', '1.0.0-10'], '1.0.0-10'],
    [['1.0.0-rc.1', '1.0.0-beta.9'], '1.0.0-rc.1'],
    [['v1.0.0-rc.1', 'v1.0.0-rc.1+build'], 'v1.0.0-rc.1'],
    [['latest', 'release-1', 'v1'], undefined],
    [[], undefined],
  ])('%j → %s', (tags, expected) => {
    expect(latestSemverTag(tags)).toBe(expected);
  });
});

describe('fetchOrigin (local bare remote)', () => {
  let sb: Sandbox;
  let remote: Awaited<ReturnType<typeof makeRemote>>;
  beforeEach(async () => {
    sb = await sandbox();
    remote = await makeRemote(sb.root);
  });
  afterEach(async () => removeDir(sb.root));

  const spec = (extra: Partial<OriginSpec> = {}): OriginSpec => ({
    alias: 'r',
    type: 'git',
    url: remote.bare,
    ...extra,
  });

  it('lists remote tags', async () => {
    expect((await listRemoteTags(remote.bare)).sort()).toEqual([
      'v1.0.0',
      'v1.1.0',
      'v2.0.0-beta.1',
    ]);
  });

  it('checks out the latest release tag, caches it, and refetches on refresh', async () => {
    const ctx = await makeContext(sb);
    const co = await fetchOrigin(ctx, spec());
    expect(co.ref).toBe('v1.1.0');
    expect(co.sha).toBe(remote.shas['v1.1.0']);
    expect(await readFile(join(co.root, 'a.txt'), 'utf8')).toBe('v1.1.0');
    expect(co.repoDir.startsWith(join(sb.palmHome, 'cache'))).toBe(true);
    const meta = JSON.parse(
      await readFile(join(sb.palmHome, 'cache', co.originId, 'checkout.json'), 'utf8'),
    );
    expect(meta).toMatchObject({ url: remote.bare, ref: 'v1.1.0', sha: remote.shas['v1.1.0'] });

    // Second call must not touch the network: hide the remote.
    await rename(remote.bare, `${remote.bare}.hidden`);
    const again = await fetchOrigin(ctx, spec());
    expect(again.sha).toBe(co.sha);
    await rename(`${remote.bare}.hidden`, remote.bare);

    // New release upstream; refresh picks it up.
    const sha = await commitFile(remote.work, 'a.txt', 'v1.2.0', 'five');
    await git(remote.work, 'tag', 'v1.2.0');
    await git(remote.work, 'push', '-q', remote.bare, 'main', 'v1.2.0');
    expect((await fetchOrigin(ctx, spec())).ref).toBe('v1.1.0');
    const fresh = await fetchOrigin(ctx, spec(), { refresh: true });
    expect(fresh.ref).toBe('v1.2.0');
    expect(fresh.sha).toBe(sha);
    expect(await readFile(join(fresh.root, 'a.txt'), 'utf8')).toBe('v1.2.0');
  });

  it('honours an explicit branch ref in its own slot', async () => {
    const ctx = await makeContext(sb);
    const latest = await fetchOrigin(ctx, spec());
    const main = await fetchOrigin(ctx, spec({ ref: 'main' }));
    expect(main.ref).toBe('main');
    expect(main.sha).toBe(remote.shas.main);
    expect(await readFile(join(main.root, 'a.txt'), 'utf8')).toBe('main');
    // the default checkout is untouched
    expect(await readFile(join(latest.root, 'a.txt'), 'utf8')).toBe('v1.1.0');
  });

  it('checks out a full sha (file:// transport, shallow)', async () => {
    const ctx = await makeContext(sb);
    const url = pathToFileURL(remote.bare).href;
    const co = await fetchOrigin(ctx, {
      alias: 'r',
      type: 'git',
      url,
      ref: remote.shas['v1.0.0']!,
    });
    expect(co.sha).toBe(remote.shas['v1.0.0']);
    expect(await readFile(join(co.root, 'a.txt'), 'utf8')).toBe('v1.0.0');
  });

  it('falls back to the default branch when there are no tags', async () => {
    const ctx = await makeContext(sb);
    for (const t of ['v1.0.0', 'v1.1.0', 'v2.0.0-beta.1']) await git(remote.bare, 'tag', '-d', t);
    const co = await fetchOrigin(ctx, spec());
    expect(co.ref).toBe('main');
    expect(co.sha).toBe(remote.shas.main);
  });

  it('supports a root subdirectory', async () => {
    const ctx = await makeContext(sb);
    await expect(fetchOrigin(ctx, spec({ root: 'missing' }))).rejects.toMatchObject({
      code: 'E_ORIGIN',
    });
  });

  it('offline: uses the cache or fails with E_NETWORK', async () => {
    const offline = await makeContext(sb, { flags: { offline: true } });
    await expect(fetchOrigin(offline, spec())).rejects.toMatchObject({ code: 'E_NETWORK' });
    const online = await makeContext(sb);
    await fetchOrigin(online, spec());
    const co = await fetchOrigin(offline, spec(), { refresh: true });
    expect(co.ref).toBe('v1.1.0');
  });

  it('wraps git failures in E_GIT', async () => {
    const ctx = await makeContext(sb);
    await expect(
      fetchOrigin(ctx, spec({ url: join(sb.root, 'no-such-repo.git') })),
    ).rejects.toMatchObject({ code: 'E_GIT' });
    await expect(fetchOrigin(ctx, spec({ ref: 'no-such-branch' }))).rejects.toMatchObject({
      code: 'E_GIT',
    });
  });

  it('rejects option-like refs/urls and escaping roots', async () => {
    const ctx = await makeContext(sb);
    await expect(fetchOrigin(ctx, spec({ ref: '--upload-pack=touch x' }))).rejects.toMatchObject({
      code: 'E_ORIGIN',
    });
    await expect(fetchOrigin(ctx, spec({ url: '--upload-pack=x' }))).rejects.toMatchObject({
      code: 'E_ORIGIN',
    });
    await expect(fetchOrigin(ctx, spec({ root: '../outside' }))).rejects.toMatchObject({
      code: 'E_ORIGIN',
    });
    await expect(listRemoteTags('-oops')).rejects.toMatchObject({ code: 'E_ORIGIN' });
  });

  it('uses local origins in place', async () => {
    const ctx = await makeContext(sb);
    const co = await fetchOrigin(ctx, { alias: 'w', type: 'local', path: remote.work });
    expect(co.root).toBe(remote.work);
    expect(co.sha).toBeUndefined();
    expect(existsSync(join(sb.palmHome, 'cache'))).toBe(false);
  });
});
