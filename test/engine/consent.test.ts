import './fakes.js';

import { describe, expect, it } from 'vitest';
import type { ConsentRequest } from '../../src/core/types.js';
import { installFromSource } from '../../src/engine/install.js';
import { syncScope } from '../../src/engine/sync.js';
import { makeWorld, type World } from './world.js';

const KIT = {
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

async function kit(w: World): Promise<string> {
  return w.remote('superpowers', { 'v1.0.0': KIT });
}

describe('consent for executables', () => {
  it('asks for a new exec unit and records the trust in the lock', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true, consent: 'yes' });
    const url = await kit(w);
    const r = await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'session-start' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(r.failures).toEqual([]);
    expect(w.exec.requests).toHaveLength(1);
    const unit = w.exec.requests[0]?.units[0];
    expect(unit?.key).toBe('hook:session-start@superpowers');
    const entry = await w.entry('hook', 'session-start');
    expect(entry?.trust).toEqual([unit?.hash]);
    expect(entry?.exec?.hash).toBe(unit?.hash);
    expect(w.exists('.palm/assets/superpowers/session-start/hooks/session-start/run.sh')).toBe(
      true,
    );
  });

  it('replays a trusted unit without asking, on install and on a bare install', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true, consent: 'yes' });
    const url = await kit(w);
    await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'session-start' }] },
      { scope: 'project' },
      w.deps,
    );
    w.exec.requests.length = 0;
    const ci = w.context({}, undefined);
    await w.remove('.claude/settings.json');
    const r = await syncScope(ci, { scope: 'project' }, w.deps);
    expect(r.failures).toEqual([]);
    expect(r.outcomes.map((o) => o.status)).toEqual(['restored']);
    expect(w.exec.requests).toEqual([]);
  });

  it('never takes --yes as consent: without a terminal the unit is E_UNTRUSTED_EXEC and nothing is written', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: false });
    const url = await kit(w);
    const yes = w.context({ yes: true });
    await expect(
      installFromSource(
        yes,
        { source: url, names: [{ name: 'session-start' }, { name: 'brainstorming' }] },
        { scope: 'project' },
        w.deps,
      ),
    ).rejects.toMatchObject({ code: 'E_UNTRUSTED_EXEC' });
    expect(w.exec.requests).toHaveLength(1);
    expect(w.exists('.claude/skills/brainstorming/SKILL.md')).toBe(false);
    expect(await w.lockText()).toBeUndefined();
  });

  it('accepts a hash-pinned --allow-exec without a terminal', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: false });
    const url = await kit(w);
    const probe = await makeWorld({ targets: ['claude'], interactive: true });
    await probe.remote('superpowers', { 'v1.0.0': KIT });
    await installFromSource(
      probe.ctx,
      { source: url, names: [{ name: 'session-start' }] },
      { scope: 'project' },
      probe.deps,
    );
    const hash = (probe.exec.requests[0] as ConsentRequest).units[0]?.hash as string;
    const ctx = w.context({
      allowExec: [{ key: 'hook:session-start@superpowers', hash: hash.slice(0, 15) }],
    });
    const r = await installFromSource(
      ctx,
      { source: url, names: [{ name: 'session-start' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(r.failures).toEqual([]);
    expect((await w.entry('hook', 'session-start'))?.trust).toEqual([hash]);
  });

  it('records a declined plugin hook, installs the rest, and stays quiet on bare installs', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true, consent: 'no' });
    const url = await kit(w);
    const r = await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'superpowers' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(r.failures).toEqual([]);
    const hook = r.outcomes.find((o) => o.entry.name === 'session-start');
    expect(hook?.status).toBe('skipped');
    expect(hook?.notes.join('\n')).toContain('palm install superpowers hook:session-start');
    expect(w.exists('.claude/skills/brainstorming/SKILL.md')).toBe(true);
    expect(w.exists('.claude/settings.json')).toBe(false);
    expect(await w.entry('hook', 'session-start')).toMatchObject({
      declined: true,
      via: 'plugin:superpowers',
      files: [],
    });
    w.exec.requests.length = 0;
    const lock = await w.lockText();
    const again = await syncScope(w.ctx, { scope: 'project' }, w.deps);
    expect(again.failures).toEqual([]);
    expect(w.exec.requests).toEqual([]);
    expect(await w.lockText()).toBe(lock);
  });

  it('asks again for a declined hook named on the command line', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true, consent: 'no' });
    const url = await kit(w);
    await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'superpowers' }] },
      { scope: 'project' },
      w.deps,
    );
    w.exec.requests.length = 0;
    w.exec.script.answer = 'yes';
    await installFromSource(
      w.ctx,
      { source: url, names: [{ kind: 'hook', name: 'session-start' }] },
      { scope: 'project' },
      w.deps,
    );
    expect(w.exec.requests).toHaveLength(1);
    const entry = await w.entry('hook', 'session-start');
    expect(entry?.declined).toBeUndefined();
    expect(entry?.trust).toHaveLength(1);
  });
});
