/**
 * core rulings from the 0.2 persona rerun (FINDINGS-v2.md): Ctrl-C in a git child is a
 * cancellation (C16), a missing repository reads "not found or private" (K24), the global
 * manifest behind a symlink is never a project and the global directories refuse project
 * scope and init (J4, J5, K14), a local source may lie anywhere in the repository of a nested
 * project or, under -g, in home (B9, J6), and a root hook named after its source keeps a short
 * asset path (K23).
 */
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toPalmError } from '../../src/core/git-call.js';
import { GitFailure, runGit } from '../../src/core/git-exec.js';
import { globalDirHolding, initRefusal, resolvePaths } from '../../src/core/paths.js';
import { parseSourceInput } from '../../src/core/source-input.js';
import { ScopePaths } from '../../src/domain/scope-paths.js';
import { SourceRef } from '../../src/domain/source.js';
import { removeDir, tempDir } from '../support/sandbox.js';

let root: string;
beforeEach(async () => {
  root = await tempDir();
});
afterEach(async () => removeDir(root));

describe('C16 Ctrl-C in git', () => {
  it('C16 a git child that ends with SIGINT (exit 130) is E_CANCELLED, not a git failure', async () => {
    await expect(runGit(['-c', 'alias.x=!kill -INT $$', 'x'], { cwd: root })).rejects.toMatchObject(
      { code: 'E_CANCELLED' },
    );
  });
});

describe('K24 a missing repository', () => {
  it('K24 reads "repository not found or private" with git ls-remote as the hint', () => {
    const url = 'https://github.com/anthropic/skills.git';
    const e = toPalmError(
      new GitFailure(
        'x',
        'fatal: could not read Username for https://github.com: terminal prompts disabled',
      ),
      'cannot list the tags of',
      url,
    );
    expect(e).toMatchObject({
      code: 'E_SOURCE',
      message: `repository not found or private: ${url}`,
      hint: `check the name, then try: git ls-remote ${url}`,
    });
    expect(e.message).not.toContain('Username');
  });
});

describe('J4 J5 K14 the global scope is never a project', () => {
  it('J4 a palm.yaml that is the global manifest behind a symlink is no project root', async () => {
    const home = join(root, 'home');
    const dotfiles = join(home, 'dotfiles', 'palm');
    await mkdir(join(dotfiles, 'kit'), { recursive: true });
    await mkdir(join(home, 'dotfiles', '.git'), { recursive: true });
    await writeFile(join(dotfiles, 'palm.yaml'), 'targets: [claude]\n');
    await mkdir(join(home, '.palm'), { recursive: true });
    await symlink(join(dotfiles, 'palm.yaml'), join(home, '.palm', 'palm.yaml'));
    const env = { HOME: home };
    const p = resolvePaths(join(dotfiles, 'kit'), env);
    expect(p.projectRoot).toBe(join(home, 'dotfiles'));
    expect(globalDirHolding(p.cwd, p, env)).toBe('the directory of the global palm.yaml');
  });

  it('J4 a palm.yaml next to a lock of token paths is no project root', async () => {
    const dir = join(root, 'copy');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'palm.yaml'), 'targets: [claude]\n');
    await writeFile(
      join(dir, 'palm.lock.yaml'),
      'version: 3\nentries:\n  - kind: skill\n    files:\n      - <claude>/skills/x/SKILL.md\n',
    );
    const p = resolvePaths(join(dir, 'sub'), { HOME: join(root, 'home') });
    expect(p.projectRoot).toBe(join(dir, 'sub'));
  });

  it('J5 ~/.claude, ~/.agents and palm home are global directories; a project is not', async () => {
    const home = join(root, 'home');
    const env = { HOME: home };
    const p = resolvePaths(root, env);
    expect(globalDirHolding(join(home, '.claude', 'skills'), p, env)).toBe(
      'the global claude directory',
    );
    expect(globalDirHolding(join(home, '.agents'), p, env)).toBe('the global skills directory');
    expect(globalDirHolding(join(home, '.palm', 'kit'), p, env)).toBe('palm home');
    expect(globalDirHolding(join(home, 'work', 'app'), p, env)).toBeUndefined();
  });

  it('K14 init refuses the home directory and the global directories', async () => {
    const home = join(root, 'home');
    await mkdir(join(home, '.codex'), { recursive: true });
    const env = { HOME: home };
    const p = resolvePaths(home, env);
    expect(initRefusal(home, p, env)).toBe('the home directory is not a project');
    expect(initRefusal(join(home, '.codex'), p, env)).toMatch(/inside the global codex directory/);
    expect(initRefusal(join(home, 'work'), p, env)).toBeUndefined();
  });
});

describe('B9 J6 local sources outside the project root', () => {
  it('B9 names a directory above a nested project ../kit when it lies inside the repository', async () => {
    const repo = join(root, 'repo');
    await mkdir(join(repo, 'kit'), { recursive: true });
    await mkdir(join(repo, 'packages', 'app'), { recursive: true });
    const project = join(repo, 'packages', 'app');
    const s = parseSourceInput('../../kit', { cwd: project, projectRoot: project, within: repo });
    expect(s).toMatchObject({ name: '../../kit', type: 'local', path: join(repo, 'kit') });
  });

  it('B9 still refuses a directory outside the repository', async () => {
    const repo = join(root, 'repo');
    await mkdir(join(repo, 'app'), { recursive: true });
    await mkdir(join(root, 'outside'), { recursive: true });
    expect(() =>
      parseSourceInput('../../outside', {
        cwd: join(repo, 'app'),
        projectRoot: join(repo, 'app'),
        within: repo,
      }),
    ).toThrow(expect.objectContaining({ code: 'E_SOURCE' }));
  });

  it('J6 under -g a directory anywhere in home is named relative to palm home', async () => {
    const home = join(root, 'home');
    await mkdir(join(home, 'dotfiles', 'palm', 'kit'), { recursive: true });
    await mkdir(join(home, '.palm'), { recursive: true });
    const s = parseSourceInput(join(home, 'dotfiles', 'palm', 'kit'), {
      cwd: home,
      projectRoot: join(home, '.palm'),
      within: home,
    });
    expect(s.name).toBe('../dotfiles/palm/kit');
  });
});

describe('K23 asset paths', () => {
  it('K23 collapses .palm/assets/<source>/<entity> when the entity is named like the source', () => {
    const paths = new ScopePaths('project', join(root, 'p'), join(root, 'ph'), { HOME: root });
    const kit = SourceRef.of({ name: 'moved-kit', type: 'git', url: 'https://x.example/k.git' });
    expect(paths.assetRoot(kit, 'moved-kit')).toBe('.palm/assets/moved-kit');
    expect(paths.assetRoot(kit, 'fmt')).toBe('.palm/assets/moved-kit/fmt');
  });
});
