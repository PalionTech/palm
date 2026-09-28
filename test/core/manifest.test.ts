import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addDep,
  formatDepRef,
  listDeps,
  loadManifest,
  normalizeDep,
  parseDepRef,
  removeDep,
  saveManifest,
} from '../../src/core/manifest.js';
import { removeDir, tempDir } from '../support/sandbox.js';

describe('parseDepRef', () => {
  it.each([
    ['wayfinder', { name: 'wayfinder' }],
    ['wayfinder@mattpocock', { name: 'wayfinder', origin: 'mattpocock' }],
    ['tdd@mattpocock#v1.2.3', { name: 'tdd', origin: 'mattpocock', ref: 'v1.2.3' }],
    ['io.github.github/github-mcp-server', { name: 'io.github.github/github-mcp-server' }],
    [
      'io.github.github/github-mcp-server#1.0.0',
      { name: 'io.github.github/github-mcp-server', ref: '1.0.0' },
    ],
    ['x#main', { name: 'x', ref: 'main' }],
    ['@scope/pkg', { name: '@scope/pkg' }],
  ])('%s', (input, expected) => {
    expect(parseDepRef(input)).toEqual(expected);
  });

  it('rejects an empty name', () => {
    expect(() => parseDepRef('@origin')).not.toThrow(); // "@origin" is a name (no text before @)
    expect(() => parseDepRef('#ref')).toThrow(/missing name/);
  });

  it('round-trips through formatDepRef', () => {
    for (const s of ['a', 'a@o', 'a@o#r', 'a#r']) expect(formatDepRef(parseDepRef(s))).toBe(s);
  });

  it('normalizes object deps', () => {
    expect(normalizeDep({ name: 'a', origin: 'o' })).toEqual({ name: 'a', origin: 'o' });
    expect(normalizeDep('a@o')).toEqual({ name: 'a', origin: 'o' });
  });
});

describe('manifest deps', () => {
  it('adds, replaces and removes', () => {
    let m = addDep({}, 'skill', { name: 'a', origin: 'x' });
    m = addDep(m, 'skill', { name: 'b', origin: 'x' });
    m = addDep(m, 'skill', { name: 'a', origin: 'y', ref: 'v1' });
    expect(m.skills).toEqual(['a@y#v1', 'b@x']);
    m = removeDep(m, 'skill', 'A');
    expect(m.skills).toEqual(['b@x']);
    expect(listDeps(m, 'skill')).toEqual([{ name: 'b', origin: 'x' }]);
  });

  it('keeps MCP entries as strings or objects', () => {
    let m = addDep({}, 'mcp', { name: 'io.github.github/github-mcp-server' });
    m = addDep(m, 'mcp', { name: 'docs', transport: 'http', url: 'https://e.x/mcp' });
    m = addDep(m, 'mcp', { name: 'gh', registry: 'io.github.x/gh', version: '1.0.0' });
    expect(m.mcp).toEqual([
      'io.github.github/github-mcp-server',
      { name: 'docs', transport: 'http', url: 'https://e.x/mcp' },
      { name: 'gh', registry: 'io.github.x/gh', version: '1.0.0' },
    ]);
    expect(listDeps(m, 'mcp')[1]).toEqual({
      name: 'docs',
      transport: 'http',
      url: 'https://e.x/mcp',
    });
    // removal matches the registry name too
    m = removeDep(m, 'mcp', 'io.github.x/gh');
    expect(m.mcp).toHaveLength(2);
  });
});

describe('manifest files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => removeDir(dir));

  it('returns {} when missing', async () => {
    expect(await loadManifest(join(dir, 'palm.yaml'))).toEqual({});
  });

  it('round-trips and preserves comments and key order', async () => {
    const file = join(dir, 'palm.yaml');
    await writeFile(
      file,
      [
        '# project manifest',
        'targets: [claude, codex]',
        'skills:',
        '  # the planning skill',
        '  - wayfinder@mattpocock',
        'agents: []',
        '',
      ].join('\n'),
    );
    const m = await loadManifest(file);
    expect(m.skills).toEqual(['wayfinder@mattpocock']);
    await saveManifest(file, addDep(m, 'skill', { name: 'tdd', origin: 'mattpocock' }));
    const text = await readFile(file, 'utf8');
    expect(text).toContain('# project manifest');
    expect(text).toContain('# the planning skill');
    expect(text).toContain('targets: [claude, codex]');
    expect(text.indexOf('targets')).toBeLessThan(text.indexOf('skills'));
    expect((await loadManifest(file)).skills).toEqual(['wayfinder@mattpocock', 'tdd@mattpocock']);
  });

  it('writes a fresh file in canonical order', async () => {
    const file = join(dir, 'sub', 'palm.yaml');
    await saveManifest(file, { skills: ['a@b'], targets: ['claude'] });
    const text = await readFile(file, 'utf8');
    expect(text.indexOf('targets')).toBeLessThan(text.indexOf('skills'));
    expect(await loadManifest(file)).toEqual({ targets: ['claude'], skills: ['a@b'] });
  });

  it('rejects malformed sections', async () => {
    const file = join(dir, 'palm.yaml');
    await writeFile(file, 'skills: wayfinder\n');
    await expect(loadManifest(file)).rejects.toMatchObject({ code: 'E_PARSE' });
  });

  it('reports invalid YAML as E_PARSE naming the file, and read failures as E_IO', async () => {
    const file = join(dir, 'palm.yaml');
    await writeFile(file, 'skills: [a\n');
    await expect(loadManifest(file)).rejects.toMatchObject({
      code: 'E_PARSE',
      message: expect.stringContaining(file),
    });
    await expect(loadManifest(dir)).rejects.toMatchObject({ code: 'E_IO' });
  });
});
