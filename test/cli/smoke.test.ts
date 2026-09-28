import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPalm } from '../support/cli.js';

const repo = resolve(import.meta.dirname, '../..');
let home: string;

function palm(...args: string[]) {
  return runPalm(args, {
    cwd: repo,
    env: { HOME: home, PALM_HOME: join(home, '.palm'), NO_COLOR: '1', CI: '1' },
  });
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'palm-cli-smoke-'));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('palm CLI smoke', () => {
  it('palm --help lists the command tree', async () => {
    const r = await palm('--help');
    expect(r.exitCode).toBe(0);
    for (const cmd of [
      'install|i',
      'uninstall|remove',
      'list|ls',
      'search',
      'info',
      'update',
      'origin',
      'create',
      'init',
      'targets',
      'config',
      'doctor',
    ]) {
      expect(r.stdout).toContain(cmd);
    }
    for (const opt of [
      '--global',
      '--target <ids>',
      '--dry-run',
      '--force',
      '--yes',
      '--offline',
      '--verbose',
      '--json',
    ]) {
      expect(r.stdout).toContain(opt);
    }
  });

  it('palm install --help shows install options and examples', async () => {
    const r = await palm('install', '--help');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Usage: palm install|i [options] [kind] [specs...]');
    for (const opt of [
      '--from <origin>',
      '--save-origin',
      '--secrets <policy>',
      '--prune',
      '--url <url>',
      '--header <K=V>',
      '--env <K=V>',
      '--transport <t>',
    ]) {
      expect(r.stdout).toContain(opt);
    }
    expect(r.stdout).toContain(
      'palm install mcp fs -- npx -y @modelcontextprotocol/server-filesystem .',
    );
  });

  it('palm --version prints the package version', async () => {
    const r = await palm('--version');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('usage errors exit 1 with message and hint on stderr', async () => {
    const r = await palm('install', 'skill');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('error: name the skill to install');
    expect(r.stderr).toContain('palm install');
  });

  it('unknown commands exit 1', async () => {
    const r = await palm('frobnicate');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown command 'frobnicate'");
  });
});

describe('palm --dry-run writes nothing (CLI)', () => {
  it('install --from … --save-origin --dry-run registers no origin and deploys no file', async () => {
    const project = join(home, 'dry-project');
    const { mkdir } = await import('node:fs/promises');
    const { existsSync, readdirSync } = await import('node:fs');
    await mkdir(join(project, '.git'), { recursive: true });
    const fixture = join(repo, 'test', 'fixtures', 'mattpocock-like');
    const r = await runPalm(
      [
        'install',
        'skill',
        'tdd',
        '--from',
        fixture,
        '--save-origin',
        '--dry-run',
        '--target',
        'claude',
      ],
      {
        cwd: project,
        env: {
          HOME: home,
          PALM_HOME: join(home, '.palm'),
          NO_COLOR: '1',
          CI: '1',
          PATH: process.env.PATH,
        },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).toContain('would register origin');
    expect(r.stdout).toContain('dry run: no harness files, lockfile or manifest were changed');
    expect(existsSync(join(home, '.palm', 'config.yaml'))).toBe(false);
    expect(readdirSync(project).sort()).toEqual(['.git']);
  });
});
