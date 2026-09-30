import './fakes.js';

import { describe, expect, it } from 'vitest';
import { installFromSource } from '../../src/engine/install.js';
import { removeEntities } from '../../src/engine/remove.js';
import { makeWorld, type World } from './world.js';

const KIT = {
  'skills/tdd/SKILL.md': 'Test first.\n',
  'skills/brainstorming/SKILL.md': 'Think first.\n',
  'skills/review/SKILL.md': 'Review.\n',
  'plugins/superpowers.json': JSON.stringify({ members: ['skill:brainstorming', 'skill:review'] }),
};

async function world(names: string[]): Promise<World> {
  const w = await makeWorld({ targets: ['claude'] });
  const url = await w.remote('kit', { 'v1.0.0': KIT });
  const r = await installFromSource(
    w.ctx,
    { source: url, names: names.map((name) => ({ name })) },
    { scope: 'project' },
    w.deps,
  );
  expect(r.failures).toEqual([]);
  return w;
}

describe('removeEntities', () => {
  it('removes exactly the lock files and drops the entry and the emptied source', async () => {
    const w = await world(['tdd']);
    const r = await removeEntities(w.ctx, [{ name: 'tdd' }], { scope: 'project' }, w.deps);
    expect(r.failures).toEqual([]);
    expect(r.removed.map((e) => e.name)).toEqual(['tdd']);
    expect(w.exists('.claude/skills/tdd/SKILL.md')).toBe(false);
    expect(await w.manifest()).toEqual({ targets: ['claude'] });
    expect(await w.lock()).toMatchObject({ sources: {}, entries: [] });
  });

  it('says an absent name is not installed and succeeds', async () => {
    const w = await world(['tdd']);
    const r = await removeEntities(w.ctx, [{ name: 'nothing' }], { scope: 'project' }, w.deps);
    expect(r).toMatchObject({ removed: [], failures: [] });
    expect(w.ctx.log.text()).toContain('nothing is not installed');
  });

  it('keeps an entity whose file the person changed, unless --force', async () => {
    const w = await world(['tdd']);
    await w.write('.claude/skills/tdd/SKILL.md', 'mine now\n');
    const r = await removeEntities(w.ctx, [{ name: 'tdd' }], { scope: 'project' }, w.deps);
    expect(r.removed).toEqual([]);
    expect(r.failures[0]).toMatchObject({
      code: 'E_CONFLICT',
      hint: 'palm remove kit tdd --force',
    });
    expect(r.failures[0]?.message).toContain(
      '.claude/skills/tdd/SKILL.md was modified since install',
    );
    expect(await w.entry('skill', 'tdd')).toBeDefined();
    const forced = await removeEntities(
      w.context({ force: true }),
      [{ name: 'tdd' }],
      { scope: 'project' },
      w.deps,
    );
    expect(forced.removed.map((e) => e.name)).toEqual(['tdd']);
    expect(w.exists('.claude/skills/tdd/SKILL.md')).toBe(false);
  });

  it('asks for --exclude before removing a plugin member, then records it in the plugin entry', async () => {
    const w = await world(['superpowers']);
    const r = await removeEntities(
      w.ctx,
      [{ name: 'brainstorming' }],
      { scope: 'project' },
      w.deps,
    );
    expect(r.removed).toEqual([]);
    expect(r.failures[0]).toMatchObject({ hint: 'palm remove kit brainstorming --exclude' });
    const ex = await removeEntities(
      w.ctx,
      [{ name: 'brainstorming' }],
      { scope: 'project', exclude: true },
      w.deps,
    );
    expect(ex.removed.map((e) => e.name)).toEqual(['brainstorming']);
    expect(await w.manifest()).toMatchObject({
      sources: { kit: { plugins: [{ name: 'superpowers', exclude: ['skill:brainstorming'] }] } },
    });
    expect(w.exists('.claude/skills/brainstorming/SKILL.md')).toBe(false);
    expect(w.exists('.claude/skills/review/SKILL.md')).toBe(true);
  });

  it('removes a plugin with its members', async () => {
    const w = await world(['superpowers']);
    const r = await removeEntities(
      w.ctx,
      [{ kind: 'plugin', name: 'superpowers' }],
      { scope: 'project' },
      w.deps,
    );
    expect(r.removed.map((e) => e.name).sort()).toEqual(['brainstorming', 'review', 'superpowers']);
    expect(w.exists('.claude/skills/review/SKILL.md')).toBe(false);
    expect((await w.lock()).entries).toEqual([]);
  });

  it('keeps a plugin and all its members when one member was edited', async () => {
    const w = await world(['superpowers']);
    await w.write('.claude/skills/review/SKILL.md', 'mine\n');
    const r = await removeEntities(
      w.ctx,
      [{ kind: 'plugin', name: 'superpowers' }],
      { scope: 'project' },
      w.deps,
    );
    expect(r.removed).toEqual([]);
    expect(r.failures.map((f) => f.name)).toEqual(['review']);
    expect(w.exists('.claude/skills/brainstorming/SKILL.md')).toBe(true);
    expect((await w.lock()).entries).toHaveLength(3);
  });

  it('keeps a member another plugin still declares and names the command that removes both', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', {
      'v1.0.0': { ...KIT, 'plugins/writing.json': JSON.stringify({ members: ['skill:review'] }) },
    });
    await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'superpowers' }, { name: 'writing' }] },
      { scope: 'project' },
      w.deps,
    );
    const r = await removeEntities(
      w.ctx,
      [{ kind: 'plugin', name: 'superpowers' }],
      { scope: 'project' },
      w.deps,
    );
    expect(r.removed.map((e) => e.name).sort()).toEqual(['brainstorming', 'superpowers']);
    expect(r.warnings.join('\n')).toContain('palm remove kit superpowers writing');
    expect(await w.entry('skill', 'review')).toMatchObject({ via: 'plugin:writing' });
    expect(w.exists('.claude/skills/review/SKILL.md')).toBe(true);
  });

  it('asks for the source when a name is installed from two sources', async () => {
    const w = await world(['tdd']);
    const src = await w.local('agent-kit', { 'skills/tdd/SKILL.md': 'other\n' });
    await installFromSource(
      w.context({ force: true }),
      { source: src, names: [{ name: 'tdd' }] },
      { scope: 'project' },
      w.deps,
    );
    await expect(
      removeEntities(w.ctx, [{ name: 'tdd' }], { scope: 'project' }, w.deps),
    ).rejects.toMatchObject({
      code: 'E_AMBIGUOUS',
      hint: expect.stringMatching(/^palm remove (kit|\.\/agent-kit) tdd$/),
    });
  });
});
