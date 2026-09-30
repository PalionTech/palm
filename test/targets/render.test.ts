/**
 * Render: pure (the destination is never read), secrets never in the hash, symlinks never copy
 * files from outside the source, entity names cannot escape their directory, in-place sources
 * copy nothing.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TargetId } from '../../src/core/types.js';
import { TARGET_IDS } from '../../src/core/types.js';
import { createTarget } from '../../src/targets/index.js';
import {
  allKinds,
  cleanupTmp,
  exists,
  fakeEnv,
  install,
  makeSource,
  mkEntity,
  renderInput,
  SKILL_MD,
  tmpDir,
  write,
} from './helpers.js';

vi.mock('../../src/lib/fs.js', async (orig) => (await import('./fakes.js')).withFs(await orig()));
vi.mock('../../src/domain/scope-paths.js', async (orig) =>
  (await import('./fakes.js')).withScopePaths(await orig()),
);
vi.mock('../../src/domain/lock.js', async (orig) =>
  (await import('./fakes.js')).withLock(await orig()),
);
vi.mock('../../src/domain/merged-record.js', async (orig) =>
  (await import('./fakes.js')).withMergedRecord(await orig()),
);
vi.mock('../../src/domain/ignore.js', async (orig) =>
  (await import('./fakes.js')).withIgnore(await orig()),
);
vi.mock('../../src/core/hash.js', async (orig) =>
  (await import('./fakes.js')).withHash(await orig()),
);

afterEach(cleanupTmp);

describe('render is pure', () => {
  it.each(TARGET_IDS)(
    '%s: a populated, edited destination does not change the render',
    async (id) => {
      const root = await tmpDir();
      const src = await makeSource();
      const target = createTarget(id, fakeEnv(root));
      const inputs = allKinds(src).map((k) =>
        renderInput({ ...k, scope: 'project', scopeRoot: root, sourceRoot: src.root }),
      );
      const first = [];
      for (const input of inputs) first.push(await target.render(input));
      for (const r of first)
        await target.apply({
          rendered: r,
          scopeRoot: root,
          owned: [],
          force: false,
          dryRun: false,
        });
      // edit every file palm wrote, and every shared file it merged into
      const touched = [...first.flatMap((r) => r.files.map((f) => f.path))];
      for (const f of touched) await write(path.join(root, f), 'edited\n');
      const again = [];
      for (const input of inputs) again.push(await target.render(input));
      expect(again).toEqual(first);
    },
  );
});

describe('secrets and the render hash', () => {
  async function mcpRender(id: TargetId, over: object) {
    const root = await tmpDir();
    const src = await makeSource();
    const k = allKinds(src).find((e) => e.label === 'mcp stdio')!;
    const input = renderInput(
      { ...k, scope: 'project', scopeRoot: root, sourceRoot: src.root },
      over,
    );
    return createTarget(id, fakeEnv(root)).render(input);
  }

  it('a secret value is written but never hashed; the literal policy is', async () => {
    const envRef = await mcpRender('cursor', {});
    const a = await mcpRender('cursor', {
      secretPolicy: 'literal',
      secretValues: { GH_TOKEN: 'ghp_a' },
    });
    const b = await mcpRender('cursor', {
      secretPolicy: 'literal',
      secretValues: { GH_TOKEN: 'ghp_b' },
    });
    expect(a.fragments[0]?.value).toMatchObject({ env: { GH_TOKEN: 'ghp_a' } });
    expect(a.hash).toBe(b.hash); // a rotated secret does not re-render
    expect(a.hash).not.toBe(envRef.hash); // a policy change does
    expect(a.fragments[0]).toMatchObject({ mode: 0o600 });
  });
});

describe('symlinks never copy files from outside the source (security)', () => {
  it('skill: an outside link is skipped and reported; a link inside the source is followed', async () => {
    const src = await makeSource();
    const outside = await tmpDir('palm-outside-');
    await write(path.join(outside, 'id_rsa'), 'PRIVATE KEY');
    await fs.symlink(path.join(outside, 'id_rsa'), path.join(src.skillDir, 'leak.md'));
    await write(path.join(src.root, 'shared', 'glossary.md'), '# glossary');
    await fs.symlink(path.join(src.root, 'shared'), path.join(src.skillDir, 'shared'));
    const root = await tmpDir();
    const k = allKinds(src).find((e) => e.label === 'skill')!;
    for (const id of ['claude', 'codex'] as const) {
      const r = await createTarget(id, fakeEnv(root)).render(
        renderInput({ ...k, scope: 'project', scopeRoot: root, sourceRoot: src.root }),
      );
      const paths = r.files.map((f) => f.path);
      expect(paths.some((f) => f.endsWith('/leak.md'))).toBe(false);
      expect(paths.some((f) => f.endsWith('/shared/glossary.md'))).toBe(true);
      expect(r.notes.join('\n')).toMatch(/not copied \(a link leaving the source\): leak\.md/);
    }
  });

  it('a skill directory that is itself a link out of the source copies nothing', async () => {
    const src = await makeSource();
    const outside = await tmpDir('palm-outside-');
    await write(path.join(outside, 'SKILL.md'), SKILL_MD);
    const linked = path.join(src.root, 'skills', 'evil');
    await fs.symlink(outside, linked);
    const root = await tmpDir();
    const entity = mkEntity({ kind: 'skill', skill: { name: 'evil', description: 'd' } }, 'evil');
    const input = renderInput({
      entity,
      absPath: linked,
      scope: 'project',
      scopeRoot: root,
      sourceRoot: src.root,
    });
    await expect(createTarget('claude', fakeEnv(root)).render(input)).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    });
  });

  it('hook closure: a link to a home directory refuses the hook', async () => {
    const src = await makeSource();
    const fakeHome = await tmpDir('palm-home-');
    await write(path.join(fakeHome, '.ssh', 'id_rsa'), 'PRIVATE KEY');
    await fs.symlink(fakeHome, path.join(src.root, 'plugins/fmt/hooks/home'));
    const root = await tmpDir();
    const k = allKinds(src).find((e) => e.label === 'hook')!;
    const input = renderInput({ ...k, scope: 'project', scopeRoot: root, sourceRoot: src.root });
    await expect(createTarget('claude', fakeEnv(root)).render(input)).rejects.toMatchObject({
      code: 'E_SOURCE',
    });
  });
});

describe('in-place local sources', () => {
  it('a hook runs from the source directory: nothing is copied, the command names it', async () => {
    const src = await makeSource();
    const root = path.dirname(src.root);
    const k = allKinds(src).find((e) => e.label === 'hook')!;
    const r = await createTarget('claude', fakeEnv(root)).render(
      renderInput(
        { ...k, scope: 'project', scopeRoot: root, sourceRoot: src.root },
        { inPlace: true, assetsRoot: path.basename(src.root) },
      ),
    );
    expect(r.files).toEqual([]);
    expect(r.exec[0]?.command).toContain(
      `"$CLAUDE_PROJECT_DIR/${path.basename(src.root)}/plugins/fmt/hooks/format.sh"`,
    );
  });
});

describe('entity names cannot escape their directory (security)', () => {
  it('render refuses traversal names', async () => {
    const src = await makeSource();
    const root = await tmpDir();
    const bad = mkEntity(
      { kind: 'skill', skill: { name: '../../victim', description: 'd' } },
      '../../victim',
    );
    const input = renderInput({
      entity: bad,
      absPath: src.skillDir,
      scope: 'project',
      scopeRoot: root,
      sourceRoot: src.root,
    });
    await expect(createTarget('claude', fakeEnv(root)).render(input)).rejects.toMatchObject({
      code: 'E_USAGE',
    });
  });
});

describe('skipped kinds', () => {
  it('a plugin renders nothing, with a note; OpenCode skips hooks', async () => {
    const root = await tmpDir();
    const src = await makeSource();
    const kinds = Object.fromEntries(allKinds(src).map((k) => [k.label, k]));
    const plugin = await install(createTarget('claude', fakeEnv(root)), {
      ...kinds.plugin!,
      scope: 'project',
      scopeRoot: root,
      sourceRoot: src.root,
    });
    expect(plugin.rendered).toMatchObject({ files: [], fragments: [], skipped: true });
    expect(plugin.result.files).toEqual([]);
    const hook = await createTarget('opencode', fakeEnv(root)).render(
      renderInput({ ...kinds.hook!, scope: 'project', scopeRoot: root, sourceRoot: src.root }),
    );
    expect(hook).toMatchObject({
      skipped: true,
      notes: ['OpenCode hooks are JS plugins; hook fmt not installed'],
    });
    expect(await exists(path.join(root, '.palm'))).toBe(false);
  });
});
