import './fakes.js';

import { describe, expect, it } from 'vitest';
import { installFromSource, listSource } from '../../src/engine/install.js';
import { makeWorld } from './world.js';

const KIT = {
  'skills/review/SKILL.md': '---\nname: review\n---\nReview carefully.\n',
  'skills/tdd/SKILL.md': '---\nname: tdd\n---\nTest first.\n',
  'agents/reviewer.md': 'skills: tdd, ghost\nReviews code.\n',
};

describe('installFromSource', () => {
  it('installs named entities from a local source and records palm.yaml and the lock', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const src = await w.local('agent-kit', KIT);
    const r = await installFromSource(
      w.ctx,
      { source: src, names: [{ name: 'review' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(r.failures).toEqual([]);
    expect(r.outcomes.map((o) => [o.entry.name, o.status])).toEqual([['review', 'installed']]);
    expect(await w.read('.claude/skills/review/SKILL.md')).toContain('Review carefully.');
    const m = await w.manifest();
    expect(m).toMatchObject({
      targets: ['claude'],
      sources: { './agent-kit': { skills: ['review'] } },
    });
    const lock = await w.lock();
    expect(lock.sources['./agent-kit']).toMatchObject({
      path: 'agent-kit',
      descriptor: 'convention',
    });
    expect(lock.sources['./agent-kit']?.tree).toMatch(/^sha256:/);
    const entry = lock.entries.find((e) => e.name === 'review');
    expect(entry).toMatchObject({
      kind: 'skill',
      source: './agent-kit',
      path: 'skills/review',
      files: ['.claude/skills/review/SKILL.md'],
    });
    expect(entry?.render.claude).toMatch(/^sha256:/);
  });

  it('writes targets detected from the scope into palm.yaml on the first install that places something', async () => {
    const w = await makeWorld({ detect: ['claude', 'cursor'] });
    const src = await w.local('agent-kit', KIT);
    await installFromSource(
      w.ctx,
      { source: src, names: [{ name: 'tdd' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(await w.manifest()).toMatchObject({ targets: ['claude', 'cursor'] });
    expect(w.ctx.log.text()).toContain('targets: claude, cursor');
    expect(w.exists('.cursor/skills/tdd/SKILL.md')).toBe(true);
  });

  it('names what the source offers when a name matches nothing, and writes nothing', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const src = await w.local('agent-kit', KIT);
    await expect(
      installFromSource(
        w.ctx,
        { source: src, names: [{ name: 'tdx' }] },
        { scope: 'project' },
        w.deps,
      ),
    ).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
      hint: 'palm install ./agent-kit tdd',
    });
    expect(await w.manifestText()).toBe('targets: [claude]\n');
    expect(await w.lockText()).toBeUndefined();
  });

  it('prints one line for skills an agent mentions and installs only the agent', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const src = await w.local('agent-kit', KIT);
    const r = await installFromSource(
      w.ctx,
      { source: src, names: [{ name: 'reviewer' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(r.outcomes.map((o) => o.entry.name)).toEqual(['reviewer']);
    expect(w.ctx.log.text()).toContain('palm install ./agent-kit tdd ghost');
  });

  it('lists a source without saving anything', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('skills', { 'v1.0.0': KIT });
    const listed = await listSource(w.ctx, url, { scope: 'project' }, w.deps);
    expect(listed.declared).toBe(false);
    expect(listed.index.entities.map((e) => e.name).sort()).toEqual(['review', 'reviewer', 'tdd']);
    expect(await w.lockText()).toBeUndefined();
    expect(await w.manifestText()).toBe('targets: [claude]\n');
  });
});
