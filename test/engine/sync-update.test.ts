import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Lock } from '../../src/domain/lock.js';
import { Manifest } from '../../src/domain/manifest.js';
import { installEntities } from '../../src/engine/install.js';
import { syncManifest } from '../../src/engine/sync.js';
import { updateEntities } from '../../src/engine/update.js';
import { removeDir } from '../support/sandbox.js';
import { makeWorld, ORIGIN_ENTITIES, type World } from './world.js';

describe('syncManifest', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('installs missing entries, keeps present ones, reports and prunes extraneous', async () => {
    w = await makeWorld();
    const opts = { scope: 'project' as const, targets: ['claude' as const] };
    await installEntities(
      w.ctx,
      [
        { kind: 'skill', spec: 'wayfinder' },
        { kind: 'skill', spec: 'dual' },
      ],
      opts,
      w.deps,
    );
    await Manifest.of({
      targets: ['claude'],
      skills: ['wayfinder@a', 'tdd@a'],
      mcp: [
        'io.github.acme/weather',
        { name: 'fs', transport: 'stdio', command: 'npx', args: ['server-fs'] },
      ],
    }).save(join(w.sb.project, 'palm.yaml'));
    const deploysBefore = w.calls.deploy.length;

    const r = await syncManifest(w.ctx, { scope: 'project', prune: false }, w.deps);
    const status = Object.fromEntries(r.outcomes.map((o) => [o.entry.name, o.status]));
    expect(status).toEqual({
      wayfinder: 'unchanged',
      tdd: 'installed',
      weather: 'installed',
      fs: 'installed',
    });
    expect(w.calls.deploy.length - deploysBefore).toBe(3);
    expect(r.extraneous.map((e) => e.name)).toEqual(['dual']);

    // second sync: everything present, no deploys, no registry lookups
    const registryBefore = w.registryCalls.length;
    const again = await syncManifest(w.ctx, { scope: 'project', prune: true }, w.deps);
    expect(again.outcomes.every((o) => o.status === 'unchanged')).toBe(true);
    expect(w.registryCalls.length).toBe(registryBefore);
    expect(again.extraneous.map((e) => e.name)).toEqual(['dual']);
    const lock = await Lock.load(join(w.sb.project, 'palm.lock.yaml'));
    expect(lock.entries.map((e) => e.name).sort()).toEqual(['fs', 'tdd', 'wayfinder', 'weather']);
    expect(existsSync(join(w.sb.project, '.claude/skill/dual.txt'))).toBe(false);
  });

  it('reinstalls an ad hoc MCP entry whose definition changed', async () => {
    w = await makeWorld();
    const file = join(w.sb.project, 'palm.yaml');
    await Manifest.of({
      targets: ['claude'],
      mcp: [{ name: 'fs', command: 'npx', args: ['a'] }],
    }).save(file);
    await syncManifest(w.ctx, { scope: 'project', prune: false }, w.deps);
    await Manifest.of({
      targets: ['claude'],
      mcp: [{ name: 'fs', command: 'npx', args: ['b'] }],
    }).save(file);
    const r = await syncManifest(w.ctx, { scope: 'project', prune: false }, w.deps);
    expect(r.outcomes[0]!.status).toBe('updated');
  });
});

