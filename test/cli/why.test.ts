import { afterEach, describe, expect, it } from 'vitest';
import { installEntities } from '../../src/engine/install.js';
import { makeWorld, type World } from '../engine/world.js';
import { removeDir } from '../support/sandbox.js';
import { runInProcess } from './helpers.js';

const opts = { scope: 'project' as const, targets: ['claude' as const] };

describe('palm why (CLI)', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('CLI: text, --json, and usage errors', async () => {
    w = await makeWorld({ origins: ['d'] });
    await installEntities(w.ctx, [{ kind: 'agent', spec: 'alpha' }], opts, w.deps);
    const at = { cwd: w.sb.project, env: w.sb.env };

    const text = await runInProcess(['why', 'skill', 'shared'], at);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('skill shared  (origin d, project scope)');
    expect(text.stdout).toMatch(/installed by\s+agent alpha/);
    expect(text.stdout).toMatch(/chain\s+skill shared ← agent alpha ← palm.yaml \(agents\)/);
    expect(text.stdout).toMatch(/needed by\s+agent alpha/);

    const json = await runInProcess(['why', 'sk', 'shared@d', '--json'], at);
    expect(json.code).toBe(0);
    const doc = JSON.parse(json.stdout);
    expect(doc.items[0]).toMatchObject({ entry: { name: 'shared' }, listedIn: 'agents' });

    const bad = await runInProcess(['why', 'widget', 'x'], at);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('"widget" is not an entity kind');
    const missing = await runInProcess(['why', 'skill', 'nope'], at);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('palm get skills');
  });
});
