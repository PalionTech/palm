import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hooksAssetDir,
  lockPath,
  manifestPath,
  resolvePaths,
  scopeRoot,
} from '../../src/core/paths.js';
import { removeDir, tempDir } from '../support/sandbox.js';

describe('resolvePaths', () => {
  let root: string;
  beforeEach(async () => {
    root = await tempDir();
  });
  afterEach(async () => removeDir(root));

  it('prefers the nearest palm.yaml ancestor over a closer .git', async () => {
    await mkdir(join(root, 'a', 'b', 'c'), { recursive: true });
    await writeFile(join(root, 'a', 'palm.yaml'), 'skills: []\n');
    await mkdir(join(root, 'a', 'b', '.git'));
    const p = resolvePaths(join(root, 'a', 'b', 'c'), { HOME: join(root, 'home') });
    expect(p.projectRoot).toBe(join(root, 'a'));
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
    await writeFile(join(palmHome, 'palm.yaml'), 'skills: []\n');
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

  it('computes scope-specific paths', () => {
    const p = { palmHome: '/p', home: '/h', projectRoot: '/proj', cwd: '/proj' };
    expect(scopeRoot(p, 'project')).toBe('/proj');
    expect(scopeRoot(p, 'global')).toBe('/h');
    expect(manifestPath(p, 'project')).toBe('/proj/palm.yaml');
    expect(manifestPath(p, 'global')).toBe('/p/palm.yaml');
    expect(lockPath(p, 'project')).toBe('/proj/palm.lock.yaml');
    expect(lockPath(p, 'global')).toBe('/p/palm.lock.yaml');
    expect(hooksAssetDir(p, 'project', 'fmt')).toBe('/proj/.palm/hooks/fmt');
    expect(hooksAssetDir(p, 'global', 'fmt')).toBe('/p/hooks/fmt');
  });
});
