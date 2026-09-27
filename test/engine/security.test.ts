import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveLock } from '../../src/core/lockfile.js';
import type { LockEntry } from '../../src/core/types.js';
import { uninstallEntities } from '../../src/engine/uninstall.js';
import { removeDir } from '../core/helpers.js';
import { makeWorld, type World } from './world.js';

const entry = (over: Partial<LockEntry>): LockEntry => ({
  kind: 'skill',
  name: 'x',
  origin: 'a',
  path: 'skills/x',
  contentHash: 'sha256:0',
  installedAt: '2026-01-01T00:00:00Z',
  targets: ['claude'],
  files: [],
  ...over,
});

describe('lockfile paths can never make palm delete outside the scope', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  async function victim(): Promise<string> {
    const dir = join(w.sb.root, 'victim');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'data'), 'keep me');
    return dir;
  }

  it('project: a relative path climbing out of the project is ignored with a warning', async () => {
    w = await makeWorld();
    const dir = await victim();
    await mkdir(join(w.sb.project, '.claude/skill'), { recursive: true });
    await writeFile(join(w.sb.project, '.claude/skill/x.txt'), 'x');
    await saveLock(join(w.sb.project, 'palm.lock.yaml'), { version: 1, entries: [entry({ files: ['../victim/data', '.claude/skill/x.txt', '..'] })] });

    const r = await uninstallEntities(w.ctx, [{ kind: 'skill', name: 'x' }], { scope: 'project' }, w.deps);
    expect(await readFile(join(dir, 'data'), 'utf8')).toBe('keep me');
    expect(existsSync(join(w.sb.project, '.claude/skill/x.txt'))).toBe(false);
    expect(r.warnings.join('\n')).toMatch(/ignored lock paths outside the project scope: \.\.\/victim\/data, \.\./);
  });

  it('global: an absolute path outside home / palm home is ignored', async () => {
    w = await makeWorld();
    const dir = await victim();
    await saveLock(join(w.sb.palmHome, 'palm.lock.yaml'), { version: 1, entries: [entry({ files: [join(dir, 'data'), join(w.sb.home, '..', 'victim')] })] });
    await uninstallEntities(w.ctx, [{ kind: 'skill', name: 'x' }], { scope: 'global' }, w.deps);
    expect(await readFile(join(dir, 'data'), 'utf8')).toBe('keep me');
  });

  it('a hook entity named with ../ does not wipe a directory on uninstall (real targets)', async () => {
    w = await makeWorld();
    w.deps.getTarget = (await import('../../src/targets/index.js')).getTarget;
    const dir = await victim();
    await saveLock(join(w.sb.project, 'palm.lock.yaml'), {
      version: 1,
      entries: [entry({ kind: 'hook', name: '../../../victim', targets: ['claude', 'codex'], files: [] })],
    });
    await uninstallEntities(w.ctx, [{ kind: 'hook', name: '../../../victim' }], { scope: 'project' }, w.deps);
    expect(await readFile(join(dir, 'data'), 'utf8')).toBe('keep me');
  });
});

describe('literal secrets stay in the harness config only', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  async function grepTree(dir: string, needle: string): Promise<string[]> {
    const { readdir, stat } = await import('node:fs/promises');
    const hits: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const name of await readdir(d)) {
        const p = join(d, name);
        const st = await stat(p);
        if (st.isDirectory()) await walk(p);
        else if ((await readFile(p, 'utf8').catch(() => '')).includes(needle)) hits.push(p);
      }
    };
    await walk(dir);
    return hits.sort();
  }

  it('global literal install: value only in ~/.claude.json etc. (0600), lock/manifest/JSON carry placeholders; uninstall still removes it', async () => {
    w = await makeWorld();
    const { getTarget } = await import('../../src/targets/index.js');
    const { resolveSecrets } = await import('../../src/mcp/secrets.js');
    const { installEntities } = await import('../../src/engine/install.js');
    const { stat } = await import('node:fs/promises');
    w.deps.getTarget = getTarget;
    w.deps.resolveSecrets = resolveSecrets;
    const SECRET = 'sk-supersecret-4242';
    w.ctx.env = { ...w.ctx.env, DOCS_TOKEN: SECRET };
    await mkdir(join(w.sb.home, '.codex'), { recursive: true });

    const adhocMcp = { name: 'docs', transport: 'http' as const, url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } };
    const targets = ['claude', 'codex', 'copilot', 'cursor'] as const;
    const r = await installEntities(w.ctx, [{ kind: 'mcp', spec: 'docs', adhocMcp }], { scope: 'global', targets: [...targets] }, w.deps);
    expect(JSON.stringify(r)).not.toContain(SECRET);

    const harnessFiles = [
      join(w.sb.home, '.claude.json'),
      join(w.sb.home, '.codex', 'config.toml'),
      join(w.sb.home, '.copilot', 'mcp-config.json'),
      join(w.sb.home, '.cursor', 'mcp.json'),
    ].sort();
    expect(await grepTree(w.sb.root, SECRET)).toEqual(harnessFiles);
    for (const f of harnessFiles) expect((await stat(f)).mode & 0o777).toBe(0o600);
    const lockText = await readFile(join(w.sb.palmHome, 'palm.lock.yaml'), 'utf8');
    expect(lockText).toContain('Bearer ${DOCS_TOKEN}');

    await uninstallEntities(w.ctx, [{ kind: 'mcp', name: 'docs' }], { scope: 'global' }, w.deps);
    expect(await grepTree(w.sb.root, SECRET)).toEqual([]);
  });
});
