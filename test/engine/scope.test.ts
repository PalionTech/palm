import './fakes.js';

import { describe, expect, it } from 'vitest';
import { installFromSource } from '../../src/engine/install.js';
import { openScope } from '../../src/engine/scope.js';
import { syncScope } from '../../src/engine/sync.js';
import { makeContext } from './fakes.js';
import { makeWorld } from './world.js';

describe('scope guards', () => {
  it('refuses a local source that overlaps an output directory (E_SOURCE, at declaration)', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    await w.local('.claude', { 'skills/kit/SKILL.md': 'x\n' });
    await expect(
      installFromSource(
        w.ctx,
        { source: './.claude', names: [{ name: 'kit' }] },
        { scope: 'project' },
        w.deps,
      ),
    ).rejects.toMatchObject({
      code: 'E_SOURCE',
      message: expect.stringContaining('overlaps the claude output directory .claude/'),
      hint: expect.stringContaining('./agent-kit'),
    });
    expect(await w.lockText()).toBeUndefined();
  });

  it('refuses a declared source inside an output directory on every command', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    await w.local('.claude/kit', { 'skills/x/SKILL.md': 'x\n' });
    await w.write('palm.yaml', 'targets: [claude]\nsources:\n  ./.claude/kit:\n    skills: [x]\n');
    await expect(syncScope(w.ctx, { scope: 'project' }, w.deps)).rejects.toMatchObject({
      code: 'E_SOURCE',
    });
    const state = await openScope(w.ctx, 'project', {
      deps: await import('../../src/engine/deps.js').then((m) => m.resolveEngineDeps(w.deps)),
      readOnly: true,
    });
    expect(state.sources.names()).toEqual(['./.claude/kit']);
  });

  it('refuses the home directory as a project without palm.yaml', async () => {
    const w = await makeWorld();
    const ctx = makeContext({ root: w.root, home: w.home, palmHome: w.palmHome, project: w.home });
    await expect(syncScope(ctx, { scope: 'project' }, w.deps)).rejects.toMatchObject({
      code: 'E_USAGE',
    });
  });

  it('reports palm.yaml in the 0.1 format with the migrate hint', async () => {
    const w = await makeWorld();
    await w.write('palm.yaml', 'targets: [claude]\nskills:\n  - tdd@mattpocock\n');
    await expect(syncScope(w.ctx, { scope: 'project' }, w.deps)).rejects.toMatchObject({
      code: 'E_USAGE',
      hint: expect.stringContaining('palm migrate'),
    });
  });

  it('refuses --local until 0.3', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    await expect(syncScope(w.ctx, { scope: 'project', local: true }, w.deps)).rejects.toMatchObject(
      { code: 'E_USAGE' },
    );
  });
});
