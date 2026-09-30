/**
 * Scope rulings from the 0.2 persona rerun (FINDINGS-v2.md): the global directories are never
 * a project (J4 J5 K14), in-repo sources anywhere in the repository (B9) and in home under -g
 * (J6), overlaps through symlinked output directories (C1 C2 B19), pulled removals under -g
 * (J7), an in-repo source at `.` converges (B3 R1 K7), and one file has one owner (R5).
 */
import './fakes.js';

import { mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Entity, PalmContext } from '../../src/core/types.js';
import { resolveEngineDeps } from '../../src/engine/deps.js';
import { installFromSource, listSource } from '../../src/engine/install.js';
import { renderEntity } from '../../src/engine/render.js';
import { openScope } from '../../src/engine/scope.js';
import { localDrift } from '../../src/engine/sources.js';
import { pendingRemovals, syncScope } from '../../src/engine/sync.js';
import { makeContext } from './fakes.js';
import { makeWorld, type World, writeTree } from './world.js';

const project = { scope: 'project' as const };
const global = { scope: 'global' as const };

function contextAt(w: World, dir: string, argv?: string[]): PalmContext & { argv?: string[] } {
  const ctx = makeContext({
    root: w.root,
    home: w.home,
    palmHome: w.palmHome,
    project: dir,
  });
  return argv ? { ...ctx, argv } : ctx;
}

describe('J4 J5 K14 the global directories are never a project', () => {
  it('J5 refuses project scope inside ~/.claude with the command and -g as the fix', async () => {
    const w = await makeWorld();
    const dir = join(w.home, '.claude');
    await mkdir(dir, { recursive: true });
    const ctx = contextAt(w, dir, ['install', 'acme', 'x']);
    await expect(openScope(ctx, 'project')).rejects.toMatchObject({
      code: 'E_USAGE',
      message: `${dir} is inside the global claude directory, not a project; your own setup takes -g`,
      hint: 'palm install acme x -g',
    });
  });

  it('J4 refuses project scope inside palm home', async () => {
    const w = await makeWorld();
    const dir = join(w.palmHome, 'kit');
    await mkdir(dir, { recursive: true });
    await expect(openScope(contextAt(w, dir), 'project')).rejects.toMatchObject({
      code: 'E_USAGE',
      message: expect.stringContaining('inside palm home'),
    });
  });
});

describe('B9 J6 in-repo sources outside the scope root', () => {
  it('B9 a nested project installs from a directory elsewhere in its repository', async () => {
    const w = await makeWorld();
    await mkdir(w.path('.git'), { recursive: true });
    await w.local('kit', { 'skills/x/SKILL.md': 'x\n' });
    const nested = w.path('packages/app');
    await writeTree(nested, { 'palm.yaml': 'targets: [claude]\n' });
    const ctx = contextAt(w, nested);
    const r = await installFromSource(
      ctx,
      { source: '../../kit', names: [{ name: 'x' }] },
      project,
      w.deps,
    );
    expect(r.failures).toEqual([]);
    expect(await readFile(join(nested, 'palm.yaml'), 'utf8')).toBe(
      'targets: [claude]\nsources:\n  ../../kit:\n    skills: [x]\n',
    );
    expect(await readFile(join(nested, '.claude/skills/x/SKILL.md'), 'utf8')).toBe('x\n');
    expect(await readFile(join(nested, 'palm.lock.yaml'), 'utf8')).toContain('path: ../../kit');
    const again = await syncScope(ctx, project, w.deps);
    expect(again.outcomes.map((o) => o.status)).toEqual(['unchanged']);
  });

  it('J6 under -g a directory anywhere in home is a source', async () => {
    const w = await makeWorld();
    await writeTree(w.palmHome, { 'palm.yaml': 'targets: [claude]\n' });
    const kit = join(w.home, 'dotfiles', 'kit');
    await writeTree(kit, { 'skills/x/SKILL.md': 'x\n' });
    const r = await installFromSource(
      w.ctx,
      { source: kit, names: [{ name: 'x' }] },
      global,
      w.deps,
    );
    expect(r.failures).toEqual([]);
    expect(await readFile(join(w.palmHome, 'palm.lock.yaml'), 'utf8')).toContain(
      'path: <home>/dotfiles/kit',
    );
    expect(await readFile(join(w.home, '.claude/skills/x/SKILL.md'), 'utf8')).toBe('x\n');
  });
});

describe('C1 C2 B19 overlaps through symlinked output directories', () => {
  it('C1 C2 refuses every install while an output directory links into a declared source', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const src = await w.local('skill', { 'skills/merge/SKILL.md': 'Merge.\n' });
    await mkdir(w.path('.claude'), { recursive: true });
    await symlink('../skill', w.path('.claude/skills'));
    await expect(
      installFromSource(w.ctx, { source: src, names: [{ name: 'merge' }] }, project, w.deps),
    ).rejects.toMatchObject({
      code: 'E_SOURCE',
      message:
        'source "./skill" (skill) overlaps the claude output directory through the symlink .claude/skills -> ../skill',
    });
    expect(await w.manifestText()).toBe('targets: [claude]\n');
  });

  it('B19 a listing of that source is refused too', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    await w.local('skill', { 'skills/merge/SKILL.md': 'Merge.\n' });
    await mkdir(w.path('.claude'), { recursive: true });
    await symlink('../skill', w.path('.claude/skills'));
    await expect(listSource(w.ctx, './skill', project, w.deps)).rejects.toMatchObject({
      code: 'E_SOURCE',
    });
  });

  it('C1 a symlinked output directory that is no source gets one notice', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', { 'v1.0.0': { 'skills/x/SKILL.md': 'x\n' } });
    await mkdir(w.path('.claude'), { recursive: true });
    await mkdir(w.path('shared'), { recursive: true });
    await symlink('../shared', w.path('.claude/skills'));
    await installFromSource(w.ctx, { source: url, names: [{ name: 'x' }] }, project, w.deps);
    expect(w.ctx.log.text()).toContain(
      '.claude/skills is a symlink to ../shared; palm writes through it',
    );
    expect(await w.read('shared/x/SKILL.md')).toBe('x\n');
  });
});

