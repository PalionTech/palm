import './fakes.js';

import { describe, expect, it } from 'vitest';
import { installFromSource } from '../../src/engine/install.js';
import { syncScope } from '../../src/engine/sync.js';
import { applyUpdate, planChanges, planUpdate, reviewText } from '../../src/engine/update.js';
import { makeWorld, type World } from './world.js';

const HOOK = (script: string) => ({
  'hooks/guard/hooks.json': JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/guard/run.sh' }] }],
    },
  }),
  'hooks/guard/run.sh': { text: script, mode: 0o755 },
});

async function world(): Promise<{ w: World; name: string }> {
  const w = await makeWorld({ targets: ['claude'], interactive: true });
  const url = await w.remote('kit', {
    'v1.0.0': { 'skills/tdd/SKILL.md': 'one\n', ...HOOK('echo one\n') },
    'v1.1.0': { 'skills/tdd/SKILL.md': 'one point one\n', ...HOOK('echo one point one\n') },
    'v2.0.0': { 'skills/tdd/SKILL.md': 'two\n', ...HOOK('echo two\n') },
  });
  await installFromSource(
    w.ctx,
    { source: `${url}#^1.0`, names: [{ name: 'tdd' }, { name: 'guard' }] },
    { scope: 'project' },
    w.deps,
  );
  return { w, name: 'kit' };
}

describe('update', () => {
  it('moves the sha within the range and leaves the intent in palm.yaml', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true });
    const V1 = { 'skills/tdd/SKILL.md': 'one\n', ...HOOK('echo one\n') };
    const url = await w.remote('kit', { 'v1.0.0': V1 });
    await installFromSource(
      w.ctx,
      { source: `${url}#^1.0`, names: [{ name: 'tdd' }, { name: 'guard' }] },
      { scope: 'project' },
      w.deps,
    );
    const before = (await w.lock()).sources.kit;
    expect(before).toMatchObject({ ref: '^1.0', resolved: 'v1.0.0' });
    await w.remote('kit', {
      'v1.0.0': V1,
      'v1.1.0': { 'skills/tdd/SKILL.md': 'one point one\n', ...HOOK('echo one point one\n') },
      'v2.0.0': { 'skills/tdd/SKILL.md': 'two\n', ...HOOK('echo two\n') },
    });
    const manifest = await w.manifestText();
    const plan = await planUpdate(w.ctx, [], { scope: 'project' }, w.deps);
    expect(plan.sources).toEqual([
      {
        name: 'kit',
        ref: '^1.0',
        from: expect.stringContaining('v1.0.0'),
        to: expect.stringContaining('v1.1.0'),
      },
    ]);
    expect(plan.items.find((i) => i.name === 'tdd')?.mark).toBe('updated');
    expect(planChanges(plan)).toBe(1);
    expect((await w.lock()).sources.kit).toEqual(before);
    w.exec.requests.length = 0;
    const r = await applyUpdate(w.ctx, plan, { scope: 'project' }, w.deps);
    expect(r.failures).toEqual([]);
    expect(await w.manifestText()).toBe(manifest);
    const after = (await w.lock()).sources.kit;
    expect(after).toMatchObject({ ref: '^1.0', resolved: 'v1.1.0' });
    expect(after?.sha).not.toBe(before?.sha);
    expect(await w.read('.claude/skills/tdd/SKILL.md')).toBe('one point one\n');
    expect(w.exec.requests).toHaveLength(1);
    const again = await planUpdate(w.ctx, [], { scope: 'project' }, w.deps);
    expect(planChanges(again)).toBe(0);
  });

  it('plans nothing when the locked sha is the newest in the range, and --dry-run writes nothing', async () => {
    const { w } = await world();
    const lock = await w.lockText();
    const plan = await planUpdate(w.context({ dryRun: true }), [], { scope: 'project' }, w.deps);
    expect(planChanges(plan)).toBe(0);
    expect(plan.items.every((i) => i.mark === 'unchanged')).toBe(true);
    expect(await w.lockText()).toBe(lock);
  });

  it('--to moves the ref in palm.yaml and the sha to the new version', async () => {
    const { w, name } = await world();
    const plan = await planUpdate(w.ctx, [name], { scope: 'project', to: '^2.0' }, w.deps);
    expect(plan.items.find((i) => i.name === 'tdd')).toMatchObject({
      mark: 'updated',
      to: expect.stringContaining('v2.0.0'),
    });
    const guard = plan.items.find((i) => i.name === 'guard');
    expect(guard?.exec?.unit.key).toBe(`hook:guard@${name}`);
    expect(guard?.exec?.previous).toBeDefined();
    expect(await reviewText(w.ctx, plan, w.deps as never)).toContain('echo two');
    const r = await applyUpdate(w.ctx, plan, { scope: 'project', to: '^2.0' }, w.deps);
    expect(r.failures).toEqual([]);
    expect(await w.manifest()).toMatchObject({ sources: { [name]: { ref: '^2.0' } } });
    expect((await w.lock()).sources[name]).toMatchObject({ ref: '^2.0', resolved: 'v2.0.0' });
    expect(await w.read('.claude/skills/tdd/SKILL.md')).toBe('two\n');
    expect(w.exec.requests.at(-1)?.units.map((u) => u.key)).toEqual([`hook:guard@${name}`]);
    expect(w.exec.requests.at(-1)?.previous?.[`hook:guard@${name}`]).toBeDefined();
  });

  it('keeps a file the person edited unless --force, and lists it as at risk', async () => {
    const { w, name } = await world();
    const locked = (await w.entry('skill', 'tdd'))?.render.claude;
    await w.write('.claude/skills/tdd/SKILL.md', 'my notes\n');
    const plan = await planUpdate(w.ctx, [name], { scope: 'project', to: '^2.0' }, w.deps);
    expect(plan.items.find((i) => i.name === 'tdd')?.atRisk).toEqual([
      '.claude/skills/tdd/SKILL.md',
    ]);
    const r = await applyUpdate(w.ctx, plan, { scope: 'project', to: '^2.0' }, w.deps);
    expect(r.outcomes.find((o) => o.entry.name === 'tdd')?.status).toBe('modified');
    expect(await w.read('.claude/skills/tdd/SKILL.md')).toBe('my notes\n');
    expect((await w.entry('skill', 'tdd'))?.render.claude).not.toBe(locked);
    const again = await syncScope(w.ctx, { scope: 'project' }, w.deps);
    expect(again.outcomes.find((o) => o.entry.name === 'tdd')?.status).toBe('modified');
    const forced = await syncScope(w.context({ force: true }), { scope: 'project' }, w.deps);
    expect(forced.outcomes.find((o) => o.entry.name === 'tdd')?.status).toBe('restored');
    expect(await w.read('.claude/skills/tdd/SKILL.md')).toBe('two\n');
  });
});
