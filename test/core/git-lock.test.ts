import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withScopeLock } from '../../src/core/context.js';
import { fetchSource, withLock } from '../../src/core/git.js';
import type { Source } from '../../src/core/types.js';
import { ScopePaths } from '../../src/domain/scope-paths.js';
import { SourceRef } from '../../src/domain/source.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { makeRemote } from './gitrepo.js';

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

describe('withLock', () => {
  it('creates the lock exclusively, runs the function and removes the lock', async () => {
    const file = join(sb.root, 'slot', 'repo.lock');
    const seen = await withLock(file, async () => JSON.parse(await readFile(file, 'utf8')));
    expect(seen).toMatchObject({ pid: process.pid, host: hostname() });
    expect(existsSync(file)).toBe(false);
    await expect(
      withLock(file, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(file)).toBe(false);
  });

  it('waits for a live holder, then fails with E_IO and a hint', async () => {
    const file = join(sb.root, 'repo.lock');
    await writeLock(file, lockInfo(process.pid));
    const started = Date.now();
    const err = await withLock(file, async () => 'ran', { timeoutMs: 300 }).catch(
      (e: unknown) => e,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(err).toMatchObject({
      code: 'E_IO',
      message: expect.stringContaining(
        `waiting for the lock ${file} (held by pid ${process.pid} on ${hostname()})`,
      ),
      hint: expect.stringContaining(`delete ${file}`),
    });
    expect(existsSync(file)).toBe(true); // someone else's lock is left alone
  });

  it('a lock being written (no content yet) with a fresh mtime also blocks', async () => {
    const file = join(sb.root, 'repo.lock');
    await writeLock(file, '');
    await expect(withLock(file, async () => 'ran', { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'E_IO',
      message: expect.not.stringContaining('held by'),
    });
  });

  it('takes over a stale lock (mtime older than staleMs) and a dead process’s lock', async () => {
    const file = join(sb.root, 'repo.lock');
    await writeLock(file, lockInfo(process.pid), 11 * 60_000);
    expect(await withLock(file, async () => 'ran', { timeoutMs: 100 })).toBe('ran');
    await writeLock(file, 'garbage', 5_000);
    expect(await withLock(file, async () => 'ran', { staleMs: 1_000 })).toBe('ran');
    await writeLock(file, lockInfo(await deadPid()));
    expect(await withLock(file, async () => 'ran', { timeoutMs: 100 })).toBe('ran');
    // a dead pid on another host proves nothing
    await writeLock(file, lockInfo(await deadPid(), 'some-other-host'));
    await expect(withLock(file, async () => 'ran', { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'E_IO',
    });
  });

  it('proceeds as soon as the holder releases', async () => {
    const file = join(sb.root, 'repo.lock');
    const order: string[] = [];
    const first = withLock(file, async () => {
      order.push('first:start');
      await new Promise((r) => setTimeout(r, 150));
      order.push('first:end');
    });
    await new Promise((r) => setTimeout(r, 20));
    const second = withLock(file, async () => void order.push('second'));
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('does not remove a lock another process took over, and refreshes its mtime while held', async () => {
    const file = join(sb.root, 'repo.lock');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await withLock(file, async () => {
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

describe('withScopeLock', () => {
  it("serialises two runs on one scope through .palm/local/lock (E3')", async () => {
    const paths = new ScopePaths('project', sb.project, sb.palmHome, sb.env);
    const order: string[] = [];
    const first = withScopeLock(paths, async () => {
      expect(existsSync(join(sb.project, '.palm', 'local', 'lock'))).toBe(true);
      order.push('first:start');
      await new Promise((r) => setTimeout(r, 100));
      order.push('first:end');
    });
    await new Promise((r) => setTimeout(r, 10));
    await Promise.all([first, withScopeLock(paths, async () => void order.push('second'))]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(existsSync(paths.processLock)).toBe(false);
  });

  it("E3' a run leaves no empty .palm/local/ or .palm/ behind", async () => {
    const paths = new ScopePaths('project', sb.project, sb.palmHome, sb.env);
    await withScopeLock(paths, async () => undefined);
    expect(existsSync(join(sb.project, '.palm'))).toBe(false);
  });
});

describe('checkouts per commit', () => {
  const lockOf = (co: { repoDir: string }) => `${co.repoDir}.lock`;

  it('two names for one repository share one checkout; concurrent fetches clone once', async () => {
    const remote = await makeRemote(sb.root);
    const ctx = await makeContext(sb);
    const a: Source = { name: 'a', type: 'git', url: remote.bare };
    const b: Source = { name: 'b', type: 'git', url: remote.bare, layout: { skills: '*' } };
    const [ca, cb] = await Promise.all([fetchSource(ctx, a), fetchSource(ctx, b)]);
    expect(ca.repoDir).toBe(cb.repoDir);
    expect(ca.sourceId).toBe(cb.sourceId);
    const entries = await readdir(join(sb.palmHome, 'cache', ca.sourceId));
    expect(entries.sort()).toEqual([
      `sha-${remote.shas['v1.1.0']}`,
      `sha-${remote.shas['v1.1.0']}.json`,
    ]);
    expect(existsSync(lockOf(ca))).toBe(false);
  });

  it('a fresh lock blocks a fetch until it is released; a stale one is taken over', async () => {
    const remote = await makeRemote(sb.root);
    const ctx = await makeContext(sb);
    const src: Source = { name: 'r', type: 'git', url: remote.bare };
    const sha = remote.shas['v1.1.0'] as string;
    const id = new SourceRef(src).id;
    const lock = join(sb.palmHome, 'cache', id, `sha-${sha}.lock`);
    await writeLock(lock, lockInfo(process.pid));
    let done = false;
    const fetching = fetchSource(ctx, src).then((co) => {
      done = true;
      return co;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    await removeDir(lock);
    expect((await fetching).sha).toBe(sha);
    await removeDir(join(sb.palmHome, 'cache'));
    await writeLock(lock, lockInfo(process.pid), 11 * 60_000);
    expect((await fetchSource(ctx, src)).sha).toBe(sha);
    expect(existsSync(lock)).toBe(false);
  });

  it('cache hits and offline reads never take the lock', async () => {
    const remote = await makeRemote(sb.root);
    const src: Source = { name: 'r', type: 'git', url: remote.bare };
    const co = await fetchSource(await makeContext(sb), src);
    await writeLock(lockOf(co), lockInfo(process.pid));
    const offline = await makeContext(sb, { flags: { offline: true } });
    expect((await fetchSource(offline, src)).ref).toBe('v1.1.0');
    expect((await fetchSource(await makeContext(sb), src)).ref).toBe('v1.1.0');
    expect((await fetchSource(await makeContext(sb), src, { sha: co.sha })).sha).toBe(co.sha);
    expect(existsSync(lockOf(co))).toBe(true);
  });

  it('a fetch that fails leaves no checkout and no lock behind', async () => {
    const remote = await makeRemote(sb.root);
    const ctx = await makeContext(sb);
    const src: Source = { name: 'r', type: 'git', url: remote.bare };
    const missing = 'f'.repeat(40);
    await expect(fetchSource(ctx, src, { sha: missing })).rejects.toMatchObject({
      code: 'E_SOURCE',
      message: `commit fffffff is gone from ${remote.bare} (history rewritten?)`,
    });
    const dir = join(sb.palmHome, 'cache', new SourceRef(src).id);
    expect(await readdir(dir)).toEqual([]);
  });
});
