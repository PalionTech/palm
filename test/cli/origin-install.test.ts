import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { removeDir } from '../support/sandbox.js';
import { type CliSandbox, cliSandbox, FIXTURES } from './helpers.js';

async function config(sb: CliSandbox): Promise<{ origins?: Array<Record<string, unknown>> }> {
  return parse(await readFile(sb.configFile, 'utf8')) ?? {};
}

describe('palm install origin: fetch and index first, save only then', () => {
  let sb: CliSandbox | undefined;
  afterEach(async () => {
    if (sb) await removeDir(sb.root);
    sb = undefined;
  });

  it.each([
    ['a file:// URL to a directory that does not exist', 'file:///nonexistent/palm-test-repo'],
    ['a local path that does not exist', '/nonexistent/palm-test-dir'],
  ])('%s: exit 1, nothing written', async (_label, spec) => {
    sb = await cliSandbox();
    const r = await sb.palm('install', 'origin', spec);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^x /m);
    expect(existsSync(sb.configFile)).toBe(false);
  });

  it('a file:// URL to a directory that is not a git repository: exit 1, nothing written, a runnable hint', async () => {
    sb = await cliSandbox();
    const dir = join(sb.root, 'not-a-repo');
    await mkdir(dir);
    const r = await sb.palm('install', 'origin', `file://${dir}`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('was not added');
    expect(r.stderr).toContain(`git ls-remote file://${dir}`);
    expect(existsSync(sb.configFile)).toBe(false);
  });

  it('--offline with a repository that is not cached (the typo case): exit 1, nothing written', async () => {
    sb = await cliSandbox();
    const r = await sb.palm('install', 'origin', 'anthropic/skills', '--offline');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('origin anthropic was not added');
    expect(r.stderr).toContain('palm install origin anthropic/skills');
    expect(existsSync(sb.configFile)).toBe(false);
    const old = await sb.palm('origin', 'add', 'anthropic/skills', '--offline');
    expect(old.exitCode).toBe(1);
    expect(existsSync(sb.configFile)).toBe(false);
  });

  it('a reachable origin is indexed, then saved; uninstall origin removes it', async () => {
    sb = await cliSandbox();
    const path = join(FIXTURES, 'mattpocock-like');
    const r = await sb.palm('install', 'origin', path, '--alias', 'matt');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('+ origin matt');
    expect(r.stdout).toContain('detected: marketplace');
    expect(r.stdout).toContain('install with: palm install skill');
    expect((await config(sb)).origins).toEqual([{ alias: 'matt', type: 'local', path }]);

    const list = await sb.palm('get', 'origins', '--json');
    expect(JSON.parse(list.stdout).items.map((o: { alias: string }) => o.alias)).toEqual(['matt']);

    const described = await sb.palm('describe', 'origin', 'matt');
    expect(described.exitCode).toBe(0);
    expect(described.stdout).toMatch(/detected\s+marketplace/);
    expect(described.stdout).toMatch(/entities\s+\d+ skills/);
    expect(described.stdout).toContain('index file');

    const removed = await sb.palm('uninstall', 'origin', 'matt');
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain('- origin matt');
    expect((await config(sb)).origins ?? []).toEqual([]);
  });

  it('the old forms do the same: origin add / list / remove', async () => {
    sb = await cliSandbox();
    const path = join(FIXTURES, 'anthropics-skills-like');
    const added = await sb.palm('origin', 'add', path, '--alias', 'anth');
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toContain('+ origin anth');
    const listed = await sb.palm('origin', 'list');
    expect(listed.stdout).toMatch(/^anth\s+local/m);
    expect((await sb.palm('origin', 'remove', 'anth')).exitCode).toBe(0);
    expect((await config(sb)).origins ?? []).toEqual([]);
  });

  it('--dry-run indexes but saves nothing; --project saves into palm.yaml', async () => {
    sb = await cliSandbox();
    const path = join(FIXTURES, 'mattpocock-like');
    const dry = await sb.palm('install', 'origin', path, '--alias', 'matt', '--dry-run');
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain('dry run: would add origin matt');
    expect(existsSync(sb.configFile)).toBe(false);
    const project = await sb.palm('install', 'origin', path, '--alias', 'matt', '--project');
    expect(project.exitCode).toBe(0);
    const manifest = parse(await readFile(join(sb.project, 'palm.yaml'), 'utf8'));
    expect(manifest.origins).toEqual([expect.objectContaining({ alias: 'matt' })]);
  });

  it('a marketplace.json adds each plugin it lists as an origin (and origin import still works)', async () => {
    sb = await cliSandbox();
    const file = join(FIXTURES, 'superpowers-like', '.claude-plugin', 'marketplace.json');
    const r = await sb.palm('install', 'origin', file, '-y');
    expect(r.exitCode).toBe(0);
    const aliases = ((await config(sb)).origins ?? []).map((o) => o.alias);
    expect(aliases.length).toBeGreaterThan(0);
    const again = await sb.palm('origin', 'import', join(FIXTURES, 'superpowers-like'), '-y');
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain('already registered as');
    expect(((await config(sb)).origins ?? []).map((o) => o.alias)).toEqual(aliases);
  });

  it('update origins refreshes every index; an unknown alias is E_NOT_FOUND', async () => {
    sb = await cliSandbox();
    await sb.palm('install', 'origin', join(FIXTURES, 'mattpocock-like'), '--alias', 'matt');
    const r = await sb.palm('update', 'origins');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^~ matt: \d+ skills/m);
    const missing = await sb.palm('update', 'origin', 'nobody');
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('nobody');
  });
});
