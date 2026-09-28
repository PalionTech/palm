/**
 * One rule for "is the home directory a project?" (core/paths isHomeAsProject): only a palm.yaml
 * makes it one; a dotfiles `.git` there does not. install refuses the project scope, find and
 * audit search only the global scope.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Lock } from '../../src/domain/lock.js';
import { makeWorld, type World } from '../engine/world.js';
import { fakeUI } from '../support/fakes.js';
import { removeDir } from '../support/sandbox.js';
import { runInProcess } from './helpers.js';

describe('the home directory with a dotfiles .git is not a project', () => {
  let w: World;
  beforeEach(async () => {
    w = await makeWorld();
    await mkdir(join(w.sb.home, '.git'), { recursive: true });
    await mkdir(w.sb.palmHome, { recursive: true });
    await writeFile(
      join(w.sb.palmHome, 'config.yaml'),
      `origins:\n  - { alias: a, type: local, path: ${w.origins.a} }\n`,
    );
    // a lock in home that only a home *project* would read
    await writeFile(join(w.sb.home, 'notes.md'), 'mine\n');
    await new Lock([
      {
        kind: 'skill',
        name: 'tdd',
        origin: 'a',
        path: 'skills/tdd',
        contentHash: 'sha256:x',
        transform: 1,
        targets: ['claude'],
        files: [{ path: 'notes.md', hash: '' }],
      },
    ]).save(join(w.sb.home, 'palm.lock.yaml'));
  });
  afterEach(async () => removeDir(w.sb.root));

  const palm = (args: string[]) =>
    runInProcess(args, { cwd: w.sb.home, env: w.sb.env, deps: w.deps, ui: fakeUI() });

  it('install refuses, find and audit read the global scope only; a palm.yaml changes all three', async () => {
    const install = await palm(['install', 'skill', 'tdd', '--target', 'claude']);
    expect(install.code).toBe(2);
    expect(install.stderr).toContain('run inside a project or use -g');
    // no harness in home and no --target: still the scope error, before any target or origin work (M10)
    for (const args of [['install', 'skill', 'tdd'], ['install'], ['install', 'skill', 'nope']]) {
      const r = await runInProcess(args, {
        cwd: w.sb.home,
        env: w.sb.env,
        deps: w.deps,
        ui: fakeUI({ interactive: false }),
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('run inside a project or use -g');
      expect(r.stderr).not.toContain('No coding harness detected');
    }
    const find = await palm(['find', 'notes.md']);
    expect(find.code).not.toBe(0);
    expect(find.stderr).not.toContain('project');
    const audit = await palm(['audit', '--json']);
    expect(JSON.parse(audit.stdout).scanned).toBe(0);

    await writeFile(join(w.sb.home, 'palm.yaml'), 'targets: [claude]\n');
    expect((await palm(['find', 'notes.md'])).code).toBe(0);
    expect(JSON.parse((await palm(['audit', '--json'])).stdout).scanned).toBe(1);
    expect((await palm(['install', 'skill', 'wayfinder'])).code).toBe(0);
  });
});
