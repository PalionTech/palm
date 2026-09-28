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
