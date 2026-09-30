import './fakes.js';

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Lock } from '../../src/domain/lock.js';
import { Manifest } from '../../src/domain/manifest.js';
import { installFromSource } from '../../src/engine/install.js';
import { syncScope } from '../../src/engine/sync.js';
import { fetchCalls } from './fakes.js';
import { makeWorld, type World, writeTree } from './world.js';

const SKILLS = {
  'skills/tdd/SKILL.md': 'Test first.\n',
  'skills/review/SKILL.md': 'Review carefully.\n',
};

async function mtime(file: string): Promise<number> {
  return (await stat(file)).mtimeMs;
}

async function installed(w: World, names: string[]): Promise<string> {
  const url = await w.remote('skills', { 'v1.0.0': SKILLS });
  const r = await installFromSource(
    w.ctx,
    { source: url, names: names.map((name) => ({ name })) },
    { scope: 'project' },
    w.deps,
  );
  expect(r.failures).toEqual([]);
  return url;
}

describe('syncScope (bare install)', () => {
  it('writes neither palm.yaml nor the lock on a clean clone with committed outputs', async () => {
    const w = await makeWorld({ targets: ['claude', 'cursor'] });
    await installed(w, ['tdd', 'review']);
    const manifest = await w.manifestText();
    const lock = await w.lockText();
    const times = [await mtime(w.path('palm.yaml')), await mtime(w.path('palm.lock.yaml'))];
    fetchCalls.length = 0;
    const r = await syncScope(w.ctx, { scope: 'project' }, w.deps);
    expect(r.failures).toEqual([]);
    expect(r.outcomes.map((o) => o.status)).toEqual(['unchanged', 'unchanged']);
    expect(await w.manifestText()).toBe(manifest);
    expect(await w.lockText()).toBe(lock);
    expect([await mtime(w.path('palm.yaml')), await mtime(w.path('palm.lock.yaml'))]).toEqual(
      times,
    );
    expect(fetchCalls.every((c) => c.sha)).toBe(true);
  });

  it('restores a missing generated file', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    await installed(w, ['tdd']);
    await w.remove('.claude/skills/tdd/SKILL.md');
    const r = await syncScope(w.ctx, { scope: 'project' }, w.deps);
    expect(r.outcomes.map((o) => o.status)).toEqual(['restored']);
    expect(await w.read('.claude/skills/tdd/SKILL.md')).toBe('Test first.\n');
  });

  it('keeps an edited file as modified (kept) and reports a failure', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    await installed(w, ['tdd']);
    await w.write('.claude/skills/tdd/SKILL.md', 'my edit\n');
    const r = await syncScope(w.ctx, { scope: 'project' }, w.deps);
    expect(r.outcomes.map((o) => o.status)).toEqual(['modified']);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({
      code: 'E_CONFLICT',
      hint: expect.stringContaining('--force'),
    });
    expect(await w.read('.claude/skills/tdd/SKILL.md')).toBe('my edit\n');
  });

  it('restores a missing file of an entity while keeping its edited one', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('skills', {
      'v1.0.0': { 'skills/tdd/SKILL.md': 'Test first.\n', 'skills/tdd/notes.md': 'notes\n' },
    });
    await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'tdd' }] },
      { scope: 'project' },
      w.deps,
    );
    await w.write('.claude/skills/tdd/SKILL.md', 'my edit\n');
    await w.remove('.claude/skills/tdd/notes.md');
    const r = await syncScope(w.ctx, { scope: 'project' }, w.deps);
    expect(r.outcomes.map((o) => o.status)).toEqual(['modified']);
    expect(await w.read('.claude/skills/tdd/notes.md')).toBe('notes\n');
    expect(await w.read('.claude/skills/tdd/SKILL.md')).toBe('my edit\n');
  });

  it('re-renders an in-repo source that changed and updates its tree hash', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const src = await w.local('agent-kit', { 'skills/review/SKILL.md': 'v1\n' });
    await installFromSource(
      w.ctx,
      { source: src, names: [{ name: 'review' }] },
      { scope: 'project' },
      w.deps,
    );
    const before = (await w.lock()).sources['./agent-kit']?.tree;
    await w.write('agent-kit/skills/review/SKILL.md', 'v2\n');
    const r = await syncScope(w.ctx, { scope: 'project' }, w.deps);
    expect(r.outcomes.map((o) => o.status)).toEqual(['updated']);
    expect(await w.read('.claude/skills/review/SKILL.md')).toBe('v2\n');
    const after = (await w.lock()).sources['./agent-kit']?.tree;
    expect(after).toMatch(/^sha256:/);
    expect(after).not.toBe(before);
  });

  it('undeploys an entry removed from palm.yaml by hand, keeping an edited file', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    await installed(w, ['tdd', 'review']);
    const m = await Manifest.load(w.path('palm.yaml'));
    await m.removeEntry('skills', 'skill', 'review').save(w.path('palm.yaml'));
    const r = await syncScope(w.ctx, { scope: 'project' }, w.deps);
    expect(r.outcomes.find((o) => o.entry.name === 'review')?.status).toBe('removed');
    expect(w.exists('.claude/skills/review/SKILL.md')).toBe(false);
    expect((await w.lock()).entries.map((e) => e.name)).toEqual(['tdd']);
  });

  it('resolves an edited pin fresh and renders the new version', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('skills', {
      'v1.0.0': SKILLS,
      'v2.0.0': { 'skills/tdd/SKILL.md': 'Test first, v2.\n' },
    });
    await installFromSource(
      w.ctx,
      { source: `${url}#v1.0.0`, names: [{ name: 'tdd' }] },
      { scope: 'project' },
      w.deps,
    );
    const m = await Manifest.load(w.path('palm.yaml'));
    const [name] = m.sourceNames();
    const src = m.sources(w.project, 'palm.yaml').byName(name as string);
    await m
      .addSource({ ...(src?.source ?? { name: '', type: 'git' }), ref: 'v2.0.0' }, w.project)
      .save(w.path('palm.yaml'));
    const r = await syncScope(w.ctx, { scope: 'project' }, w.deps);
    expect(r.outcomes.map((o) => o.status)).toEqual(['updated']);
    expect(await w.read('.claude/skills/tdd/SKILL.md')).toBe('Test first, v2.\n');
    expect((await w.lock()).sources[name as string]).toMatchObject({ ref: 'v2.0.0' });
  });
});

