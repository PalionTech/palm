import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enclosingProject, isHomeAsProject, resolvePaths } from '../../src/core/paths.js';
import { removeDir, tempDir } from '../support/sandbox.js';

describe('resolvePaths', () => {
  let root: string;
  beforeEach(async () => {
    root = await tempDir();
  });
  afterEach(async () => removeDir(root));

  it('takes the nearest palm.yaml inside the repository', async () => {
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    await mkdir(join(root, 'repo', 'pkg', 'src'), { recursive: true });
    await writeFile(join(root, 'repo', 'pkg', 'palm.yaml'), 'targets: [claude]\n');
    const p = resolvePaths(join(root, 'repo', 'pkg', 'src'), { HOME: join(root, 'home') });
    expect(p.projectRoot).toBe(join(root, 'repo', 'pkg'));
  });

  it('stops at the nearest .git: a palm.yaml above it belongs to another repository', async () => {
    await mkdir(join(root, 'a', 'b', 'c'), { recursive: true });
    await writeFile(join(root, 'a', 'palm.yaml'), 'targets: [claude]\n');
    await mkdir(join(root, 'a', 'b', '.git'));
    const p = resolvePaths(join(root, 'a', 'b', 'c'), { HOME: join(root, 'home') });
    expect(p.projectRoot).toBe(join(root, 'a', 'b'));
  });

  it('falls back to the nearest .git ancestor', async () => {
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    await mkdir(join(root, 'repo', 'src', 'deep'), { recursive: true });
    const p = resolvePaths(join(root, 'repo', 'src', 'deep'), { HOME: join(root, 'home') });
    expect(p.projectRoot).toBe(join(root, 'repo'));
  });

  it('falls back to cwd', async () => {
    await mkdir(join(root, 'plain'), { recursive: true });
    const p = resolvePaths(join(root, 'plain'), { HOME: join(root, 'home') });
    expect(p.projectRoot).toBe(join(root, 'plain'));
    expect(p.cwd).toBe(join(root, 'plain'));
  });

  it('never treats PALM_HOME (global manifest) as a project root', async () => {
    const palmHome = join(root, 'ph');
    await mkdir(join(palmHome, 'mine'), { recursive: true });
    await writeFile(join(palmHome, 'palm.yaml'), 'targets: [claude]\n');
    const p = resolvePaths(join(palmHome, 'mine'), {
      HOME: join(root, 'home'),
      PALM_HOME: palmHome,
    });
    expect(p.projectRoot).toBe(join(palmHome, 'mine'));
  });

  it('derives palmHome from PALM_HOME (home-relative, ~ expanded) or HOME', () => {
    expect(resolvePaths(root, { HOME: '/h', PALM_HOME: '/p' }).palmHome).toBe('/p');
    expect(resolvePaths(root, { HOME: '/h', PALM_HOME: '~/p' }).palmHome).toBe('/h/p');
    expect(resolvePaths(root, { HOME: '/h', PALM_HOME: 'p' }).palmHome).toBe('/h/p');
    const p = resolvePaths(root, { HOME: '/h' });
    expect(p.palmHome).toBe('/h/.palm');
    expect(p.home).toBe('/h');
  });
});

describe('isHomeAsProject', () => {
  let root: string;
  beforeEach(async () => {
    root = await tempDir();
  });
  afterEach(async () => removeDir(root));

  it('is true when the project root falls back to home, and false everywhere else', async () => {
    const home = join(root, 'home');
    const env = { HOME: home };
    await mkdir(join(home, 'notes'), { recursive: true });
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    expect(isHomeAsProject(resolvePaths(home, env), env)).toBe(true);
    expect(isHomeAsProject(resolvePaths(join(home, 'notes'), env), env)).toBe(false);
    expect(isHomeAsProject(resolvePaths(join(root, 'repo'), env), env)).toBe(false);
  });

  it('a dotfiles .git in home is no marker; a palm.yaml there is', async () => {
    const home = join(root, 'home');
    const env = { HOME: home };
    await mkdir(join(home, '.git'), { recursive: true });
    await mkdir(join(home, 'notes'), { recursive: true });
    expect(isHomeAsProject(resolvePaths(join(home, 'notes'), env), env)).toBe(true);
    await writeFile(join(home, 'palm.yaml'), 'targets: [claude]\n');
    expect(isHomeAsProject(resolvePaths(join(home, 'notes'), env), env)).toBe(false);
  });
});

describe('enclosingProject', () => {
  let root: string;
  beforeEach(async () => {
    root = await tempDir();
  });
  afterEach(async () => removeDir(root));

  it('finds a palm.yaml strictly above cwd, up to the repository root', async () => {
    const pkg = join(root, 'repo', 'packages', 'jobs');
    await mkdir(pkg, { recursive: true });
    expect(enclosingProject(pkg, join(root, 'repo'))).toBeUndefined();
    await writeFile(join(root, 'repo', 'palm.yaml'), 'targets: [claude]\n');
    expect(enclosingProject(pkg, join(root, 'repo'))).toBe(join(root, 'repo'));
    expect(enclosingProject(join(root, 'repo'), join(root, 'repo'))).toBeUndefined();
    await writeFile(join(pkg, 'palm.yaml'), 'targets: [claude]\n');
    expect(enclosingProject(pkg, join(root, 'repo'))).toBe(join(root, 'repo'));
    expect(enclosingProject(root, join(root, 'repo'))).toBeUndefined();
  });

  it('never looks above the repository root', async () => {
    await mkdir(join(root, 'repo', 'sub'), { recursive: true });
    await writeFile(join(root, 'palm.yaml'), 'targets: [claude]\n');
    expect(enclosingProject(join(root, 'repo', 'sub'), join(root, 'repo'))).toBeUndefined();
  });
});
