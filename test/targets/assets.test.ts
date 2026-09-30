/** The asset closure: what is copied, modes, links that leave the source, the asset root. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScopePaths } from '../../src/domain/scope-paths.js';
import type { SourceRef } from '../../src/domain/source.js';
import { assetRootFor, copyClosure } from '../../src/targets/assets.js';
import { cleanupTmp, exists, fakeEnv, read, tmpDir, write } from './helpers.js';

vi.mock('../../src/lib/fs.js', async (orig) => (await import('./fakes.js')).withFs(await orig()));
vi.mock('../../src/domain/scope-paths.js', async (orig) =>
  (await import('./fakes.js')).withScopePaths(await orig()),
);
vi.mock('../../src/domain/ignore.js', async (orig) =>
  (await import('./fakes.js')).withIgnore(await orig()),
);
vi.mock('../../src/core/hash.js', async (orig) =>
  (await import('./fakes.js')).withHash(await orig()),
);

afterEach(cleanupTmp);

async function plugin(): Promise<string> {
  const src = await tmpDir('palm-source-');
  await write(path.join(src, 'p/hooks/hooks.json'), '{}');
  await write(path.join(src, 'p/hooks/run.sh'), '#!/bin/sh\n', 0o775);
  await write(path.join(src, 'p/hooks/lib/data.txt'), 'data\n', 0o640);
  await write(path.join(src, 'p/hooks/SKILL.md'), 'never copied\n');
  await write(path.join(src, 'p/hooks/.gitignore'), 'x\n');
  await write(path.join(src, 'p/hooks/node_modules/x.js'), 'x\n');
  await write(path.join(src, 'p/scripts/extra.py'), 'print(1)\n', 0o755);
  await write(path.join(src, 'p/scripts/other.py'), 'print(2)\n');
  return src;
}

describe('copyClosure', () => {
  it('copies the hook directory and the named files, git modes kept, excluded names left out', async () => {
    const src = await plugin();
    const dest = path.join(await tmpDir(), '.palm/assets/s/e');
    const files = await copyClosure({
      sourceRoot: src,
      closure: { paths: ['p/hooks', 'p/scripts/extra.py'] },
      destAbs: dest,
      boundary: src,
    });
    expect(files.map((f) => [f.path, f.mode.toString(8)])).toEqual([
      ['p/hooks/hooks.json', '644'],
      ['p/hooks/lib/data.txt', '644'],
      ['p/hooks/run.sh', '755'],
      ['p/scripts/extra.py', '755'],
    ]);
    expect(files[2]?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await fs.stat(path.join(dest, 'p/hooks/run.sh'))).mode & 0o777).toBe(0o755);
    expect(await exists(path.join(dest, 'p/hooks/SKILL.md'))).toBe(false);
    expect(await exists(path.join(dest, 'p/scripts/other.py'))).toBe(false);
  });

  it('dereferences a link that stays inside the source', async () => {
    const src = await plugin();
    await fs.symlink(path.join(src, 'p/scripts/other.py'), path.join(src, 'p/hooks/linked.py'));
    const dest = path.join(await tmpDir(), 'assets');
    await copyClosure({
      sourceRoot: src,
      closure: { paths: ['p/hooks'] },
      destAbs: dest,
      boundary: src,
    });
    const copied = path.join(dest, 'p/hooks/linked.py');
    expect((await fs.lstat(copied)).isSymbolicLink()).toBe(false);
    expect(await read(copied)).toBe('print(2)\n');
  });

  it('refuses a link that leaves the source before writing anything', async () => {
    const src = await plugin();
    const secret = path.join(await tmpDir('palm-home-'), 'id_rsa');
    await write(secret, 'PRIVATE KEY\n');
    await fs.symlink(secret, path.join(src, 'p/hooks/key'));
    const dest = path.join(await tmpDir(), 'assets');
    await expect(
      copyClosure({
        sourceRoot: src,
        closure: { paths: ['p/hooks'] },
        destAbs: dest,
        boundary: src,
      }),
    ).rejects.toMatchObject({
      code: 'E_SOURCE',
      message: expect.stringContaining('outside the source'),
    });
    await fs.symlink(secret, path.join(src, 'p/named'));
    await expect(
      copyClosure({
        sourceRoot: src,
        closure: { paths: ['p/named'] },
        destAbs: dest,
        boundary: src,
      }),
    ).rejects.toMatchObject({ code: 'E_SOURCE', message: expect.stringContaining(secret) });
    expect(await exists(dest)).toBe(false);
  });

  it('a closure path missing in the source is E_SOURCE', async () => {
    const src = await plugin();
    await expect(
      copyClosure({
        sourceRoot: src,
        closure: { paths: ['p/gone.sh'] },
        destAbs: src,
        boundary: src,
      }),
    ).rejects.toMatchObject({ code: 'E_SOURCE' });
  });
});

describe('assetRootFor', () => {
  const source = (name: string, p?: string): SourceRef =>
    ({
      name,
      assetDir: name.replace(/^\.\//, '').replaceAll('/', '__'),
      source: { name, type: p ? 'local' : 'git', ...(p ? { path: p } : {}) },
    }) as unknown as SourceRef;

  it('git sources: .palm/assets/<source>/<entity>, <palm>/assets globally; in place: the source dir', async () => {
    const root = await tmpDir();
    const project = new ScopePaths('project', root, path.join(root, 'palm-home'), fakeEnv(root));
    expect(assetRootFor(project, source('trailofbits/skills'), 'gh-cli', false)).toBe(
      '.palm/assets/trailofbits__skills/gh-cli',
    );
    expect(
      assetRootFor(project, source('./agent-kit', path.join(root, 'agent-kit')), 'q', true),
    ).toBe('agent-kit');
    const global = new ScopePaths('global', root, path.join(root, '.palm'), fakeEnv(root));
    expect(assetRootFor(global, source('acme/kit'), 'x', false)).toBe('<palm>/assets/acme__kit/x');
    expect(assetRootFor(global, source('./kit', path.join(root, '.palm/kit')), 'x', true)).toBe(
      '<palm>/kit',
    );
    expect(() => assetRootFor(project, source('acme/kit'), '../x', false)).toThrow(
      expect.objectContaining({ code: 'E_USAGE' }),
    );
  });
});
