import { afterEach, describe, expect, it } from 'vitest';
import { installEntities } from '../../src/engine/install.js';
import { whyInstalled } from '../../src/engine/why.js';
import { removeDir } from '../support/sandbox.js';
import { makeWorld, type World } from './world.js';

const opts = { scope: 'project' as const, targets: ['claude' as const] };
const project = { scope: 'project' as const };

describe('palm why', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('an agent dependency: the chain up to palm.yaml, and every entry that still needs it', async () => {
    w = await makeWorld({ origins: ['d'] });
    await installEntities(
      w.ctx,
      [
        { kind: 'agent', spec: 'alpha' },
        { kind: 'agent', spec: 'beta' },
        { kind: 'plugin', spec: 'bundle' },
      ],
      opts,
      w.deps,
    );
    const [shared] = await whyInstalled(w.ctx, { kind: 'skill', name: 'shared' }, project);
    expect(shared).toMatchObject({
      scope: 'project',
      entry: { kind: 'skill', name: 'shared', origin: 'd' },
      direct: false,
      listedIn: 'agents',
      chain: [
        { kind: 'skill', name: 'shared' },
        { kind: 'agent', name: 'alpha' },
      ],
    });
    expect(shared!.neededBy.map((n) => `${n.kind} ${n.name}`).sort()).toEqual([
      'agent alpha',
      'agent beta',
      'plugin bundle',
    ]);

    const [style] = await whyInstalled(w.ctx, { kind: 'instruction', name: 'STYLE' }, project);
    expect(style!.chain.map((n) => n.name)).toEqual(['style', 'alpha']);
    expect(style!.neededBy.map((n) => n.name)).toEqual(['alpha']);

    const [alpha] = await whyInstalled(w.ctx, { kind: 'agent', name: 'alpha' }, project);
    expect(alpha).toMatchObject({ direct: true, listedIn: 'agents', neededBy: [] });
    expect(alpha!.chain).toHaveLength(1);
  });

  it('a plugin member: installed by the plugin, which palm.yaml lists', async () => {
    w = await makeWorld();
    await installEntities(w.ctx, [{ kind: 'plugin', spec: 'superpowers' }], opts, w.deps);
    const [member] = await whyInstalled(w.ctx, { kind: 'skill', name: 'brainstorm' }, project);
    expect(member).toMatchObject({
      direct: false,
      listedIn: 'plugins',
      chain: [
        { kind: 'skill', name: 'brainstorm', origin: 'a' },
        { kind: 'plugin', name: 'superpowers', origin: 'a' },
      ],
      neededBy: [{ kind: 'plugin', name: 'superpowers', origin: 'a' }],
    });
  });

  it('not installed: E_NOT_FOUND naming the command that lists what is', async () => {
    w = await makeWorld();
    const err = await whyInstalled(w.ctx, { kind: 'skill', name: 'nope' }, project).catch((e) => e);
    expect(err).toMatchObject({ code: 'E_NOT_FOUND' });
    expect(err.message).toBe('skill "nope" is not installed in this project');
    expect(err.hint).toContain('palm get skills');
  });
});
