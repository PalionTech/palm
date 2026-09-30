import './fakes.js';

import { describe, expect, it } from 'vitest';
import type { Target, TargetId } from '../../src/core/types.js';
import { installFromSource, requestInstallStop } from '../../src/engine/install.js';
import { makeWorld } from './world.js';

const KIT = {
  'skills/a/SKILL.md': 'a\n',
  'skills/b/SKILL.md': 'b\n',
  'skills/c/SKILL.md': 'c\n',
};

const names = ['a', 'b', 'c'].map((name) => ({ name }));

describe('running an install', () => {
  it('reports partial when one target fails; the lock keeps what succeeded', async () => {
    const w = await makeWorld({ targets: ['claude', 'cursor'], failFor: ['cursor'] });
    const url = await w.remote('kit', { 'v1.0.0': KIT });
    const r = await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'a' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(r.outcomes[0]).toMatchObject({
      status: 'partial',
      perTarget: { claude: 'installed', cursor: 'failed' },
    });
    expect(r.failures[0]).toMatchObject({ target: 'cursor', code: 'E_TARGET' });
    const entry = await w.entry('skill', 'a');
    expect(Object.keys(entry?.render ?? {})).toEqual(['claude']);
    expect(entry?.files).toEqual(['.claude/skills/a/SKILL.md']);
  });

  it('writes nothing on --dry-run and still reports what it would do', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', { 'v1.0.0': KIT });
    const r = await installFromSource(
      w.context({ dryRun: true }),
      { source: url, names },
      { scope: 'project' },
      w.deps,
    );
    expect(r.outcomes.map((o) => o.status)).toEqual(['installed', 'installed', 'installed']);
    expect(w.exists('.claude/skills/a/SKILL.md')).toBe(false);
    expect(await w.manifestText()).toBe('targets: [claude]\n');
    expect(await w.lockText()).toBeUndefined();
  });

  it('stops after the current entity on SIGINT with the lock saved', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', { 'v1.0.0': KIT });
    const inner = w.deps.getTarget as (id: TargetId) => Target;
    const getTarget = (id: TargetId): Target => {
      const t = inner(id);
      return {
        ...t,
        apply: async (input) => {
          requestInstallStop();
          return t.apply(input);
        },
      };
    };
    await expect(
      installFromSource(
        w.ctx,
        { source: url, names },
        { scope: 'project' },
        { ...w.deps, getTarget },
      ),
    ).rejects.toMatchObject({ code: 'E_CANCELLED' });
    const lock = await w.lock();
    expect(lock.entries.map((e) => e.name)).toEqual(['a']);
    expect(await w.manifest()).toMatchObject({ sources: { kit: { skills: ['a'] } } });
  });

  it('refuses an entity with hidden Unicode and installs the rest', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', { 'v1.0.0': { ...KIT, 'skills/b/SKILL.md': 'b‮\n' } });
    const r = await installFromSource(w.ctx, { source: url, names }, { scope: 'project' }, w.deps);
    expect(r.outcomes.map((o) => [o.entry.name, o.status])).toEqual([
      ['a', 'installed'],
      ['b', 'failed'],
      ['c', 'installed'],
    ]);
    expect(r.failures[0]).toMatchObject({
      name: 'b',
      code: 'E_SOURCE',
      hint: expect.stringContaining('palm install kit b'),
    });
    expect(await w.manifest()).toMatchObject({ sources: { kit: { skills: ['a', 'c'] } } });
  });

  it('refuses to overwrite a file palm did not write, unless --force', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', { 'v1.0.0': KIT });
    await w.write('.claude/skills/a/SKILL.md', 'hand written\n');
    const r = await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'a' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(r.outcomes[0]?.status).toBe('failed');
    expect(r.failures[0]).toMatchObject({ code: 'E_CONFLICT', hint: 'palm install kit a --force' });
    expect(await w.read('.claude/skills/a/SKILL.md')).toBe('hand written\n');
    const forced = await installFromSource(
      w.context({ force: true }),
      { source: url, names: [{ name: 'a' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(forced.outcomes[0]?.status).toBe('installed');
    expect(await w.read('.claude/skills/a/SKILL.md')).toBe('a\n');
  });

  it('adopts an identical file silently', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', { 'v1.0.0': KIT });
    await w.write('.claude/skills/a/SKILL.md', 'a\n');
    const r = await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'a' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(r.failures).toEqual([]);
    expect(r.outcomes[0]?.status).toBe('installed');
  });
});
