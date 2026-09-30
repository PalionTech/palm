import './fakes.js';

import { describe, expect, it } from 'vitest';
import type { Entity, SourceIndex } from '../../src/core/types.js';
import { installFromSource } from '../../src/engine/install.js';
import { closestName, matchNames } from '../../src/engine/match.js';
import { makeWorld } from './world.js';

function skill(name: string, plugin?: string): Entity {
  return {
    kind: 'skill',
    name,
    path: `skills/${name}`,
    source: 's',
    def: { kind: 'skill', skill: { name, description: name } },
    ...(plugin ? { plugin } : {}),
  };
}

const INDEX: SourceIndex = {
  source: 's',
  sourceId: 's',
  root: '/s',
  warnings: [],
  detected: 'convention',
  entities: [
    skill('tdd'),
    skill('review'),
    {
      kind: 'agent',
      name: 'review',
      path: 'agents/review.md',
      source: 's',
      def: { kind: 'agent', agent: { name: 'review', description: 'r', body: '' } },
    },
    skill('brainstorming', 'superpowers'),
    {
      kind: 'plugin',
      name: 'superpowers',
      path: 'plugins/superpowers.json',
      source: 's',
      def: { kind: 'plugin', members: [{ kind: 'skill', name: 'brainstorming' }] },
    },
  ],
};

describe('matchNames', () => {
  it('matches names in any case and asks for kind: only when one name means two kinds', () => {
    const m = matchNames(
      INDEX,
      [{ name: 'TDD' }, { name: 'review' }, { kind: 'agent', name: 'review' }],
      false,
    );
    expect(m.entities.map((e) => `${e.kind}:${e.name}`)).toEqual(['skill:tdd', 'agent:review']);
    expect(m.ambiguous).toEqual([{ name: 'review' }]);
  });

  it('expands a plugin to its members and takes everything with --all', () => {
    expect(
      matchNames(INDEX, [{ name: 'superpowers' }], false).plugins[0]?.members.map((e) => e.name),
    ).toEqual(['brainstorming']);
    const all = matchNames(INDEX, [], true);
    expect(all.plugins.map((p) => p.plugin.name)).toEqual(['superpowers']);
    expect(all.entities.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'skill:tdd',
      'skill:review',
      'agent:review',
    ]);
  });

  it('suggests the closest name', () => {
    expect(matchNames(INDEX, [{ name: 'tdx' }], false).missing).toEqual([{ name: 'tdx' }]);
    expect(closestName(INDEX, { name: 'tdx' })).toBe('tdd');
    expect(closestName(INDEX, { name: 'zzzzzzzz' })).toBeUndefined();
  });
});

describe('declaring a source', () => {
  it('writes the latest release as a range and says so', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', {
      'v1.0.2': { 'skills/tdd/SKILL.md': 'x\n' },
      'v0.9.0': { 'skills/tdd/SKILL.md': 'y\n' },
    });
    await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'tdd' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(await w.manifest()).toMatchObject({
      sources: { kit: { url, ref: '^1.0', skills: ['tdd'] } },
    });
    expect(w.ctx.log.text()).toContain('ref ^1.0 saved to palm.yaml (latest tag v1.0.2)');
    expect((await w.lock()).sources.kit).toMatchObject({ ref: '^1.0', resolved: 'v1.0.2' });
  });

  it('writes the default branch explicitly when there is no tag', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', { main: { 'skills/tdd/SKILL.md': 'x\n' } });
    await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'tdd' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(await w.manifest()).toMatchObject({ sources: { kit: { ref: 'main' } } });
    expect(w.ctx.log.text()).toContain('ref main saved to palm.yaml; edit ref: to pin a tag');
  });

  it('asks before moving the ref of a declared source, and --yes confirms', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', {
      'v1.0.0': { 'skills/tdd/SKILL.md': 'x\n' },
      main: { 'skills/tdd/SKILL.md': 'y\n' },
    });
    await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'tdd' }] },
      { scope: 'project' },
      w.deps,
    );
    await expect(
      installFromSource(
        w.ctx,
        { source: `${url}#main`, names: [{ name: 'tdd' }] },
        { scope: 'project' },
        w.deps,
      ),
    ).rejects.toMatchObject({ code: 'E_NON_INTERACTIVE', retryWith: '--yes' });
    const r = await installFromSource(
      w.context({ yes: true }),
      { source: `${url}#main`, names: [{ name: 'tdd' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(r.outcomes[0]?.status).toBe('updated');
    expect(await w.manifest()).toMatchObject({ sources: { kit: { ref: 'main' } } });
    expect(await w.read('.claude/skills/tdd/SKILL.md')).toBe('y\n');
  });

  it('keeps installing from the locked sha while the ref is unchanged', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', {
      'v1.0.0': { 'skills/tdd/SKILL.md': 'x\n', 'skills/review/SKILL.md': 'r1\n' },
    });
    await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'tdd' }] },
      { scope: 'project' },
      w.deps,
    );
    const sha = (await w.lock()).sources.kit?.sha;
    await w.remote('kit', {
      'v1.0.0': { 'skills/tdd/SKILL.md': 'x\n', 'skills/review/SKILL.md': 'r1\n' },
      'v1.1.0': { 'skills/tdd/SKILL.md': 'x2\n', 'skills/review/SKILL.md': 'r2\n' },
    });
    await installFromSource(
      w.ctx,
      { source: 'kit', names: [{ name: 'review' }] },
      { scope: 'project' },
      w.deps,
    );
    expect((await w.lock()).sources.kit?.sha).toBe(sha);
    expect(await w.read('.claude/skills/review/SKILL.md')).toBe('r1\n');
  });
});