describe('J7 a removal pulled in with the global lock', () => {
  it('J7 pendingRemovals lists it, a dry run names it, a bare install removes it', async () => {
    const w = await makeWorld();
    await writeTree(w.palmHome, { 'palm.yaml': 'targets: [claude]\n' });
    const url = await w.remote('kit', { 'v1.0.0': { 'skills/x/SKILL.md': 'x\n' } });
    await installFromSource(w.ctx, { source: url, names: [{ name: 'x' }] }, global, w.deps);
    await writeTree(w.palmHome, {
      'palm.yaml': 'targets: [claude]\n',
      'palm.lock.yaml': 'version: 3\nsources: {}\nentries: []\n',
    });
    const deps = await resolveEngineDeps(w.deps);
    const state = await openScope(w.ctx, 'global', { deps, readOnly: true });
    expect(await pendingRemovals(state)).toEqual({
      files: ['<claude>/skills/x/SKILL.md'],
      fragments: [],
    });
    const dry = w.context({ dryRun: true });
    await syncScope(dry, global, w.deps);
    expect(dry.log.text()).toContain(
      'would remove <claude>/skills/x/SKILL.md: palm.lock.yaml no longer lists it',
    );
    const file = join(w.home, '.claude/skills/x/SKILL.md');
    expect(await readFile(file, 'utf8')).toBe('x\n');
    await syncScope(w.ctx, global, w.deps);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('B3 R1 K7 an in-repo source converges', () => {
  it('B3 R1 the lock holds no tree hash and a source at . is unchanged on the next run', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    await w.write('skills/x/SKILL.md', 'x\n');
    await installFromSource(w.ctx, { source: '.', names: [{ name: 'x' }] }, project, w.deps);
    const lock = await w.lockText();
    expect(lock).not.toContain('tree:');
    const r = await syncScope(w.ctx, project, w.deps);
    expect(r.outcomes.map((o) => o.status)).toEqual(['unchanged']);
    expect(await w.lockText()).toBe(lock);
  });

  it('K7 a root entity content leaves out palm files, outputs and lock-owned paths', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    await w.write('skills/x/SKILL.md', 'x\n');
    await w.write('SKILL.md', 'root\n');
    await installFromSource(w.ctx, { source: '.', names: [{ name: 'x' }] }, project, w.deps);
    const deps = await resolveEngineDeps(w.deps);
    const content = async () => {
      const state = await openScope(w.ctx, 'project', { deps, readOnly: true });
      const ref = state.sources.byName('.');
      if (!ref) throw new Error('no source');
      const root = await realpath(w.project);
      const entity: Entity = {
        kind: 'skill',
        name: 'root',
        path: '.',
        source: '.',
        def: { kind: 'skill', skill: { name: 'root', description: 'root' } },
      };
      const checkout = { source: ref.source, sourceId: 'local', root, repoDir: root };
      const out = await renderEntity(w.ctx, deps, state, {
        entity,
        source: ref,
        checkout,
        targets: [],
        policy: 'env-ref',
      });
      return out.content;
    };
    const before = await content();
    await w.write('palm.yaml', `${await w.manifestText()}# a comment\n`);
    await w.write('.claude/skills/x/extra.md', 'output\n');
    await w.write('.palm/local/x', 'local\n');
    expect(await content()).toBe(before);
    await w.write('SKILL.md', 'root, edited\n');
    expect(await content()).not.toBe(before);
  });

  it('B3 localDrift names an in-repo entry whose files changed', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const src = await w.local('agent-kit', { 'skills/x/SKILL.md': 'x\n' });
    await installFromSource(w.ctx, { source: src, names: [{ name: 'x' }] }, project, w.deps);
    const deps = await resolveEngineDeps(w.deps);
    const state = await openScope(w.ctx, 'project', { deps, readOnly: true });
    const entry = state.lock.entries[0];
    const drift = localDrift(state, new Map([['skill:x@./agent-kit', { content: 'sha256:1' }]]));
    expect(drift).toEqual([{ entry, content: 'sha256:1' }]);
    expect(localDrift(state, new Map([['skill:x@./agent-kit', entry]]))).toEqual([]);
  });
});

describe('R5 one file has one owner', () => {
  it('R5 refuses an entity whose file another entry lists, naming that entry', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('skills', { 'v1.0.0': { 'skills/tdd/SKILL.md': 'Test.\n' } });
    await w.write(
      'palm.lock.yaml',
      'version: 3\nsources: {}\nentries:\n  - kind: agent\n    name: helper\n    source: odu\n    path: agents/helper.md\n    content: sha256:0\n    render: { claude: sha256:0 }\n    files: [.claude/skills/tdd/SKILL.md]\n',
    );
    const r = await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'tdd' }] },
      project,
      w.deps,
    );
    expect(r.failures).toEqual([
      expect.objectContaining({
        code: 'E_CONFLICT',
        message:
          '.claude/skills/tdd/SKILL.md belongs to agent helper from odu; one file has one owner',
        hint: 'palm remove odu agent:helper',
      }),
    ]);
    expect(w.exists('.claude/skills/tdd/SKILL.md')).toBe(false);
  });
});
