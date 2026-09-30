/**
 * Engine behaviour settled at integration (CONTRACT-AMENDMENTS rulings): `--all` leaves programs
 * out (15), a re-declared location under a new name renames the source (22), a local source
 * outside the project is E_SOURCE (9), and palm never writes inside a declared source (11).
 */
import './fakes.js';

import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installFromSource } from '../../src/engine/install.js';
import { syncScope } from '../../src/engine/sync.js';
import { makeWorld } from './world.js';

const PLUGIN = {
  'skills/brainstorming/SKILL.md': 'Think first.\n',
  'hooks/session-start/hooks.json': JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/session-start/run.sh' }],
        },
      ],
    },
  }),
  'hooks/session-start/run.sh': { text: 'echo hi\n', mode: 0o755 },
  'plugins/superpowers.json': JSON.stringify({
    members: ['skill:brainstorming', 'hook:session-start'],
  }),
};

describe('install <source> --all', () => {
  it('leaves programs out without asking; a plugin member left out is excluded on the plugin (ruling 15, D28)', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true, consent: 'yes' });
    const url = await w.remote('superpowers', { 'v1.0.0': PLUGIN });
    const r = await installFromSource(
      w.ctx,
      { source: url, names: [], all: true },
      { scope: 'project' },
      w.deps,
    );
    expect(r.failures).toEqual([]);
    expect(w.exec.requests).toEqual([]);
    expect(r.outcomes.find((o) => o.entry.name === 'session-start')?.status).toBe('skipped');
    expect(await w.entry('hook', 'session-start')).toBeUndefined();
    expect(w.exists('.claude/skills/brainstorming/SKILL.md')).toBe(true);
    expect(w.exists('.claude/settings.json')).toBe(false);
    const again = await syncScope(w.ctx, { scope: 'project' }, w.deps);
    expect(again.failures).toEqual([]);
    expect(w.exec.requests).toEqual([]);
  });

  it('still installs a program --allow-exec names', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: false, consent: 'yes' });
    const url = await w.remote('superpowers', { 'v1.0.0': PLUGIN });
    const probe = await makeWorld({ targets: ['claude'], interactive: true, consent: 'yes' });
    const probeUrl = await probe.remote('superpowers', { 'v1.0.0': PLUGIN });
    await installFromSource(
      probe.ctx,
      { source: probeUrl, names: [{ name: 'session-start' }] },
      { scope: 'project' },
      probe.deps,
    );
    const hash = (await probe.entry('hook', 'session-start'))?.exec?.hash ?? '';
    const ctx = w.context({
      allowExec: [{ key: 'hook:session-start@superpowers', hash }],
    });
    const r = await installFromSource(
      ctx,
      { source: url, names: [], all: true },
      { scope: 'project' },
      w.deps,
    );
    expect(r.failures).toEqual([]);
    expect(await w.entry('hook', 'session-start')).toMatchObject({ trust: [hash] });
  });
});

describe('declaring sources', () => {
  it('renames a declared location given a new --as name, entries included (ruling 22)', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', { 'v1.0.0': PLUGIN });
    await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'brainstorming' }] },
      { scope: 'project' },
      w.deps,
    );
    await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'brainstorming' }], as: 'team-kit' },
      { scope: 'project' },
      w.deps,
    );
    expect(await w.manifest()).toMatchObject({
      sources: { 'team-kit': { skills: ['brainstorming'] } },
    });
    const lock = await w.lock();
    expect(Object.keys(lock.sources)).toEqual(['team-kit']);
    expect(lock.entries.map((e) => e.source)).toEqual(['team-kit']);
    expect(w.ctx.log.text()).toContain('source kit → team-kit (renamed)');
  });

  it('refuses a declared local source outside the project (ruling 9)', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    await w.write('palm.yaml', 'targets: [claude]\nsources:\n  ../outside:\n    skills: [x]\n');
    await expect(syncScope(w.ctx, { scope: 'project' }, w.deps)).rejects.toMatchObject({
      code: 'E_SOURCE',
    });
  });

  it('never writes inside a declared source, even through a link (ruling 11)', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const src = await w.local('agent-kit', { 'skills/review/SKILL.md': 'Review.\n' });
    await mkdir(w.path('.claude/skills'), { recursive: true });
    await symlink(w.path('agent-kit/skills/review'), join(w.path('.claude/skills'), 'review'));
    const r = await installFromSource(
      w.ctx,
      { source: src, names: [{ name: 'review' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(r.failures.map((f) => f.code)).toEqual(['E_SOURCE']);
    expect(await w.read('agent-kit/skills/review/SKILL.md')).toBe('Review.\n');
  });
});
