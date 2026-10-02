import { describe, expect, it, vi } from 'vitest';
import { fetchSource, listRemoteRefs } from '../../src/core/git.js';
import { GitFailure } from '../../src/core/git-exec.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, sandbox } from '../support/sandbox.js';

vi.mock('../../src/core/git-exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/git-exec.js')>();
  return {
    ...real,
    runGit: vi.fn(async (args: string[], call: { network?: boolean; timeoutMs?: number }) => {
      const ms = call.timeoutMs ?? (call.network ? 120_000 : 30_000);
      const detail = `git ${args[0]} timed out after ${ms / 1000} s`;
      throw new real.GitFailure(detail, detail, { network: Boolean(call.network), timedOutMs: ms });
    }),
  };
});

describe('git timeouts', () => {
  it('a network call that times out is E_NETWORK with a hint naming a command', async () => {
    const err = await listRemoteRefs('https://example.invalid/o/r.git').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(GitFailure);
    expect(err).toMatchObject({
      code: 'E_NETWORK',
      message:
        'cannot list the tags of https://example.invalid/o/r.git: git ls-remote timed out after 120 s',
    });
    expect((err as { hint: string }).hint).toContain(
      'git ls-remote https://example.invalid/o/r.git',
    );
  });

  it('a local step that times out is E_GIT pointing at palm cache clean', async () => {
    const sb = await sandbox();
    try {
      const ctx = await makeContext(sb);
      const src = { name: 'r', type: 'git' as const, url: 'https://example.invalid/o/r.git' };
      await expect(fetchSource(ctx, src, { sha: 'a'.repeat(40) })).rejects.toMatchObject({
        code: 'E_GIT',
        hint: expect.stringContaining('palm cache clean'),
      });
    } finally {
      await removeDir(sb.root);
    }
  });
});
