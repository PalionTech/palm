import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeDir } from '../support/sandbox.js';
import { type CliSandbox, cliSandbox, writeOrigins } from './helpers.js';

async function fakeCache(sb: CliSandbox): Promise<string> {
  const cache = join(sb.palmHome, 'cache');
  await mkdir(join(cache, 'github.com__a__b', 'repo'), { recursive: true });
  await writeFile(join(cache, 'github.com__a__b', 'repo', 'SKILL.md'), 'x'.repeat(2048));
  await mkdir(join(cache, 'github.com__c__d', 'repo'), { recursive: true });
  await writeFile(join(cache, 'github.com__a__b.index.json'), '{}');
  return cache;
}

describe('palm cache', () => {
  let sb: CliSandbox | undefined;
  afterEach(async () => {
    if (sb) await removeDir(sb.root);
    sb = undefined;
  });

  it('info: path, size, checkouts and index files', async () => {
    sb = await cliSandbox();
    const cache = await fakeCache(sb);
    const r = await sb.palm('cache', 'info', '--json');
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      path: cache,
      exists: true,
      checkouts: 2,
      indexes: 1,
    });
    const human = await sb.palm('cache', 'info');
    expect(human.stdout).toMatch(/checkouts\s+2/);
    expect(human.stdout).toMatch(/size\s+2\.\d KB/);
  });

  it('clean needs --yes without a terminal, then removes the cache and keeps the origins', async () => {
    sb = await cliSandbox();
    await writeOrigins(sb, [{ alias: 'matt', fixture: 'mattpocock-like' }]);
    const cache = await fakeCache(sb);
    const refused = await sb.palm('cache', 'clean');
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('palm cache clean --yes');
    expect(existsSync(cache)).toBe(true);
    const dry = await sb.palm('cache', 'clean', '--dry-run');
    expect(dry.stdout).toContain('dry run: would remove');
    expect(existsSync(cache)).toBe(true);
    const r = await sb.palm('cache', 'clean', '--yes');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('- 2 checkouts and 1 indexes');
    expect(existsSync(cache)).toBe(false);
    expect(existsSync(sb.configFile)).toBe(true);
    const origins = await sb.palm('get', 'origins');
    expect(origins.stdout).toMatch(/^matt\s+local/m);
    const empty = await sb.palm('cache', 'clean', '--yes');
    expect(empty.stdout).toContain('already empty');
  });
});
