import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContext, scopedPaths } from '../../src/core/context.js';
import { gitToplevel } from '../../src/lib/fs.js';
import { defaultFlags, fakeLogger, fakeUI, makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => removeDir(sb.root));

describe('createContext', () => {
  it('reads nothing: a broken palm.yaml or a leftover config.yaml does not matter', async () => {
    await writeFile(join(sb.project, 'palm.yaml'), 'origins: [\n');
    await mkdir(sb.palmHome, { recursive: true });
    await writeFile(join(sb.palmHome, 'config.yaml'), 'origins: nope\n');
    const ctx = await createContext({
      cwd: join(sb.project),
      env: sb.env,
      ui: fakeUI(),
      log: fakeLogger(),
      flags: defaultFlags({ dryRun: true }),
    });
    expect(ctx.paths).toEqual({
      palmHome: sb.palmHome,
      home: sb.home,
      projectRoot: sb.project,
      cwd: sb.project,
    });
    expect(ctx.flags).toMatchObject({ dryRun: true, allowExec: [], local: false });
    expect(Object.keys(ctx).sort()).toEqual(['env', 'flags', 'log', 'paths', 'ui']);
    expect(existsSync(join(sb.palmHome, 'cache'))).toBe(false);
  });

  it('copies the flags, so a command changing them leaves the caller alone', async () => {
    const flags = defaultFlags();
    const ctx = await createContext({
      cwd: sb.project,
      env: sb.env,
      ui: fakeUI(),
      log: fakeLogger(),
      flags,
    });
    ctx.flags.yes = true;
    expect(flags.yes).toBe(false);
  });

  it('installs the hardened git runner for the read-only git queries', async () => {
    await execa('git', ['init', '-q', sb.project]);
    await makeContext(sb);
    expect(await gitToplevel(join(sb.project, 'missing', 'dir'))).toBe(sb.project);
  });
});

describe('scopedPaths', () => {
  it('gives the project or the global scope of the context', async () => {
    const ctx = await makeContext(sb);
    expect(scopedPaths(ctx, 'project').manifestFile).toBe(sb.manifestFile);
    expect(scopedPaths(ctx, 'global').lockFile).toBe(sb.globalLockFile);
    expect(scopedPaths(ctx, 'global').appliedFile).toBe(sb.appliedFile);
  });
});
