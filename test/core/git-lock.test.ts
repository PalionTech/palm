import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAllIndexes } from '../../src/core/cache.js';
import { fetchOrigin, withCheckoutLock } from '../../src/core/git.js';
import type { OriginSpec, ScanResult } from '../../src/core/types.js';
import { Origin } from '../../src/domain/origin.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { git, makeRemote } from './gitrepo.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  vi.useRealTimers();
  await removeDir(sb.root);
});

const lockInfo = (pid: number, host = hostname()): string =>
  JSON.stringify({ pid, host, createdAt: new Date().toISOString() });

async function writeLock(file: string, content: string, ageMs = 0): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
  const t = new Date(Date.now() - ageMs);
  await utimes(file, t, t);
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = execa(process.execPath, ['-e', '']);
  await child;
  return child.pid ?? 999_999;
}

describe('withCheckoutLock', () => {
  it('creates the lock exclusively, runs the function and removes the lock', async () => {
    const file = join(sb.root, 'slot', 'repo.lock');
    const seen = await withCheckoutLock(file, async () => JSON.parse(await readFile(file, 'utf8')));
    expect(seen).toMatchObject({ pid: process.pid, host: hostname() });
    expect(existsSync(file)).toBe(false);
    await expect(
      withCheckoutLock(file, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(file)).toBe(false);
  });

  it('waits for a live holder, then fails with E_IO and a hint', async () => {
    const file = join(sb.root, 'repo.lock');
    await writeLock(file, lockInfo(process.pid));
    const started = Date.now();
    const err = await withCheckoutLock(file, async () => 'ran', { timeoutMs: 300 }).catch(
      (e: unknown) => e,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(err).toMatchObject({
      code: 'E_IO',
      message: expect.stringContaining(
        `waiting for the checkout lock ${file} (held by pid ${process.pid} on ${hostname()})`,
      ),
      hint: expect.stringContaining(`delete ${file}`),
    });
    expect(existsSync(file)).toBe(true); // someone else's lock is left alone
  });

  it('a lock being written (no content yet) with a fresh mtime also blocks', async () => {
    const file = join(sb.root, 'repo.lock');
    await writeLock(file, '');
    await expect(
      withCheckoutLock(file, async () => 'ran', { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'E_IO', message: expect.not.stringContaining('held by') });
  });

  it('takes over a stale lock (mtime older than staleMs) and a dead process’s lock', async () => {
    const file = join(sb.root, 'repo.lock');
    await writeLock(file, lockInfo(process.pid), 11 * 60_000);
    expect(await withCheckoutLock(file, async () => 'ran', { timeoutMs: 100 })).toBe('ran');
    await writeLock(file, 'garbage', 5_000);
    expect(await withCheckoutLock(file, async () => 'ran', { staleMs: 1_000 })).toBe('ran');
    await writeLock(file, lockInfo(await deadPid()));
    expect(await withCheckoutLock(file, async () => 'ran', { timeoutMs: 100 })).toBe('ran');
    // a dead pid on another host proves nothing
    await writeLock(file, lockInfo(await deadPid(), 'some-other-host'));
    await expect(
      withCheckoutLock(file, async () => 'ran', { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'E_IO' });
  });

  it('proceeds as soon as the holder releases', async () => {
    const file = join(sb.root, 'repo.lock');
    const order: string[] = [];
    const first = withCheckoutLock(file, async () => {
      order.push('first:start');
      await new Promise((r) => setTimeout(r, 150));
      order.push('first:end');
    });
    await new Promise((r) => setTimeout(r, 20));
    const second = withCheckoutLock(file, async () => void order.push('second'));
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('does not remove a lock another process took over, and refreshes its mtime while held', async () => {
    const file = join(sb.root, 'repo.lock');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await withCheckoutLock(file, async () => {
      const old = new Date(Date.now() - 5 * 60_000);
      await utimes(file, old, old);
      vi.advanceTimersByTime(60_000); // heartbeat
      const age = async (): Promise<number> => Date.now() - (await stat(file)).mtimeMs;
      for (let i = 0; i < 100 && (await age()) > 60_000; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(await age()).toBeLessThan(60_000);
      await writeFile(file, lockInfo(process.pid + 1)); // "taken over as stale"
    });
    expect(existsSync(file)).toBe(true);
  });
});

describe('checkout slots', () => {
  const scanOnce = async (_root: string, spec: OriginSpec): Promise<ScanResult> => ({
    entities: [
      {
        kind: 'skill',
        name: 'a',
        path: 'a.txt',
        origin: spec.alias,
        def: { kind: 'skill', skill: { name: 'a', description: 'A' } },
      },
    ],
    warnings: [],
    detected: 'convention',
  });

  it('two aliases of one repo + ref share one checkout, fetched once', async () => {
    const remote = await makeRemote(sb.root);
    const ctx = await makeContext(sb);
    const a: OriginSpec = { alias: 'a', type: 'git', url: remote.bare };
    const b: OriginSpec = { alias: 'b', type: 'git', url: remote.bare, layout: { skills: '*' } };
    ctx.config.origins.push(a, b);
    const indexes = await getAllIndexes(ctx, { scan: scanOnce });
    expect(indexes.map((i) => [i.origin, i.sha])).toEqual([
      ['a', remote.shas['v1.1.0']],
      ['b', remote.shas['v1.1.0']],
    ]);
    const slot = new Origin(a).checkoutSlot(join(sb.palmHome, 'cache'));
    expect(new Origin(b).checkoutSlot(join(sb.palmHome, 'cache'))).toEqual(slot);
    expect((await readdir(slot.dir)).sort()).toEqual(['checkout.json', 'repo']);

    // concurrent fetches of both aliases: one clone, the other reuses it (same fetchedAt)
    const [ca, cb] = await Promise.all([
      fetchOrigin(ctx, a, { refresh: true }),
      fetchOrigin(ctx, b, { refresh: true }),
    ]);
    expect(ca.repoDir).toBe(cb.repoDir);
    expect(ca.fetchedAt).toBe(cb.fetchedAt);
    expect(existsSync(slot.lockFile)).toBe(false);
  });

  it('a fresh lock file blocks a fetch until it is released; a stale one is taken over', async () => {
    const remote = await makeRemote(sb.root);
    const ctx = await makeContext(sb);
    const spec: OriginSpec = { alias: 'r', type: 'git', url: remote.bare };
    const slot = new Origin(spec).checkoutSlot(join(sb.palmHome, 'cache'));
    await writeLock(slot.lockFile, lockInfo(process.pid));
    let done = false;
    const fetching = fetchOrigin(ctx, spec).then((co) => {
      done = true;
      return co;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    expect(existsSync(slot.repoDir)).toBe(false);
    await removeDir(slot.lockFile);
    expect((await fetching).sha).toBe(remote.shas['v1.1.0']);

    await writeLock(slot.lockFile, lockInfo(process.pid), 11 * 60_000);
    expect((await fetchOrigin(ctx, spec, { refresh: true })).sha).toBe(remote.shas['v1.1.0']);
    expect(existsSync(slot.lockFile)).toBe(false);
  });

  it('cache hits and offline reads never take the lock', async () => {
    const remote = await makeRemote(sb.root);
    const spec: OriginSpec = { alias: 'r', type: 'git', url: remote.bare };
    await fetchOrigin(await makeContext(sb), spec);
    const slot = new Origin(spec).checkoutSlot(join(sb.palmHome, 'cache'));
    await writeLock(slot.lockFile, lockInfo(process.pid));
    const offline = await makeContext(sb, { flags: { offline: true } });
    expect((await fetchOrigin(offline, spec)).ref).toBe('v1.1.0');
    expect((await fetchOrigin(await makeContext(sb), spec)).ref).toBe('v1.1.0');
    expect(existsSync(slot.lockFile)).toBe(true);
  });

  it('a fetch that fails after touching the checkout leaves no metadata (the next run re-clones)', async () => {
    const remote = await makeRemote(sb.root);
    const ctx = await makeContext(sb);
    const spec: OriginSpec = { alias: 'r', type: 'git', url: remote.bare, ref: 'v1.0.0' };
    await fetchOrigin(ctx, spec);
    const slot = new Origin(spec).checkoutSlot(join(sb.palmHome, 'cache'));
    expect(existsSync(slot.metaFile)).toBe(true);
    await git(remote.bare, 'tag', '-d', 'v1.0.0');
    await expect(fetchOrigin(ctx, spec, { refresh: true })).rejects.toMatchObject({
      code: 'E_GIT',
    });
    expect(existsSync(slot.metaFile)).toBe(false);
    expect(existsSync(slot.lockFile)).toBe(false);
  });
});
