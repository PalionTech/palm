import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { loadLock } from '../../src/core/lockfile.js';
import { loadManifest, saveManifest } from '../../src/core/manifest.js';
import { installEntities } from '../../src/engine/install.js';
import { resolveTargets } from '../../src/engine/resolve-targets.js';
import { uninstallEntities } from '../../src/engine/uninstall.js';
import { updateEntities } from '../../src/engine/update.js';
import { fakeUI, removeDir } from '../core/helpers.js';
import { makeWorld, type World } from './world.js';

const opts = { scope: 'project' as const, targets: ['claude' as const] };

describe('reference-counted dependencies (LockEntry.deps)', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));
  const lockOf = async () => loadLock(join(w.sb.project, 'palm.lock.yaml'));
  const entry = async (kind: string, name: string) => (await lockOf()).entries.find((e) => e.kind === kind && e.name === name);

  it('records what a plugin/agent declared in deps', async () => {
    w = await makeWorld({ origins: ['d'] });
    await installEntities(w.ctx, [{ kind: 'agent', spec: 'alpha' }], opts, w.deps);
    expect((await entry('agent', 'alpha'))?.deps).toEqual([
      { kind: 'skill', name: 'shared' },
      { kind: 'instruction', name: 'style' },
    ]);
    expect((await entry('skill', 'shared'))?.via).toBe('agent:alpha');
    expect((await entry('instruction', 'style'))?.via).toBe('agent:alpha');
    await installEntities(w.ctx, [{ kind: 'plugin', spec: 'bundle' }], opts, w.deps);
    expect((await entry('plugin', 'bundle'))?.deps).toEqual([{ kind: 'skill', name: 'shared' }]);
  });

  it('uninstalling agent A keeps a skill another remaining agent lists, re-parenting it', async () => {
    w = await makeWorld({ origins: ['d'] });
    await installEntities(w.ctx, [{ kind: 'agent', spec: 'alpha' }], opts, w.deps);
    await installEntities(w.ctx, [{ kind: 'agent', spec: 'beta' }], opts, w.deps);
    expect((await entry('skill', 'shared'))?.via).toBe('agent:alpha');

    const r = await uninstallEntities(w.ctx, [{ kind: 'agent', name: 'alpha' }], { scope: 'project' }, w.deps);
    expect(r.removed.map((e) => `${e.kind} ${e.name}`).sort()).toEqual(['agent alpha', 'instruction style']);
    expect(r.warnings).toContain('kept skill shared: still needed by agent beta');
    expect(existsSync(join(w.sb.project, '.claude/skill/shared.txt'))).toBe(true);
    expect((await entry('skill', 'shared'))?.via).toBe('agent:beta');

    const r2 = await uninstallEntities(w.ctx, [{ kind: 'agent', name: 'beta' }], { scope: 'project' }, w.deps);
    expect(r2.removed.map((e) => e.name).sort()).toEqual(['beta', 'shared']);
    expect((await lockOf()).entries).toEqual([]);
  });

  it('keeps a via dependency that the manifest lists directly (it becomes direct)', async () => {
    w = await makeWorld({ origins: ['d'] });
    await installEntities(w.ctx, [{ kind: 'agent', spec: 'alpha' }], opts, w.deps);
    const file = join(w.sb.project, 'palm.yaml');
    await saveManifest(file, { ...(await loadManifest(file)), skills: ['shared@d'] });
    await uninstallEntities(w.ctx, [{ kind: 'agent', name: 'alpha' }], { scope: 'project' }, w.deps);
    const shared = await entry('skill', 'shared');
    expect(shared).toBeDefined();
    expect(shared?.via).toBeUndefined();
    expect(await entry('instruction', 'style')).toBeUndefined();
  });

  it('a plugin member already installed through an agent survives the agent and moves to the plugin', async () => {
    w = await makeWorld({ origins: ['d'] });
    await installEntities(w.ctx, [{ kind: 'agent', spec: 'alpha' }], opts, w.deps);
    await installEntities(w.ctx, [{ kind: 'plugin', spec: 'bundle' }], opts, w.deps);
    await uninstallEntities(w.ctx, [{ kind: 'agent', name: 'alpha' }], { scope: 'project' }, w.deps);
    expect((await entry('skill', 'shared'))?.via).toBe('plugin:bundle');
    await uninstallEntities(w.ctx, [{ kind: 'plugin', name: 'bundle' }], { scope: 'project' }, w.deps);
    expect((await lockOf()).entries).toEqual([]);
    expect(existsSync(join(w.sb.project, '.claude/skill/shared.txt'))).toBe(false);
  });

  it('warns when a skill is removed directly while an agent still references it', async () => {
    w = await makeWorld({ origins: ['d'] });
    await installEntities(w.ctx, [{ kind: 'agent', spec: 'beta' }], opts, w.deps);
    const r = await uninstallEntities(w.ctx, [{ kind: 'skill', name: 'shared' }], { scope: 'project' }, w.deps);
    expect(r.removed.map((e) => e.name)).toEqual(['shared']);
    expect(r.warnings).toContain('agent beta still references skill shared');
  });
});

