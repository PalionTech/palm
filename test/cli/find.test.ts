import { afterEach, describe, expect, it } from 'vitest';
import { installEntities } from '../../src/engine/install.js';
import { makeWorld, type World } from '../engine/world.js';
import { removeDir } from '../support/sandbox.js';
import { runInProcess } from './helpers.js';

describe('palm find (CLI)', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('prints the owner; exit 1 when nothing wrote the path, 2 without a lockfile', async () => {
    w = await makeWorld();
    const at = { cwd: w.sb.project, env: w.sb.env };
    const none = await runInProcess(['find', '.claude/skill/wayfinder.txt'], at);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('no palm.lock.yaml to search');

    await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'wayfinder' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    const hit = await runInProcess(['find', '.claude/skill/wayfinder.txt'], at);
    expect(hit.code).toBe(0);
    expect(hit.stdout).toMatch(/scope\s+kind\s+name\s+origin\s+target\s+file/);
    expect(hit.stdout).toMatch(
      /project\s+skill\s+wayfinder\s+a\s+claude\s+\.claude\/skill\/wayfinder\.txt/,
    );

    const json = await runInProcess(['find', '.claude/skill/wayfinder.txt', '--json'], at);
    expect(JSON.parse(json.stdout).items[0]).toMatchObject({
      scope: 'project',
      match: 'file',
      entry: { name: 'wayfinder' },
    });

    const miss = await runInProcess(['find', 'README.md'], at);
    expect(miss.code).toBe(1);
    expect(miss.stderr).toContain('x no installed entity wrote README.md');
    expect(miss.stderr).toContain('palm describe');
    const global = await runInProcess(['find', '.claude/skill/wayfinder.txt', '-g'], at);
    expect(global.code).toBe(2); // -g searches only the global lockfile, which does not exist
  });
});
