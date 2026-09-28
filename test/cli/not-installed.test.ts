import { afterEach, describe, expect, it } from 'vitest';
import { installEntities } from '../../src/engine/install.js';
import { makeWorld, type World } from '../engine/world.js';
import { removeDir } from '../support/sandbox.js';
import { runInProcess } from './helpers.js';

describe('get / audit with a name that is not installed (R8 L1)', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('palm get <kind> <name>: E_NOT_FOUND, exit 1, with the command that lists what is', async () => {
    w = await makeWorld();
    const at = { cwd: w.sb.project, env: w.sb.env };
    await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'wayfinder' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    const miss = await runInProcess(['get', 'skill', 'nope'], at);
    expect(miss.code).toBe(1);
    expect(miss.stderr).toContain('skill "nope" is not installed in this project');
    expect(miss.stderr).toContain('palm get skills');
    const json = await runInProcess(['get', 'skill', 'nope', '--json'], at);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ error: { code: 'E_NOT_FOUND' } });
    // an installed name, and a plain listing, still succeed
    expect((await runInProcess(['get', 'skill', 'wayfinder'], at)).code).toBe(0);
    expect((await runInProcess(['get', 'agents'], at)).code).toBe(0);
  });

  it('palm audit <kind> <name>: E_NOT_FOUND, exit 1, before anything is scanned', async () => {
    w = await makeWorld();
    const at = { cwd: w.sb.project, env: w.sb.env };
    await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'wayfinder' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    const miss = await runInProcess(['audit', 'skill', 'nope'], at);
    expect(miss.code).toBe(1);
    expect(miss.stderr).toContain('skill "nope" is not installed in this project or globally');
    expect(miss.stdout).not.toContain('scanned');
    const global = await runInProcess(['audit', 'skill', 'wayfinder', '-g'], at);
    expect(global.code).toBe(1);
    expect(global.stderr).toContain('is not installed globally');
    const hit = await runInProcess(['audit', 'skill', 'wayfinder'], at);
    expect(hit.code).toBe(0);
    expect(hit.stdout).toContain('scanned');
  });
});

describe('get targets -g hint (R8 M6)', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('names the global command (config set targets), not the project-only palm init', async () => {
    w = await makeWorld();
    const at = { cwd: w.sb.project, env: w.sb.env };
    const global = await runInProcess(['get', 'targets', '-g'], at);
    expect(global.stderr).toContain('no targets resolved');
    expect(global.stderr).toContain('palm config set targets claude,codex');
    expect(global.stderr).not.toContain('palm init');
    const project = await runInProcess(['get', 'targets'], at);
    expect(project.stderr).toContain('palm init --target claude,codex');
  });
});
