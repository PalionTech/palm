import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LockEntry } from '../../src/core/types.js';
import { Lock } from '../../src/domain/lock.js';
import { findFileOwners, ownersIn } from '../../src/engine/find.js';
import { installEntities } from '../../src/engine/install.js';
import { removeDir } from '../support/sandbox.js';
import { makeWorld, type World } from './world.js';

const both = { scopes: ['project', 'global'] as const };

function entry(over: Partial<LockEntry>): LockEntry {
  return {
    kind: 'skill',
    name: 'x',
    origin: 'a',
    path: 'skills/x',
    contentHash: 'sha256:0',
    transform: 1,
    targets: ['claude'],
    files: [],
    ...over,
  };
}

describe('palm find', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('finds the entry that wrote a file in either scope, by relative or absolute path', async () => {
    w = await makeWorld();
    const claude = ['claude' as const];
    await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'wayfinder' }],
      {
        scope: 'project',
        targets: claude,
      },
      w.deps,
    );
    await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'tdd' }],
      {
        scope: 'global',
        targets: claude,
      },
      w.deps,
    );

    const local = await findFileOwners(w.ctx, '.claude/skill/wayfinder.txt', both);
    expect(local.searched).toEqual(['project', 'global']);
    expect(local.owners).toHaveLength(1);
    expect(local.owners[0]).toMatchObject({
      scope: 'project',
      match: 'file',
      file: '.claude/skill/wayfinder.txt',
      entry: { kind: 'skill', name: 'wayfinder', origin: 'a' },
    });

    const abs = join(w.sb.home, '.claude/skill/tdd.txt');
    const global = await findFileOwners(w.ctx, abs, both);
    expect(global.owners.map((o) => [o.scope, o.entry.name])).toEqual([['global', 'tdd']]);
    // `~/…` and a scope-relative path under -g reach the same file
    expect((await findFileOwners(w.ctx, '~/.claude/skill/tdd.txt', both)).owners).toHaveLength(1);
    const onlyGlobal = { scopes: ['global'] as const };
    expect((await findFileOwners(w.ctx, '.claude/skill/tdd.txt', onlyGlobal)).owners).toHaveLength(
      1,
    );
    expect((await findFileOwners(w.ctx, '.claude/skill/wayfinder.txt', onlyGlobal)).owners).toEqual(
      [],
    );

    // relative to the working directory
    const inClaude = { ...w.ctx, paths: { ...w.ctx.paths, cwd: join(w.sb.project, '.claude') } };
    const fromCwd = await findFileOwners(inClaude, 'skill/wayfinder.txt', both);
    expect(fromCwd.owners.map((o) => o.entry.name)).toEqual(['wayfinder']);

    expect((await findFileOwners(w.ctx, 'README.md', both)).owners).toEqual([]);
  });

  it('a relative project path never resolves into the global scope root (R8 L5)', async () => {
    w = await makeWorld();
    const claude = ['claude' as const];
    const install = (spec: string, scope: 'project' | 'global') =>
      installEntities(w.ctx, [{ kind: 'skill', spec }], { scope, targets: claude }, w.deps);
    await install('wayfinder', 'project');
    await install('tdd', 'global');
    // `.claude/skill/tdd.txt` exists only under ~ (global); from the project it names nothing
    expect((await findFileOwners(w.ctx, '.claude/skill/tdd.txt', both)).owners).toEqual([]);
    // the global file stays reachable by an absolute or ~ path, or scope-relative with -g
    expect((await findFileOwners(w.ctx, '~/.claude/skill/tdd.txt', both)).owners).toHaveLength(1);
    const onlyGlobal = { scopes: ['global'] as const };
    expect((await findFileOwners(w.ctx, '.claude/skill/tdd.txt', onlyGlobal)).owners).toHaveLength(
      1,
    );
    // an existing cwd-relative path wins over the scope root: no fallback into the other file
    const inClaude = { ...w.ctx, paths: { ...w.ctx.paths, cwd: join(w.sb.project, '.claude') } };
    expect((await findFileOwners(inClaude, 'skill', onlyGlobal)).owners).toEqual([]);
  });

  it('a path inside an owned directory, and a merged config file', async () => {
    w = await makeWorld();
    const lock = new Lock([
      entry({ name: 'tdd', files: [{ path: '.claude/skills/tdd', hash: '' }] }),
      entry({
        kind: 'mcp',
        name: 'docs',
        path: '.mcp.json',
        merged: [{ file: '.mcp.json', pointer: '/mcpServers/docs', value: { url: 'x' } }],
      }),
    ]);
    expect(ownersIn(w.ctx, 'project', lock, '.claude/skills/tdd/SKILL.md')).toMatchObject([
      { match: 'inside', file: '.claude/skills/tdd', entry: { name: 'tdd' } },
    ]);
    expect(ownersIn(w.ctx, 'project', lock, './.mcp.json')).toMatchObject([
      { match: 'merged', file: '.mcp.json', pointer: '/mcpServers/docs', entry: { name: 'docs' } },
    ]);
    expect(ownersIn(w.ctx, 'project', lock, '.claude/agents')).toEqual([]);
  });

  it('a directory holding files an entry lists: the entry and how many files', async () => {
    w = await makeWorld();
    const lock = new Lock([
      entry({
        name: 'tdd',
        files: [
          { path: '.claude/skills/tdd/SKILL.md', hash: '' },
          { path: '.claude/skills/tdd/scripts/run.sh', hash: '' },
          { path: '.agents/skills/tdd/SKILL.md', hash: '' },
        ],
      }),
      entry({ name: 'grill', files: [{ path: '.claude/skills/grill/SKILL.md', hash: '' }] }),
    ]);
    expect(ownersIn(w.ctx, 'project', lock, '.claude/skills/tdd')).toMatchObject([
      { match: 'contains', file: '.claude/skills/tdd', files: 2, entry: { name: 'tdd' } },
    ]);
    expect(
      ownersIn(w.ctx, 'project', lock, '.claude/skills/').map((o) => [o.entry.name, o.files]),
    ).toEqual([
      ['tdd', 2],
      ['grill', 1],
    ]);
    expect(ownersIn(w.ctx, 'project', lock, '.claude/skills/tdd/SKILL.md')).toMatchObject([
      { match: 'file' },
    ]);
  });

  it('no lockfile in the searched scopes: E_USAGE', async () => {
    w = await makeWorld();
    await expect(findFileOwners(w.ctx, 'x', both)).rejects.toMatchObject({ code: 'E_USAGE' });
  });
});
