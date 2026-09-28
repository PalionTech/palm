import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Lock } from '../../src/domain/lock.js';
import { Manifest } from '../../src/domain/manifest.js';
import { installEntities } from '../../src/engine/install.js';
import { uninstallEntities } from '../../src/engine/uninstall.js';
import { removeDir } from '../support/sandbox.js';
import { makeWorld, type World } from './world.js';

describe('uninstallEntities', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));
  const opts = { scope: 'project' as const, targets: ['claude' as const, 'codex' as const] };

  it('removes files, lock entries, manifest entries and dependents', async () => {
    w = await makeWorld();
    await installEntities(
      w.ctx,
      [
        { kind: 'agent', spec: 'reviewer' },
        { kind: 'skill', spec: 'wayfinder' },
      ],
      opts,
      w.deps,
    );
    expect(existsSync(join(w.sb.project, '.claude/skill/tdd.txt'))).toBe(true);

    const r = await uninstallEntities(w.ctx, [{ name: 'reviewer' }], { scope: 'project' }, w.deps);
    expect(r.removed.map((e) => e.name).sort()).toEqual(['docs', 'reviewer', 'tdd']);
    expect(w.calls.undeploy.filter((c) => c.entry.name === 'reviewer').map((c) => c.id)).toEqual([
      'claude',
      'codex',
    ]);
    for (const f of [
      '.claude/agent/reviewer.txt',
      '.codex/skill/tdd.txt',
      '.claude/mcp/docs.txt',
    ]) {
      expect(existsSync(join(w.sb.project, f))).toBe(false);
    }
    expect(existsSync(join(w.sb.project, '.claude/skill/wayfinder.txt'))).toBe(true);
    const lock = await Lock.load(join(w.sb.project, 'palm.lock.yaml'));
    expect(lock.entries.map((e) => e.name)).toEqual(['wayfinder']);
    const m = (await Manifest.load(join(w.sb.project, 'palm.yaml'))).toJSON();
    expect(m.agents).toBeUndefined(); // emptied sections are dropped
    expect(m.skills).toEqual(['wayfinder@a']);
  });

  it('removes plugin members with the plugin', async () => {
    w = await makeWorld();
    await installEntities(w.ctx, [{ kind: 'plugin', spec: 'superpowers' }], opts, w.deps);
    const r = await uninstallEntities(
      w.ctx,
      [{ kind: 'plugin', name: 'superpowers' }],
      { scope: 'project' },
      w.deps,
    );
    expect(r.removed.map((e) => e.name).sort()).toEqual(['brainstorm', 'superpowers']);
    expect((await Lock.load(join(w.sb.project, 'palm.lock.yaml'))).entries).toEqual([]);
  });

  it('asks for a kind when the name is installed as several kinds', async () => {
    w = await makeWorld();
    await installEntities(
      w.ctx,
      [
        { kind: 'skill', spec: 'dual' },
        { kind: 'agent', spec: 'dual' },
      ],
      opts,
      w.deps,
    );
    const err = await uninstallEntities(
      w.ctx,
      [{ name: 'dual' }],
      { scope: 'project' },
      w.deps,
    ).catch((e) => e);
    expect(err).toMatchObject({ code: 'E_AMBIGUOUS' });
    expect(err.hint).toContain('palm uninstall skill dual');
    const r = await uninstallEntities(
      w.ctx,
      [{ kind: 'agent', name: 'dual' }],
      { scope: 'project' },
      w.deps,
    );
    expect(r.removed.map((e) => e.kind)).toEqual(['agent']);
  });

  it('errors for names that are not installed; dry run changes nothing', async () => {
    w = await makeWorld();
    await expect(
      uninstallEntities(w.ctx, [{ name: 'nothing' }], { scope: 'project' }, w.deps),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    await installEntities(w.ctx, [{ kind: 'skill', spec: 'tdd' }], opts, w.deps);
    w.ctx.flags.dryRun = true;
    const r = await uninstallEntities(w.ctx, [{ name: 'tdd' }], { scope: 'project' }, w.deps);
    expect(r.removed).toHaveLength(1);
    expect(existsSync(join(w.sb.project, '.claude/skill/tdd.txt'))).toBe(true);
    expect((await Lock.load(join(w.sb.project, 'palm.lock.yaml'))).entries).toHaveLength(1);
  });

  it('an entity with a file the user changed stays installed and locked (a failure); --force removes both (H4)', async () => {
    w = await makeWorld();
    await installEntities(w.ctx, [{ kind: 'skill', spec: 'wayfinder' }], opts, w.deps);
    const mine = join(w.sb.project, '.claude/skill/wayfinder.txt');
    const codex = join(w.sb.project, '.codex/skill/wayfinder.txt');
    await writeFile(mine, 'edited by hand\n');

    const r = await uninstallEntities(w.ctx, [{ name: 'wayfinder' }], { scope: 'project' }, w.deps);
    expect(r.removed).toEqual([]);
    expect(r.failures).toEqual([
      {
        kind: 'skill',
        name: 'wayfinder',
        origin: 'a',
        code: 'E_CONFLICT',
        message:
          '.claude/skill/wayfinder.txt was modified since install; rerun with --force to remove',
        hint: 'palm kept this skill installed; to remove it and your edits: palm uninstall skill wayfinder --force',
      },
    ]);
    expect(existsSync(mine)).toBe(true); // the edit survives
    expect(existsSync(codex)).toBe(true); // and so does the rest of the entity
    expect(w.calls.undeploy.filter((c) => c.entry.name === 'wayfinder')).toEqual([]);
    const lockFile = join(w.sb.project, 'palm.lock.yaml');
    expect((await Lock.load(lockFile)).find({ kind: 'skill', name: 'wayfinder' })).toBeDefined();
    expect(
      (await Manifest.load(join(w.sb.project, 'palm.yaml'))).hasDep('skill', 'wayfinder'),
    ).toBe(true);

    w.ctx.flags.force = true;
    const forced = await uninstallEntities(
      w.ctx,
      [{ name: 'wayfinder' }],
      { scope: 'project' },
      w.deps,
    );
    expect(forced.failures).toEqual([]);
    expect(forced.removed.map((e) => e.name)).toEqual(['wayfinder']);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(codex)).toBe(false);
    expect((await Lock.load(lockFile)).entries).toEqual([]);
  });

  it('an edited dependency stays (now direct) when its parent goes; the shared one is re-parented', async () => {
    w = await makeWorld({ origins: ['d'] });
    await installEntities(
      w.ctx,
      [
        { kind: 'agent', spec: 'alpha' },
        { kind: 'agent', spec: 'beta' },
      ],
      opts,
      w.deps,
    );
    await writeFile(join(w.sb.project, '.claude/instruction/style.txt'), 'house style, edited\n');
    const r = await uninstallEntities(
      w.ctx,
      [{ kind: 'agent', name: 'alpha' }],
      { scope: 'project' },
      w.deps,
    );
    expect(r.removed.map((e) => e.name)).toEqual(['alpha']);
    expect(r.failures.map((f) => [f.name, f.code])).toEqual([['style', 'E_CONFLICT']]);
    expect(existsSync(join(w.sb.project, '.claude/instruction/style.txt'))).toBe(true);
    expect(existsSync(join(w.sb.project, '.claude/skill/shared.txt'))).toBe(true);
    const lock = await Lock.load(join(w.sb.project, 'palm.lock.yaml'));
    expect(lock.find({ kind: 'skill', name: 'shared' })?.via).toBe('agent:beta');
    expect(lock.find({ kind: 'instruction', name: 'style' })?.via).toBeUndefined();
  });

  it('a named dependency another installed agent declares is re-parented, not removed (M1)', async () => {
    w = await makeWorld({ origins: ['d'] });
    await installEntities(w.ctx, [{ kind: 'agent', spec: 'beta' }], opts, w.deps);
    const r = await uninstallEntities(
      w.ctx,
      [{ kind: 'skill', name: 'shared' }],
      { scope: 'project' },
      w.deps,
    );
    expect(r.removed).toEqual([]);
    expect(r.warnings).toContain(
      'kept skill shared: still needed by agent beta (to remove both: palm uninstall agent beta)',
    );
    expect(existsSync(join(w.sb.project, '.claude/skill/shared.txt'))).toBe(true);
    const lock = await Lock.load(join(w.sb.project, 'palm.lock.yaml'));
    expect(lock.find({ kind: 'skill', name: 'shared' })?.via).toBe('agent:beta');

    // installed directly and declared by beta: it leaves palm.yaml and becomes beta's dependency
    await installEntities(w.ctx, [{ kind: 'skill', spec: 'shared@d' }], opts, w.deps);
    const manifest = join(w.sb.project, 'palm.yaml');
    expect((await Manifest.load(manifest)).hasDep('skill', 'shared')).toBe(true);
    await uninstallEntities(
      w.ctx,
      [{ kind: 'skill', name: 'shared' }],
      { scope: 'project' },
      w.deps,
    );
    expect((await Manifest.load(manifest)).hasDep('skill', 'shared')).toBe(false);
    const after = await Lock.load(join(w.sb.project, 'palm.lock.yaml'));
    expect(after.find({ kind: 'skill', name: 'shared' })?.via).toBe('agent:beta');
    expect(existsSync(join(w.sb.project, '.claude/skill/shared.txt'))).toBe(true);
  });

  it('harness dirs palm created go once empty; ones that were there stay (L10)', async () => {
    w = await makeWorld();
    await mkdir(join(w.sb.project, '.codex'), { recursive: true }); // the user's own
    await installEntities(w.ctx, [{ kind: 'skill', spec: 'wayfinder' }], opts, w.deps);
    await installEntities(w.ctx, [{ kind: 'skill', spec: 'tdd' }], opts, w.deps);
    const lockFile = join(w.sb.project, 'palm.lock.yaml');
    expect((await Lock.load(lockFile)).createdDirs).toEqual(['.claude']);
    await uninstallEntities(w.ctx, [{ name: 'wayfinder' }], { scope: 'project' }, w.deps);
    expect(existsSync(join(w.sb.project, '.claude'))).toBe(true); // tdd still lives there
    await uninstallEntities(w.ctx, [{ name: 'tdd' }], { scope: 'project' }, w.deps);
    expect(existsSync(join(w.sb.project, '.claude'))).toBe(false);
    expect(existsSync(join(w.sb.project, '.codex'))).toBe(true);
    expect((await Lock.load(lockFile)).createdDirs).toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)(
    'a file that cannot be removed is a failure; the entry stays in the lock with it',
    async () => {
      w = await makeWorld();
      await installEntities(w.ctx, [{ kind: 'skill', spec: 'wayfinder' }], opts, w.deps);
      const dir = join(w.sb.project, '.claude/skill');
      await chmod(dir, 0o555);
      try {
        const r = await uninstallEntities(
          w.ctx,
          [{ name: 'wayfinder' }],
          { scope: 'project' },
          w.deps,
        );
        expect(r.failures.length).toBeGreaterThan(0);
        expect(r.failures.map((f) => f.message).join('\n')).toMatch(/EACCES|permission denied/i);
        const left = (await Lock.load(join(w.sb.project, 'palm.lock.yaml'))).find({
          kind: 'skill',
          name: 'wayfinder',
        });
        expect(left?.files.map((f) => f.path)).toEqual(['.claude/skill/wayfinder.txt']);
        expect(existsSync(join(w.sb.project, '.codex/skill/wayfinder.txt'))).toBe(false);
        expect(
          (await Manifest.load(join(w.sb.project, 'palm.yaml'))).toJSON().skills,
        ).toBeUndefined();
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );
});
