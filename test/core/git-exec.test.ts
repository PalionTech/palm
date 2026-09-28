import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanGitEnv,
  DROPPED_GIT_ENV,
  GitFailure,
  gitArgs,
  isGitTimeout,
  isSshUrl,
  LOCAL_TIMEOUT_MS,
  NETWORK_TIMEOUT_MS,
  runGit,
  withBatchMode,
} from '../../src/core/git-exec.js';
import { removeDir, tempDir } from '../support/sandbox.js';

describe('cleanGitEnv', () => {
  const hostile: NodeJS.ProcessEnv = {
    GIT_DIR: '/victim/.git',
    GIT_WORK_TREE: '/victim',
    GIT_INDEX_FILE: '/victim/.git/index',
    GIT_OBJECT_DIRECTORY: '/victim/.git/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/victim/.git/objects',
    GIT_NAMESPACE: 'ns',
    GIT_CEILING_DIRECTORIES: '/',
    GIT_COMMON_DIR: '/victim/.git',
    GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/evil'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'touch /tmp/pwned',
    GIT_EXEC_PATH: '/evil',
    GIT_TEMPLATE_DIR: '/evil',
    GIT_ASKPASS: '/bin/echo',
    SSH_ASKPASS: '/bin/echo',
    GITHUB_TOKEN: 'secret',
    NODE_OPTIONS: '--require /evil.js',
  };
  const kept: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/u',
    USER: 'u',
    LOGNAME: 'u',
    LANG: 'de_DE.UTF-8',
    LC_ALL: 'de_DE.UTF-8',
    LC_MESSAGES: 'C',
    TMPDIR: '/tmp/u',
    XDG_CONFIG_HOME: '/home/u/.config',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    GIT_CONFIG_GLOBAL: '/home/u/.gitconfig-work',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSH: '/usr/local/bin/my-ssh',
    https_proxy: 'http://proxy:3128',
    HTTPS_PROXY: 'http://proxy:3128',
    NO_PROXY: 'localhost',
    GIT_SSL_CAINFO: '/etc/ca.pem',
  };

  it('keeps the allow list, drops everything that redirects git, and never prompts', () => {
    const env = cleanGitEnv({ ...hostile, ...kept });
    expect(env).toEqual({ ...kept, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
    for (const name of DROPPED_GIT_ENV) expect(env).not.toHaveProperty(name);
  });

  it('adds BatchMode to a user GIT_SSH_COMMAND that runs ssh, once', () => {
    expect(cleanGitEnv({ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work' }).GIT_SSH_COMMAND).toBe(
      'ssh -i ~/.ssh/work -o BatchMode=yes',
    );
    expect(cleanGitEnv({ GIT_SSH_COMMAND: 'ssh -o batchmode=no' }).GIT_SSH_COMMAND).toBe(
      'ssh -o batchmode=no',
    );
    expect(cleanGitEnv({ GIT_SSH_COMMAND: 'plink -batch' }).GIT_SSH_COMMAND).toBe('plink -batch');
  });

  it('withBatchMode only touches OpenSSH commands', () => {
    expect(withBatchMode('ssh')).toBe('ssh -o BatchMode=yes');
    expect(withBatchMode('/usr/bin/ssh -p 2222')).toBe('/usr/bin/ssh -p 2222 -o BatchMode=yes');
    expect(withBatchMode('ssh -o BatchMode=yes')).toBe('ssh -o BatchMode=yes');
    expect(withBatchMode('my-wrapper.sh')).toBe('my-wrapper.sh');
  });
});

describe('isSshUrl', () => {
  it.each<[string, boolean]>([
    ['git@github.com:o/r.git', true],
    ['ssh://git@host/o/r.git', true],
    ['git+ssh://host/o/r', true],
    ['https://github.com/o/r.git', false],
    ['file:///srv/r.git', false],
    ['/srv/r.git', false],
  ])('%s → %s', (url, expected) => {
    expect(isSshUrl(url)).toBe(expected);
  });
});

describe('gitArgs', () => {
  const env = {
    HOME: '/nonexistent-home',
    GIT_CONFIG_GLOBAL: '/dev/null',
    PATH: process.env.PATH ?? '',
  };

  it('hardens transports and credentials on every call', async () => {
    const args = await gitArgs(['ls-remote', '--', 'https://h/o/r'], { url: 'https://h/o/r' }, env);
    expect(args).toEqual([
      '-c',
      'protocol.ext.allow=never',
      '-c',
      'protocol.fd.allow=never',
      '-c',
      'protocol.file.allow=never',
      '-c',
      'credential.interactive=false',
      'ls-remote',
      '--',
      'https://h/o/r',
    ]);
    const local = await gitArgs(['clone'], { url: '/srv/r.git' }, env);
    expect(local).toContain('protocol.file.allow=user');
  });

  it('runs ssh remotes in batch mode', async () => {
    const args = await gitArgs(['fetch'], { url: 'git@example.invalid:o/r.git' }, env);
    expect(args).toContain('core.sshCommand=ssh -o BatchMode=yes');
    expect(args.indexOf('core.sshCommand=ssh -o BatchMode=yes')).toBeLessThan(
      args.indexOf('fetch'),
    );
  });

  it('keeps the user’s global core.sshCommand, adding BatchMode', async () => {
    const dir = await tempDir();
    try {
      const cfg = join(dir, 'gitconfig');
      await writeFile(cfg, '[core]\n\tsshCommand = ssh -i ~/.ssh/work_key\n');
      const args = await gitArgs(
        ['fetch'],
        { url: 'ssh://git@example.invalid/o/r.git' },
        { ...env, GIT_CONFIG_GLOBAL: cfg },
      );
      expect(args).toContain('core.sshCommand=ssh -i ~/.ssh/work_key -o BatchMode=yes');
    } finally {
      await removeDir(dir);
    }
  });

  it('leaves ssh to GIT_SSH_COMMAND / GIT_SSH when the user set them', async () => {
    const url = { url: 'git@example.invalid:o/r.git' };
    const viaCommand = await gitArgs(['fetch'], url, { ...env, GIT_SSH_COMMAND: 'ssh -v' });
    expect(viaCommand.some((a) => a.startsWith('core.sshCommand='))).toBe(false);
    const viaProgram = await gitArgs(['fetch'], url, { ...env, GIT_SSH: '/bin/my-ssh' });
    expect(viaProgram.some((a) => a.startsWith('core.sshCommand='))).toBe(false);
  });
});

describe('runGit', () => {
  let dir: string;
  const savedPath = process.env.PATH;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    process.env.PATH = savedPath;
    await removeDir(dir);
  });

  /** A fake `git` first on PATH that records its arguments and environment, then runs `body`. */
  async function fakeGit(body: string): Promise<void> {
    const bin = join(dir, 'bin');
    await mkdir(bin, { recursive: true });
    const script = join(bin, 'git');
    await writeFile(
      script,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\nenv > "${dir}/env"\n${body}\n`,
    );
    await chmod(script, 0o755);
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
  }

  it('has a timeout on every call', () => {
    expect(NETWORK_TIMEOUT_MS).toBe(120_000);
    expect(LOCAL_TIMEOUT_MS).toBe(30_000);
  });

  it('kills a hanging git and reports a timeout', async () => {
    await fakeGit('sleep 30');
    const err = await runGit(['fetch', 'origin'], { network: true, timeoutMs: 300 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GitFailure);
    expect(isGitTimeout(err)).toBe(true);
    expect((err as GitFailure).opts).toEqual({ network: true, timedOutMs: 300 });
    expect((err as GitFailure).message).toBe('git fetch timed out after 300 ms');
  });

  it('spawns git with the clean environment only', async () => {
    await fakeGit('echo ok');
    process.env.GIT_DIR = '/victim/.git';
    process.env.GIT_CONFIG_COUNT = '1';
    try {
      expect(await runGit(['status'])).toBe('ok');
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_CONFIG_COUNT;
    }
    const { readFile } = await import('node:fs/promises');
    const seen = await readFile(join(dir, 'env'), 'utf8');
    expect(seen).toContain('GIT_TERMINAL_PROMPT=0');
    expect(seen).not.toMatch(/^GIT_DIR=/m);
    expect(seen).not.toMatch(/^GIT_CONFIG_COUNT=/m);
    const args = (await readFile(join(dir, 'args'), 'utf8')).trim().split('\n');
    expect(args.slice(-1)).toEqual(['status']);
    expect(args).toContain('protocol.ext.allow=never');
  });
});
