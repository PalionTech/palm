/**
 * What an entity install saves besides the lock: `targets:` only once something was placed
 * (never after an ambiguity or another failure that ends the run), and a `--from` origin
 * registered with `--save-origin` where `palm install origin` would put it.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { LockEntry } from '../../src/core/types.js';
import { makeWorld, type World } from '../engine/world.js';
import { fakeUI } from '../support/fakes.js';
import { removeDir } from '../support/sandbox.js';
import { runInProcess } from './helpers.js';

describe('palm install: what it saves', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  async function world(origins: string[]): Promise<World> {
    w = await makeWorld({ detect: ['claude'] });
    const lines = origins.map(
      (k) => `  - { alias: ${k}, type: local, path: ${w.origins[k as 'a']} }`,
    );
    await mkdir(w.sb.palmHome, { recursive: true });
    await writeFile(join(w.sb.palmHome, 'config.yaml'), ['origins:', ...lines, ''].join('\n'));
    return w;
  }
  const palm = (args: string[], interactive = false) =>
    runInProcess(args, {
      cwd: w.sb.project,
      env: w.sb.env,
      deps: w.deps,
      ui: fakeUI({ interactive }),
    });
  const manifest = () => join(w.sb.project, 'palm.yaml');

  it('an ambiguous name saves no targets; the first install that places something does', async () => {
    await world(['a', 'b']);
    const ambiguous = await palm(['install', 'skill', 'wayfinder']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain('wayfinder@a');
    expect(existsSync(manifest())).toBe(false);

    const ok = await palm(['install', 'skill', 'wayfinder@a']);
    expect(ok.code).toBe(0);
    // saved after the install wrote palm.yaml: still first, in flow style
    expect(await readFile(manifest(), 'utf8')).toMatch(/^targets: \[claude\]\nskills:/);
    expect(parse(await readFile(manifest(), 'utf8'))).toMatchObject({
      targets: ['claude'],
      skills: ['wayfinder@a'],
    });
  });

  it('--save-origin registers the --from origin in config.yaml, or palm.yaml with --project', async () => {
    await world([]);
    const r = await palm(['install', 'skill', 'shared', '--from', w.origins.b, '--save-origin']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const config = parse(await readFile(join(w.sb.palmHome, 'config.yaml'), 'utf8'));
    expect(config.origins).toEqual([expect.objectContaining({ alias: 'b', path: w.origins.b })]);
    expect(parse(await readFile(manifest(), 'utf8')).origins).toBeUndefined();

    // the fake scanner keys origins by directory name: keep `b`
    await cp(w.origins.b, join(w.sb.project, 'vendor/b'), { recursive: true });
    const project = await palm([
      'install',
      'skill',
      'wayfinder',
      '--from',
      './vendor/b',
      '--save-origin',
      '--project',
    ]);
    expect(project.stderr).toBe('');
    expect(project.code).toBe(0);
    expect(parse(await readFile(manifest(), 'utf8')).origins).toEqual([
      expect.objectContaining({ type: 'local', path: 'vendor/b' }),
    ]);
  });
});

describe('palm install --target on one entity (H1)', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  const palm = (args: string[]) =>
    runInProcess(args, { cwd: w.sb.project, env: w.sb.env, deps: w.deps, ui: fakeUI() });
  const at = (p: string) => join(w.sb.project, p);
  const lockTargets = async () =>
    Object.fromEntries(
      (parse(await readFile(at('palm.lock.yaml'), 'utf8')).entries as LockEntry[]).map((e) => [
        e.name,
        e.targets,
      ]),
    );

  async function twoEntities(): Promise<void> {
    w = await makeWorld();
    w.deps.getTarget = (await import('../../src/targets/index.js')).getTarget;
    await mkdir(w.sb.palmHome, { recursive: true });
    await writeFile(
      join(w.sb.palmHome, 'config.yaml'),
      `origins:\n  - { alias: a, type: local, path: ${w.origins.a} }\n`,
    );
    expect((await palm(['install', 'skill', 'wayfinder@a', '--target', 'claude,codex'])).code).toBe(
      0,
    );
    expect((await palm(['install', 'skill', 'tdd@a'])).code).toBe(0);
    expect(await lockTargets()).toEqual({
      tdd: ['claude', 'codex'],
      wayfinder: ['claude', 'codex'],
    });
  }

  it('narrowing --target keeps palm.yaml targets and every other entry; --frozen still passes', async () => {
    await twoEntities();
    const before = await readFile(at('palm.yaml'), 'utf8');
    const r = await palm(['install', 'skill', 'tdd@a', '--target', 'claude']);
    expect(r.code).toBe(0);
    expect(r.stderr + r.stdout).not.toContain('saved targets');
    expect(r.stderr + r.stdout).toContain('--target applied to this install only');
    expect(await readFile(at('palm.yaml'), 'utf8')).toBe(before);
    expect(parse(await readFile(at('palm.lock.yaml'), 'utf8')).targets).toEqual([
      'claude',
      'codex',
    ]);

    const sync = await palm(['install']);
    expect(sync.code).toBe(0);
    expect(sync.stdout + sync.stderr).not.toContain('removed from');
    expect(existsSync(at('.agents/skills/wayfinder/SKILL.md'))).toBe(true);
    expect(existsSync(at('.agents/skills/tdd/SKILL.md'))).toBe(true);
    expect(await lockTargets()).toEqual({
      tdd: ['claude', 'codex'],
      wayfinder: ['claude', 'codex'],
    });
    expect((await palm(['install', '--frozen'])).code).toBe(0);
  });

  it('an extending --target stays on that entry through bare installs; only a shrunk palm.yaml contracts', async () => {
    await twoEntities();
    expect((await palm(['install', 'skill', 'tdd@a', '--target', 'cursor'])).code).toBe(0);
    expect((await palm(['install'])).code).toBe(0);
    expect(await lockTargets()).toEqual({
      tdd: ['claude', 'codex', 'cursor'],
      wayfinder: ['claude', 'codex'],
    });
    expect((await palm(['install', '--frozen'])).code).toBe(0);

    // the persisted set shrinks (palm init --target): the next bare install contracts codex
    expect((await palm(['init', '--target', 'claude'])).code).toBe(0);
    const frozen = await palm(['install', '--frozen']);
    expect(frozen.code).toBe(1);
    expect(frozen.stderr).toContain(
      'skill wayfinder@a: locked for claude, codex, palm.yaml dropped codex',
    );
    const sync = await palm(['install']);
    expect(sync.code).toBe(0);
    expect(sync.stdout).toContain('removed from codex');
    expect(await lockTargets()).toEqual({ tdd: ['claude', 'cursor'], wayfinder: ['claude'] });
    expect(existsSync(at('.agents/skills/wayfinder'))).toBe(false);
    expect(existsSync(at('.agents/skills/tdd/SKILL.md'))).toBe(true); // cursor still reads it
    expect(parse(await readFile(at('palm.lock.yaml'), 'utf8')).targets).toEqual(['claude']);
    expect((await palm(['install', '--frozen'])).code).toBe(0);
  });
});
