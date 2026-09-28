import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLock } from '../../src/core/lockfile.js';
import { loadManifest } from '../../src/core/manifest.js';
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
    const lock = await loadLock(join(w.sb.project, 'palm.lock.yaml'));
    expect(lock.entries.map((e) => e.name)).toEqual(['wayfinder']);
    const m = await loadManifest(join(w.sb.project, 'palm.yaml'));
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
    expect((await loadLock(join(w.sb.project, 'palm.lock.yaml'))).entries).toEqual([]);
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
    expect((await loadLock(join(w.sb.project, 'palm.lock.yaml'))).entries).toHaveLength(1);
  });
});