describe('agent dependency resolution', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('resolves skills from the agent’s own origin first, even when other origins have the name', async () => {
    w = await makeWorld({ origins: ['b', 'd'] }); // `shared` exists in b and d
    const r = await installEntities(w.ctx, [{ kind: 'agent', spec: 'alpha@d' }], opts, w.deps);
    expect(r.outcomes.find((o) => o.entry.name === 'shared')?.entry.origin).toBe('d');
  });

  it('falls back to all origins: E_AMBIGUOUS without a terminal, the picker with one', async () => {
    w = await makeWorld({ origins: ['a', 'b', 'd'], ui: fakeUI({ interactive: false }) }); // `wayfinder` only in a and b (different content)
    const err = await installEntities(w.ctx, [{ kind: 'agent', spec: 'picky' }], opts, w.deps).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'E_AMBIGUOUS' });
    expect((err as { hint: string }).hint).toContain('wayfinder@a');
    await removeDir(w.sb.root);

    w = await makeWorld({ origins: ['a', 'b', 'd'] });
    const r = await installEntities(w.ctx, [{ kind: 'agent', spec: 'picky' }], opts, w.deps);
    expect(w.ui.picks.map((p) => p.options.length)).toEqual([2]);
    expect(r.outcomes.find((o) => o.entry.name === 'wayfinder')?.entry.via).toBe('agent:picky');
  });

  it('a reinstall reuses the origin the dependency was installed from (no new ambiguity)', async () => {
    w = await makeWorld({ origins: ['a', 'd'] });
    await installEntities(w.ctx, [{ kind: 'agent', spec: 'picky' }], opts, w.deps);
    w.ctx.config.origins.push({ alias: 'b', type: 'local', path: w.origins.b });
    w.ctx.flags.force = true;
    const r = await installEntities(w.ctx, [{ kind: 'agent', spec: 'picky' }], opts, w.deps);
    expect(r.outcomes.find((o) => o.entry.name === 'wayfinder')?.entry.origin).toBe('a');
  });
});

describe('updateEntities dry run', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('lists an entity once when it is both direct and a plugin member', async () => {
    w = await makeWorld({ origins: ['d'] });
    await installEntities(w.ctx, [{ kind: 'skill', spec: 'shared' }], { scope: 'project', targets: ['claude'] }, w.deps);
    await installEntities(w.ctx, [{ kind: 'plugin', spec: 'bundle' }], { scope: 'project', targets: ['claude', 'codex'] }, w.deps);
    w.ctx.flags.dryRun = true;
    const r = await updateEntities(w.ctx, [], { scope: 'project' }, w.deps);
    const keys = r.outcomes.map((o) => `${o.entry.kind} ${o.entry.name} ${o.entry.origin}`);
    expect(keys.filter((k) => k === 'skill shared d')).toHaveLength(1);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('resolveTargets --target persistence', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('saves an explicit flag to palm.yaml (project) when it differs, and not under --dry-run', async () => {
    w = await makeWorld({ detect: ['claude', 'codex'] });
    const file = join(w.sb.project, 'palm.yaml');
    w.ctx.flags.dryRun = true;
    await resolveTargets(w.ctx, { scope: 'project', flag: ['cursor'], save: true }, w.deps);
    expect(existsSync(file)).toBe(false);
    w.ctx.flags.dryRun = false;
    expect(await resolveTargets(w.ctx, { scope: 'project', flag: ['cursor', 'claude'], save: true }, w.deps)).toEqual(['cursor', 'claude']);
    expect((await loadManifest(file)).targets).toEqual(['cursor', 'claude']);
    // Next run without a flag uses the saved targets instead of detection.
    expect(await resolveTargets(w.ctx, { scope: 'project', save: true }, w.deps)).toEqual(['cursor', 'claude']);
    // Without save the flag is used but not stored.
    await resolveTargets(w.ctx, { scope: 'project', flag: ['codex'] }, w.deps);
    expect((await loadManifest(file)).targets).toEqual(['cursor', 'claude']);
  });

  it('saves an explicit flag to config.yaml for the global scope', async () => {
    w = await makeWorld();
    await resolveTargets(w.ctx, { scope: 'global', flag: ['claude'], save: true }, w.deps);
    expect((await loadConfig(w.ctx.paths)).targets).toEqual(['claude']);
  });
});