describe('updateEntities', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('reinstalls entries whose content changed and refreshes plugin members', async () => {
    w = await makeWorld();
    const opts = { scope: 'project' as const, targets: ['claude' as const] };
    await installEntities(
      w.ctx,
      [
        { kind: 'skill', spec: 'wayfinder' },
        { kind: 'plugin', spec: 'superpowers' },
      ],
      opts,
      w.deps,
    );
    await writeFile(
      join(w.origins.a, 'plugins/superpowers/skills/brainstorm/SKILL.md'),
      'brainstorm v2\n',
    );

    const r = await updateEntities(w.ctx, [], { scope: 'project' }, w.deps);
    const status = Object.fromEntries(r.outcomes.map((o) => [o.entry.name, o.status]));
    expect(status).toEqual({
      wayfinder: 'unchanged',
      superpowers: 'updated',
      brainstorm: 'updated',
    });
    const lock = await Lock.load(join(w.sb.project, 'palm.lock.yaml'));
    expect(lock.entries.find((e) => e.name === 'brainstorm')!.via).toBe('plugin:superpowers');

    // naming a member updates it through its plugin
    const r2 = await updateEntities(
      w.ctx,
      [{ kind: 'skill', name: 'brainstorm' }],
      { scope: 'project' },
      w.deps,
    );
    expect(r2.outcomes.map((o) => o.entry.name)).toEqual(['superpowers', 'brainstorm']);
    await expect(
      updateEntities(w.ctx, [{ name: 'nope' }], { scope: 'project' }, w.deps),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('climbs to the plugin whatever the case of the `via` (regression: parentOf was case-sensitive)', async () => {
    w = await makeWorld();
    const opts = { scope: 'project' as const, targets: ['claude' as const] };
    await installEntities(w.ctx, [{ kind: 'plugin', spec: 'superpowers' }], opts, w.deps);
    const lockFile = join(w.sb.project, 'palm.lock.yaml');
    const lock = await Lock.load(lockFile);
    const member = lock.entries.find((e) => e.name === 'brainstorm')!;
    member.via = 'plugin:SuperPowers';
    await lock.save(lockFile);

    const r = await updateEntities(
      w.ctx,
      [{ kind: 'skill', name: 'BRAINSTORM' }],
      { scope: 'project' },
      w.deps,
    );
    expect(r.outcomes.map((o) => o.entry.name)).toEqual(['superpowers', 'brainstorm']);
    // plan first: nothing changed, so nothing is reinstalled and the lock is not rewritten
    expect(r.outcomes.every((o) => o.status === 'unchanged')).toBe(true);
    const after = await Lock.load(lockFile);
    expect(after.entries.find((e) => e.name === 'brainstorm')!.via).toBe('plugin:SuperPowers');
  });

  it('drops members a plugin no longer declares, but keeps unresolved agent deps', async () => {
    w = await makeWorld();
    const opts = { scope: 'project' as const, targets: ['claude' as const] };
    await installEntities(
      w.ctx,
      [
        { kind: 'plugin', spec: 'superpowers' },
        { kind: 'agent', spec: 'reviewer' },
      ],
      opts,
      w.deps,
    );
    const original = ORIGIN_ENTITIES.a!;
    try {
      ORIGIN_ENTITIES.a = original
        .map((e) =>
          e.def.kind === 'plugin' ? { ...e, def: { kind: 'plugin' as const, members: [] } } : e,
        )
        .filter((e) => e.name !== 'tdd'); // tdd vanishes from the index, reviewer still declares it
      const r = await updateEntities(w.ctx, [], { scope: 'project' }, w.deps);
      expect(r.warnings.some((m) => m.includes('removed skill brainstorm'))).toBe(true);
      expect(r.warnings.some((m) => m.includes('"tdd"'))).toBe(true);
    } finally {
      ORIGIN_ENTITIES.a = original;
    }
    const names = (await Lock.load(join(w.sb.project, 'palm.lock.yaml'))).entries
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(['docs', 'reviewer', 'superpowers', 'tdd']);
    expect(existsSync(join(w.sb.project, '.claude/skill/brainstorm.txt'))).toBe(false);
  });
});

describe('bare palm install repairs deleted files', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('redeploys a direct entry and a plugin member whose files were removed by hand', async () => {
    w = await makeWorld({ origins: ['d'] });
    const opts = { scope: 'project' as const, targets: ['claude' as const] };
    await installEntities(
      w.ctx,
      [
        { kind: 'skill', spec: 'shared' },
        { kind: 'agent', spec: 'alpha' },
      ],
      opts,
      w.deps,
    );
    const unchanged = await syncManifest(
      w.ctx,
      { scope: 'project', prune: false, targets: ['claude'] },
      w.deps,
    );
    expect(unchanged.outcomes.every((o) => o.status === 'unchanged')).toBe(true);

    await rm(join(w.sb.project, '.claude/skill/shared.txt'));
    await rm(join(w.sb.project, '.claude/instruction/style.txt')); // pulled in by agent alpha
    const r = await syncManifest(
      w.ctx,
      { scope: 'project', prune: false, targets: ['claude'] },
      w.deps,
    );
    const byName = Object.fromEntries(r.outcomes.map((o) => [o.entry.name, o]));
    expect(byName.shared?.status).toBe('updated');
    expect(byName.shared?.notes).toContain('restored missing files');
    expect(byName.style?.status).toBe('updated');
    expect(existsSync(join(w.sb.project, '.claude/skill/shared.txt'))).toBe(true);
    expect(existsSync(join(w.sb.project, '.claude/instruction/style.txt'))).toBe(true);
  });
});