describe('syncScope under -g (applied.yaml)', () => {
  async function globalWorld(): Promise<{ w: World; kit: string }> {
    const w = await makeWorld({ detect: ['claude'] });
    await writeTree(join(w.palmHome, 'kit'), SKILLS);
    const r = await installFromSource(
      w.ctx,
      {
        source: join(w.palmHome, 'kit'),
        names: [{ name: 'tdd' }, { name: 'review' }],
      },
      { scope: 'global' },
      w.deps,
    );
    expect(r.failures).toEqual([]);
    return { w, kit: join(w.home, '.claude', 'skills') };
  }

  async function pullWithout(w: World, name: string): Promise<void> {
    const lockFile = join(w.palmHome, 'palm.lock.yaml');
    const manifestFile = join(w.palmHome, 'palm.yaml');
    const lock = await Lock.load(lockFile);
    await lock.remove({ kind: 'skill', name }).save(lockFile);
    const m = await Manifest.load(manifestFile);
    await m.removeEntry('./kit', 'skill', name).save(manifestFile);
  }

  it('deletes the files of an entry a pulled lock dropped', async () => {
    const { w, kit } = await globalWorld();
    await pullWithout(w, 'review');
    const r = await syncScope(w.ctx, { scope: 'global' }, w.deps);
    expect(r.failures).toEqual([]);
    expect(await stat(join(kit, 'review', 'SKILL.md')).catch(() => undefined)).toBeUndefined();
    expect(await stat(join(kit, 'tdd', 'SKILL.md'))).toBeDefined();
  });

  it('keeps a file of a dropped entry that was edited on this machine', async () => {
    const { w, kit } = await globalWorld();
    await writeTree(kit, { 'review/SKILL.md': 'edited here\n' });
    await pullWithout(w, 'review');
    const r = await syncScope(w.ctx, { scope: 'global' }, w.deps);
    expect(r.warnings.join('\n')).toContain('you changed it since palm wrote it');
    expect(await stat(join(kit, 'review', 'SKILL.md'))).toBeDefined();
  });
});
