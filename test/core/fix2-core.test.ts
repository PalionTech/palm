/**
 * Core rulings from the second persona rerun (FINDINGS-v3.md): no home, no guess (B4); a
 * dotfiles repository holding the global palm.yaml is no project (J7'); a pinned commit is
 * fetched alone and a timeout says how much arrived (T3); a locked commit gone from the remote
 * (V4') and a ref the source lacks (R9') in palm's words; refused writes are E_IO (B3, B6).
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CheckoutJob, fetchError } from '../../src/core/checkout.js';
import { createContext } from '../../src/core/context.js';
import { fetchSource, withLock } from '../../src/core/git.js';
import { GitFailure } from '../../src/core/git-exec.js';
import { resolvePaths } from '../../src/core/paths.js';
import type { Source } from '../../src/core/types.js';
import { SourceRef } from '../../src/domain/source.js';
import { assertScope } from '../../src/engine/scope.js';
import { palmCli } from '../support/cli.js';
import { defaultFlags, fakeLogger, fakeUI, makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { commitFile, git, makeRemote } from './gitrepo.js';

let sb: Sandbox;

beforeEach(async () => {
  sb = await sandbox();
});

afterEach(async () => {
  await chmod(sb.palmHome, 0o755).catch(() => undefined);
  await removeDir(sb.root);
});

describe('B4 neither HOME nor PALM_HOME', () => {
  it('B4 refuses with E_USAGE before any path is resolved', async () => {
    expect(() => resolvePaths(sb.project, {})).toThrow(
      expect.objectContaining({
        code: 'E_USAGE',
        message: 'HOME is not set; set HOME or PALM_HOME',
      }),
    );
    expect(() => resolvePaths(sb.project, { HOME: '' })).toThrow(/HOME is not set/);
    expect(resolvePaths(sb.project, { PALM_HOME: sb.palmHome }).palmHome).toBe(sb.palmHome);
    const init = {
      cwd: sb.project,
      env: {},
      ui: fakeUI(),
      log: fakeLogger(),
      flags: defaultFlags(),
    };
    await expect(createContext(init)).rejects.toMatchObject({ code: 'E_USAGE' });
  });

  it('B4 the CLI exits 2 and writes nothing', async () => {
    const r = await execa(process.execPath, [palmCli(), 'install', 'acme/kit', 'x'], {
      cwd: sb.project,
      env: { PATH: process.env.PATH ?? '' },
      extendEnv: false,
      reject: false,
    });
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(2);
    expect(`${r.stdout}\n${r.stderr}`).toContain('HOME is not set; set HOME or PALM_HOME');
    expect(await readdir(sb.project)).toEqual(['.git']);
  });
});

describe("J7' a directory holding the global palm.yaml", () => {
  async function dotfiles(): Promise<string> {
    const repo = join(sb.home, 'dotfiles');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'palm'), { recursive: true });
    await writeFile(join(repo, 'palm', 'palm.yaml'), 'targets: [claude]\n');
    return repo;
  }

  it("J7' a dotfiles repository whose palm/palm.yaml is linked from palm home is no project", async () => {
    const repo = await dotfiles();
    await mkdir(sb.palmHome, { recursive: true });
    await symlink(join(repo, 'palm', 'palm.yaml'), join(sb.palmHome, 'palm.yaml'));
    const ctx = { ...(await makeContext(sb, { cwd: repo })), argv: ['install', 'acme/kit', 'x'] };
    expect(() => assertScope(ctx, 'project')).toThrow(
      expect.objectContaining({
        code: 'E_USAGE',
        message: `${repo} holds the global palm.yaml (palm/palm.yaml), not a project; your own setup takes -g`,
        hint: 'palm install acme/kit x -g',
      }),
    );
    expect(() => assertScope(ctx, 'global')).not.toThrow();
  });

  it("J7' PALM_HOME set to a subdirectory of the repository is refused the same way", async () => {
    const repo = await dotfiles();
    const env = { HOME: sb.home, PALM_HOME: join(repo, 'palm') };
    const ctx = await createContext({
      cwd: repo,
      env,
      ui: fakeUI(),
      log: fakeLogger(),
      flags: defaultFlags(),
    });
    expect(() => assertScope(ctx, 'project')).toThrow(
      /holds the global palm.yaml \(palm\/palm.yaml\)/,
    );
  });

  it("J7' a project that does not hold it is a project", async () => {
    await mkdir(sb.palmHome, { recursive: true });
    await writeFile(join(sb.palmHome, 'palm.yaml'), 'targets: [claude]\n');
    expect(() => assertScope(makeContextSync(sb.project), 'project')).not.toThrow();
  });
});

function makeContextSync(cwd: string) {
  return {
    paths: resolvePaths(cwd, sb.env),
    env: sb.env,
    ui: fakeUI(),
    log: fakeLogger(),
    flags: defaultFlags(),
  };
}

describe('T3 V4 R9 fetching commits', () => {
  const source = (url: string, extra: Partial<Source> = {}): Source => ({
    name: 'kit',
    type: 'git',
    url,
    ...extra,
  });

  it('T3 a pinned commit that no ref names is fetched alone (depth 1)', async () => {
    const remote = await makeRemote(sb.root);
    const ctx = await makeContext(sb);
    const url = pathToFileURL(remote.bare).href;
    const sha = remote.shas['v1.0.0'] as string;
    await git(remote.bare, 'tag', '-d', 'v1.0.0');
    const co = await fetchSource(ctx, source(url, { ref: sha }));
    expect(co.sha).toBe(sha);
    expect(existsSync(join(co.repoDir, '.git', 'shallow'))).toBe(true);
    expect(await git(co.repoDir, 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('T3 an abbreviated commit is expanded from a clone without file contents', async () => {
    const remote = await makeRemote(sb.root);
    await git(remote.bare, 'config', 'uploadpack.allowFilter', 'true');
    const ctx = await makeContext(sb);
    const url = pathToFileURL(remote.bare).href;
    const sha = remote.shas['v1.1.0'] as string;
    await git(remote.bare, 'tag', '-d', 'v1.1.0');
    const co = await fetchSource(ctx, source(url, { ref: sha.slice(0, 9) }));
    expect(co.sha).toBe(sha);
    expect(await git(co.repoDir, 'config', 'remote.origin.partialclonefilter')).toBe('blob:none');
  });

  it('T3 a timeout names how much arrived: a large repository', () => {
    const job: CheckoutJob = {
      ref: SourceRef.of(source('https://example.com/huge.git')),
      url: 'https://example.com/huge.git',
      cache: join(sb.palmHome, 'cache'),
    };
    const timeout = new GitFailure(
      'git clone timed out after 120 s',
      'git clone timed out after 120 s',
      {
        network: true,
        timedOutMs: 120_000,
      },
    );
    const e = fetchError(job, timeout, 412 * 1024 * 1024);
    expect(e.code).toBe('E_NETWORK');
    expect(e.message).toBe(
      'cannot fetch source "kit" from https://example.com/huge.git: git clone timed out after 120 s (412 MB received: a large repository)',
    );
    expect(e.hint).toMatch(/full 40-character commit fetches that commit alone/);
  });

  it("V4' a locked commit the remote no longer has is named as gone", async () => {
    const remote = await makeRemote(sb.root);
    const gone = await commitFile(remote.work, 'b.txt', 'soon gone', 'five');
    await git(remote.work, 'push', '-q', remote.bare, 'main');
    await git(remote.work, 'reset', '-q', '--hard', 'HEAD~1');
    await git(remote.work, 'push', '-q', '--force', remote.bare, 'main');
    await git(remote.bare, 'reflog', 'expire', '--expire=now', '--all');
    await git(remote.bare, 'gc', '-q', '--prune=now');
    const ctx = await makeContext(sb);
    await expect(fetchSource(ctx, source(remote.bare), { sha: gone })).rejects.toMatchObject({
      code: 'E_SOURCE',
      message: `commit ${gone.slice(0, 7)} is gone from ${remote.bare} (history rewritten?)`,
      hint: 'palm update kit',
    });
  });

  it("R9' a sha the source does not have: ref X not found in the source", async () => {
    const remote = await makeRemote(sb.root);
    const ctx = await makeContext(sb);
    for (const ref of ['deadbee', 'e'.repeat(40)])
      await expect(fetchSource(ctx, source(remote.bare, { ref }))).rejects.toMatchObject({
        code: 'E_SOURCE',
        message: `ref ${ref} not found in kit`,
        hint: `git ls-remote --tags --heads ${remote.bare}`,
      });
  });
});

describe('B3 B6 refused writes', () => {
  it('B6 a read-only PALM_HOME is E_IO naming the cache and the permission', async () => {
    const remote = await makeRemote(sb.root);
    await mkdir(sb.palmHome, { recursive: true });
    await chmod(sb.palmHome, 0o500);
    const ctx = await makeContext(sb);
    await expect(
      fetchSource(ctx, { name: 'kit', type: 'git', url: remote.bare }),
    ).rejects.toMatchObject({
      code: 'E_IO',
      message: `cannot write ${join(sb.palmHome, 'cache')}: permission denied (EACCES)`,
      hint: expect.stringContaining('set PALM_HOME to a writable directory'),
    });
  });

  it('B3 a lock in a directory palm may not write is E_IO, not an internal error', async () => {
    const dir = join(sb.root, 'locked');
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o500);
    try {
      await expect(withLock(join(dir, 'sub', 'lock'), async () => 1)).rejects.toMatchObject({
        code: 'E_IO',
        message: expect.stringMatching(/^cannot write .*: permission denied \(EACCES\)$/),
      });
    } finally {
      await chmod(dir, 0o755);
    }
  });
});
