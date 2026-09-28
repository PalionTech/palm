/**
 * An entity whose file the user edited is never half-uninstalled (H4): the uninstall keeps it
 * installed and locked, exits 1 and names the `--force` command, which then removes it all.
 * A reinstall over the edit follows the install's edit-safe rule; each failure prints once.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { makeWorld, type World } from '../engine/world.js';
import { fakeUI } from '../support/fakes.js';
import { removeDir } from '../support/sandbox.js';
import { runInProcess } from './helpers.js';

describe('palm uninstall of an edited entity', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  const palm = (args: string[]) =>
    runInProcess(args, { cwd: w.sb.project, env: w.sb.env, deps: w.deps, ui: fakeUI() });
  const at = (p: string) => join(w.sb.project, p);
  const locked = async () =>
    (parse(await readFile(at('palm.lock.yaml'), 'utf8')).entries as Array<{ name: string }>).map(
      (e) => e.name,
    );

  it('edit → uninstall keeps entry and file (exit 1, --force hint) → uninstall --force removes both', async () => {
    w = await makeWorld();
    await mkdir(w.sb.palmHome, { recursive: true });
    await writeFile(
      join(w.sb.palmHome, 'config.yaml'),
      `origins:\n  - { alias: a, type: local, path: ${w.origins.a} }\n`,
    );
    expect((await palm(['install', 'skill', 'wayfinder@a', '--target', 'claude'])).code).toBe(0);
    await writeFile(at('.claude/skill/wayfinder.txt'), 'my notes\n');

    const refused = await palm(['uninstall', 'skill', 'wayfinder']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      'skill wayfinder@a: .claude/skill/wayfinder.txt was modified since install; rerun with --force to remove',
    );
    expect(refused.stderr).toContain('palm uninstall skill wayfinder --force');
    expect(refused.stderr.split('modified since install').length - 1).toBe(1);
    expect(await locked()).toEqual(['wayfinder']);
    expect(await readFile(at('.claude/skill/wayfinder.txt'), 'utf8')).toBe('my notes\n');

    // a reinstall over the edit is refused once, with its own --force command
    const reinstall = await palm(['install', 'skill', 'wayfinder@a', '--target', 'claude,codex']);
    expect(reinstall.code).toBe(1);
    const all = reinstall.stdout + reinstall.stderr;
    expect(all.split('changed since palm installed it').length - 1).toBe(1);
    expect(all).toContain('palm install skill wayfinder@a --force');

    const forced = await palm(['uninstall', 'skill', 'wayfinder', '--force']);
    expect(forced.code).toBe(0);
    expect(await locked()).toEqual([]);
    expect(existsSync(at('.claude/skill/wayfinder.txt'))).toBe(false);
  });
});
