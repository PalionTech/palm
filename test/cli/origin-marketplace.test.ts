/**
 * `palm install origin <marketplace URL>`: index/marketplace.ts downloads and expands it (no temp
 * files in the command); a GitHub blob URL is fetched as its raw.githubusercontent.com form.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { makeRemote } from '../core/gitrepo.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { runInProcess } from './helpers.js';

const BLOB = 'https://github.com/acme/market/blob/main/.claude-plugin/marketplace.json';
const RAW = 'https://raw.githubusercontent.com/acme/market/main/.claude-plugin/marketplace.json';

let sb: Sandbox;
let fetched: string[];
beforeEach(async () => {
  sb = await sandbox();
  const remote = await makeRemote(sb.root);
  const marketplace = {
    name: 'acme',
    plugins: [
      { name: 'tools', source: { source: 'url', url: pathToFileURL(remote.bare).href } },
      { name: 'npm-thing', source: { source: 'npm', package: 'x' } },
    ],
  };
  fetched = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    fetched.push(String(input));
    return new Response(JSON.stringify(marketplace), { status: 200 });
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await removeDir(sb.root);
});

const env = () => ({ ...sb.env, NO_COLOR: '1', PATH: process.env.PATH });

describe('palm install origin <marketplace URL>', () => {
  it('downloads the raw file, adds each plugin it can, and warns about the rest', async () => {
    const r = await runInProcess(['install', 'origin', BLOB, '--yes'], {
      cwd: sb.project,
      env: env(),
    });
    expect(r.code).toBe(0);
    expect(fetched).toEqual([RAW]);
    expect(r.stderr).toContain('plugin "npm-thing": npm source x is not supported; skipped');
    const config = parse(await readFile(`${sb.palmHome}/config.yaml`, 'utf8'));
    expect(config.origins).toEqual([
      expect.objectContaining({
        alias: 'tools',
        type: 'git',
        url: expect.stringMatching(/^file:/),
      }),
    ]);
  });

  it('--offline: E_NETWORK before any download, exit 1', async () => {
    const r = await runInProcess(['install', 'origin', BLOB, '--offline'], {
      cwd: sb.project,
      env: env(),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cannot download a marketplace file with --offline');
    expect(fetched).toEqual([]);
  });
});
