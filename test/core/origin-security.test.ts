import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config-file.js';
import { fetchOrigin, listRemoteTags, pingRemote } from '../../src/core/git.js';
import { parseOriginInput, validateOriginUrl } from '../../src/core/origin-input.js';
import { fakeLogger, makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';

describe('origin URL validation (git argument / transport injection)', () => {
  let sb: Sandbox;
  afterEach(async () => sb && removeDir(sb.root));

  it('accepts https, ssh, scp-like, file:// and absolute paths; warns for http and git://', () => {
    for (const ok of [
      'https://github.com/a/b.git',
      'ssh://git@host/a/b.git',
      'git@github.com:a/b.git',
      'file:///tmp/r.git',
      '/srv/repos/r.git',
    ]) {
      expect(validateOriginUrl(ok)).toEqual({});
    }
    expect(validateOriginUrl('http://host/a/b.git').warning).toMatch(/unencrypted/);
    expect(validateOriginUrl('git://host/a/b.git').warning).toMatch(/unencrypted/);
  });

  it('rejects option-looking values, transport helpers, odd schemes and control characters', () => {
    for (const bad of [
      '--upload-pack=touch /tmp/pwned;true',
      '-oProxyCommand=sh',
      'ext::sh -c touch% /tmp/pwned',
      'fd::17',
      'file::/etc',
      'transport::x',
      'ftp://host/r.git',
      'ssh://-oProxyCommand=x/r',
      'git@-host:r.git',
      'https://host/r.git\nx',
      'relative/path.git',
    ]) {
      expect(() => validateOriginUrl(bad), bad).toThrow(/Refusing/);
    }
  });

  it('parseOriginInput refuses them too', () => {
    expect(() => parseOriginInput('ext::sh -c touch% /tmp/x')).toThrow();
    expect(() => parseOriginInput('ssh://-oProxyCommand=touch%20x/repo')).toThrow(/Refusing/);
  });

  it('stored origins are validated on load (config.yaml fails loudly, palm.yaml entries are skipped)', async () => {
    sb = await sandbox();
    const marker = join(sb.root, 'pwned');
    await mkdir(sb.palmHome, { recursive: true });
    await writeFile(
      join(sb.palmHome, 'config.yaml'),
      `origins:\n  - alias: evil\n    url: "--upload-pack=touch ${marker};true"\n`,
    );
    await expect(
      loadConfig({
        palmHome: sb.palmHome,
        home: sb.home,
        projectRoot: sb.project,
        cwd: sb.project,
      }),
    ).rejects.toMatchObject({ code: 'E_ORIGIN' });

    await writeFile(join(sb.palmHome, 'config.yaml'), 'origins: []\n');
    await writeFile(
      join(sb.project, 'palm.yaml'),
      `origins:\n  - alias: evil\n    url: "--upload-pack=touch ${marker};true"\n`,
    );
    const log = fakeLogger();
    const ctx = await makeContext(sb, { log });
    expect(ctx.origins.specs()).toEqual([]);
    expect(log.messages.map((m) => m.msg).join('\n')).toMatch(/Refusing/);
    expect(existsSync(marker)).toBe(false);
  });

  it('fetch, tag listing and doctor’s remote ping never hand such a URL to git', async () => {
    sb = await sandbox();
    const ctx = await makeContext(sb);
    const marker = join(sb.root, 'pwned');
    const url = `--upload-pack=touch ${marker};true`;
    await expect(fetchOrigin(ctx, { alias: 'evil', type: 'git', url })).rejects.toMatchObject({
      code: 'E_ORIGIN',
    });
    await expect(listRemoteTags(url)).rejects.toMatchObject({ code: 'E_ORIGIN' });
    await expect(pingRemote(url)).rejects.toMatchObject({ code: 'E_ORIGIN' });
    await expect(pingRemote(`ext::sh -c touch% ${marker}`)).rejects.toMatchObject({
      code: 'E_ORIGIN',
    });
    expect(existsSync(marker)).toBe(false);
  });
});
