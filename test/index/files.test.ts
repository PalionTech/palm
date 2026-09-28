import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFileIndex, type FileIndex } from '../../src/index/files.js';
import { globIndex } from '../../src/index/glob.js';
import { defaultIgnoreGlobs } from '../../src/index/ignore.js';
import { scanOrigin } from '../../src/index/scan.js';
import { putFile } from '../support/sandbox.js';

let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'palm-files-')));
  root = join(tmp, 'repo');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const put = (rel: string, content: string | object = 'x\n') => putFile(root, rel, content);
const index = (): Promise<FileIndex> =>
  buildFileIndex(root, { ignore: defaultIgnoreGlobs(), deep: 10, ignoreDirNames: true });

describe('FileIndex directory indexes', () => {
  beforeEach(async () => {
    await put('skills/a/SKILL.md');
    await put('skills/a/refs/r.md');
    await put('skills/a/nested/b/SKILL.md');
    await put('skills/z/SKILL.md');
    await put('bucket/eng/c/SKILL.md');
    await put('bucket/eng/deep/x/y/d/SKILL.md');
    await put('agents/one.md');
    await put('agents/team/two.md');
    await put('agents/team/deeper/three.md');
    await put('agents/team/deeper/four/five.md');
    await put('agents/logo.svg'); // not relevant: not indexed
    await put('examples/e/SKILL.md'); // ignored
  });

  it('lists files per directory and to a depth, sorted, without irrelevant or ignored files', async () => {
    const ix = await index();
    expect(ix.filesIn('agents')).toEqual(['agents/one.md']);
    expect(ix.filesUnder('agents', 2)).toEqual([
      'agents/one.md',
      'agents/team/deeper/three.md',
      'agents/team/two.md',
    ]);
    expect(ix.filesUnder('agents')).toHaveLength(4);
    expect(ix.filesIn('nope')).toEqual([]);
    expect(ix.hasDir('examples')).toBe(false);
    expect(ix.hasDir('')).toBe(true);
  });

  it('finds skill directories by parent, below a bucket and within a subtree', async () => {
    const ix = await index();
    expect(ix.childSkillDirs('skills')).toEqual(['skills/a', 'skills/z']);
    expect(ix.childSkillDirs('bucket')).toEqual([]);
    // Top-most skills up to three levels down; the one five levels down is out of reach.
    expect(ix.skillDirsBelow('bucket')).toEqual(['bucket/eng/c']);
    expect(ix.skillDirsBelow('skills')).toEqual(['skills/a', 'skills/z']);
    expect(ix.skillDirsWithin('skills').sort()).toEqual([
      'skills/a',
      'skills/a/nested/b',
      'skills/z',
    ]);
    expect(ix.parentSkillDir('skills/a/nested/b')).toBe('skills/a');
    expect(ix.insideSkillDir('skills/a/refs/r.md')).toBe(true);
    expect(ix.insideSkillDir('agents/one.md')).toBe(false);
  });

  it('merges a separately walked subtree', async () => {
    const ix = await index();
    const sub = await buildFileIndex(join(root, 'examples'), {
      ignore: [],
      deep: 10,
      ignoreDirNames: true,
    });
    ix.merge('examples', sub);
    expect(ix.childSkillDirs('examples')).toEqual(['examples/e']);
    expect(ix.hasFile('examples/e/SKILL.md')).toBe(true);
    expect(ix.files).toEqual([...ix.files].sort());
  });
});

describe('globIndex', () => {
  it('matches like fast-glob on disk, but only indexed entries', async () => {
    await put('skills/.curated/a/SKILL.md');
    await put('skills/b/SKILL.md');
    await put('skills/b/run.py'); // not indexed
    await put('tests/t/SKILL.md'); // ignored
    const ix = await index();
    const opts = { cwd: root, dot: true, onlyFiles: false, markDirectories: true };
    expect((await globIndex(ix, ['skills/*/*', 'skills/*'], opts)).sort()).toEqual([
      'skills/.curated/',
      'skills/.curated/a/',
      'skills/b/',
      'skills/b/SKILL.md',
    ]);
    expect(await globIndex(ix, 'skills/b/SKILL.md', opts)).toEqual(['skills/b/SKILL.md']);
    expect(await globIndex(ix, 'skills/b/run.py', opts)).toEqual([]);
    expect(await globIndex(ix, '**/SKILL.md', { ...opts, cwd: join(root, 'tests') })).toEqual([]);
    // Parent patterns resolve inside the origin; beyond its root there is nothing.
    const fromSkills = { ...opts, cwd: join(root, 'skills') };
    expect(await globIndex(ix, '../*', fromSkills)).toEqual(['../skills/']);
    expect(await globIndex(ix, '../../*', fromSkills)).toEqual([]);
  });
});

describe('scan with index-backed globs', () => {
  it('plugin globs resolve through the index and never reach outside the origin', async () => {
    await put('.claude-plugin/plugin.json', {
      name: 'p',
      skills: ['./skills/*', '../outside/*'],
      agents: ['./agents/**/*.md', '../outside/*.md'],
    });
    await put('skills/a/SKILL.md', '---\nname: a\ndescription: A\n---\nA\n');
    await put('agents/team/rev.md', '---\nname: rev\ndescription: R\n---\nR\n');
    await putFile(tmp, 'outside/evil/SKILL.md', '---\nname: evil\ndescription: E\n---\nE\n');
    await putFile(tmp, 'outside/evil.md', '---\nname: evil\ndescription: E\n---\nE\n');
    const r = await scanOrigin(root, { alias: 'o', type: 'local', path: root });
    expect(r.entities.map((e) => `${e.kind}:${e.name}`).sort()).toEqual([
      'agent:rev',
      'plugin:p',
      'skill:a',
    ]);
    expect(r.warnings).toEqual(['plugin p: declared skill path "../outside/*" not found']);
  });

  it('descriptor globs honour exclude and follow in-origin symlinks once', async () => {
    await put('catalog/a/SKILL.md', '---\nname: a\ndescription: A\n---\nA\n');
    await put('catalog/b/SKILL.md', '---\nname: b\ndescription: B\n---\nB\n');
    await mkdir(join(root, 'linked'), { recursive: true });
    await symlink('../catalog/a', join(root, 'linked/a'));
    const r = await scanOrigin(root, {
      alias: 'o',
      type: 'local',
      path: root,
      layout: { skills: ['catalog/*', 'linked/*'], exclude: ['catalog/b'] },
    });
    expect(r.entities.map((e) => `${e.name} ${e.path}`)).toEqual(['a catalog/a']);
  });
});
