import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DepRef } from '../../src/domain/dep-ref.js';
import { depMatches, isMcpManifestEntry, loadYaml, Manifest } from '../../src/domain/manifest.js';
import { removeDir, tempDir } from '../support/sandbox.js';

const registryEntry = {
  kind: 'mcp' as const,
  name: 'gh',
  origin: 'registry',
  path: 'io.github.x/gh',
};

describe('Manifest dependencies', () => {
  it('lists references as DepRefs and inline MCP entries as objects', () => {
    const m = Manifest.of({
      skills: ['a@x#v1', { name: 'b', origin: 'y' }],
      mcp: ['io.github.x/gh', { name: 'docs', url: 'https://e.x/mcp' }, { name: 'plain' }],
    });
    const skills = m.deps('skill');
    expect(skills.every((d) => d instanceof DepRef)).toBe(true);
    expect(skills.map(String)).toEqual(['a@x#v1', 'b@y']);
    const mcp = m.deps('mcp');
    expect(mcp.map((d) => d instanceof DepRef)).toEqual([true, false, true]);
    expect(mcp[1]).toEqual({ name: 'docs', url: 'https://e.x/mcp' });
    expect(m.deps('agent')).toEqual([]);
  });

  it('adds, replaces by name (any case) and removes; emptied sections disappear', () => {
    const m = Manifest.of();
    m.addDep('skill', DepRef.parse('a@x')).addDep('skill', { name: 'b', origin: 'x' });
    m.addDep('skill', 'A@y#v1');
    expect(m.toJSON().skills).toEqual(['A@y#v1', 'b@x']);
    expect(m.hasDep('skill', 'a')).toBe(true);
    expect(m.hasDep('agent', 'a')).toBe(false);
    m.removeDep('skill', 'B').removeDep('skill', 'nope');
    expect(m.toJSON().skills).toEqual(['A@y#v1']);
    m.removeDep('skill', 'a');
    expect(m.toJSON()).toEqual({});
  });

  it('keeps MCP entries as strings or objects, matching registry names', () => {
    const m = Manifest.of()
      .addDep('mcp', { name: 'io.github.github/github-mcp-server' })
      .addDep('mcp', { name: 'docs', transport: 'http', url: 'https://e.x/mcp', env: undefined })
      .addDep('mcp', { name: 'gh', registry: 'io.github.x/gh', version: '1.0.0' });
    expect(m.toJSON().mcp).toEqual([
      'io.github.github/github-mcp-server',
      { name: 'docs', transport: 'http', url: 'https://e.x/mcp' },
      { name: 'gh', registry: 'io.github.x/gh', version: '1.0.0' },
    ]);
    // replacing by registry name
    m.addDep('mcp', { name: 'gh2', registry: 'IO.GITHUB.X/GH' });
    expect(m.toJSON().mcp).toHaveLength(3);
    expect(m.hasDep('mcp', 'io.github.x/gh')).toBe(true);
    m.removeDep('mcp', 'io.github.x/gh');
    expect(m.toJSON().mcp).toHaveLength(2);
  });

  it('ignores unparsable items when matching names', () => {
    const m = Manifest.of({ skills: ['#only-a-ref', 42 as never, 'ok'] });
    expect(m.hasDep('skill', 'ok')).toBe(true);
    m.addDep('skill', 'new');
    expect(m.toJSON().skills).toEqual(['#only-a-ref', 42, 'ok', 'new']);
  });

  it('finds the dependency an installed entry realises', () => {
    const m = Manifest.of({
      skills: ['Tdd@a'],
      mcp: [{ name: 'gh', registry: 'io.github.x/gh', version: '2.0.0' }, 'io.github.y/z'],
    });
    expect(String(m.depFor({ kind: 'skill', name: 'tdd', origin: 'b', path: 'x' }))).toBe('Tdd@a');
    expect(m.depFor(registryEntry)).toEqual({
      name: 'gh',
      registry: 'io.github.x/gh',
      version: '2.0.0',
    });
    expect(m.lists({ ...registryEntry, name: 'z', path: 'io.github.y/z' })).toBe(true);
    expect(m.lists({ kind: 'agent', name: 'tdd', origin: 'a', path: 'x' })).toBe(false);
  });

  it('depMatches: names ignore case; registry servers also match by registry name', () => {
    expect(
      depMatches('skill', { name: 'A' }, { kind: 'skill', name: 'a', origin: 'o', path: 'p' }),
    ).toBe(true);
    expect(
      depMatches('agent', { name: 'a' }, { kind: 'skill', name: 'a', origin: 'o', path: 'p' }),
    ).toBe(false);
    expect(depMatches('mcp', { name: 'io.github.x/GH' }, registryEntry)).toBe(true);
    expect(depMatches('mcp', { name: 'other', registry: 'io.github.x/gh' }, registryEntry)).toBe(
      true,
    );
    expect(depMatches('mcp', { name: 'io.github.x/gh' }, { ...registryEntry, origin: 'a' })).toBe(
      false,
    );
    expect(
      depMatches('skill', { name: 'io.github.x/gh' }, { ...registryEntry, kind: 'skill' }),
    ).toBe(false);
    expect(depMatches('mcp', { name: 'nope' }, registryEntry)).toBe(false);
  });

  it('isMcpManifestEntry needs an MCP field', () => {
    expect(isMcpManifestEntry({ name: 'a', url: 'u' })).toBe(true);
    expect(isMcpManifestEntry({ name: 'a', registry: 'r' })).toBe(true);
    expect(isMcpManifestEntry({ name: 'a', origin: 'o' })).toBe(false);
    expect(isMcpManifestEntry('a')).toBe(false);
  });

  it('exposes targets and origins, and replaces targets', () => {
    const data = { targets: ['claude' as const], origins: ['x'] };
    const m = Manifest.of(data);
    expect(m.targets).toEqual(['claude']);
    expect(m.origins).toEqual(['x']);
    m.setTargets(['codex', 'cursor']);
    expect(m.targets).toEqual(['codex', 'cursor']);
    expect(data.targets).toEqual(['claude']); // the wrapped data is never changed
    expect(JSON.parse(JSON.stringify(m))).toEqual({ targets: ['codex', 'cursor'], origins: ['x'] });
  });
});

describe('Manifest files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => removeDir(dir));

  it('is empty when missing', async () => {
    expect((await Manifest.load(join(dir, 'palm.yaml'))).toJSON()).toEqual({});
  });

  it('patches the file: comments, key order and flow lists survive', async () => {
    const file = join(dir, 'palm.yaml');
    const text = [
      '# project manifest',
      'targets: [claude, codex]',
      'skills:',
      '  # the planning skill',
      '  - wayfinder@mattpocock',
      'agents: []',
      'custom: kept',
      '',
    ].join('\n');
    await writeFile(file, text);
    const m = await Manifest.load(file);
    await m.save(file);
    expect(await readFile(file, 'utf8')).toBe(text);

    await m.addDep('skill', DepRef.parse('tdd@mattpocock')).save(file);
    const after = await readFile(file, 'utf8');
    expect(after).toContain('# project manifest');
    expect(after).toContain('# the planning skill');
    expect(after).toContain('targets: [claude, codex]');
    expect(after).toContain('custom: kept');
    expect((await Manifest.load(file)).deps('skill').map(String)).toEqual([
      'wayfinder@mattpocock',
      'tdd@mattpocock',
    ]);
  });

  it('writes a fresh file in canonical order with flow-style targets', async () => {
    const file = join(dir, 'sub', 'palm.yaml');
    await Manifest.of({ plugins: ['p'], skills: ['a@b'], targets: ['claude'] }).save(file);
    expect(await readFile(file, 'utf8')).toBe(
      'targets: [claude]\nskills:\n  - a@b\nplugins:\n  - p\n',
    );
  });

  it('drops null sections and rejects non-list sections, non-mappings, bad YAML and unreadable files', async () => {
    const file = join(dir, 'palm.yaml');
    await writeFile(file, 'skills:\nagents: [a]\n');
    expect((await Manifest.load(file)).toJSON()).toEqual({ agents: ['a'] });
    await writeFile(file, 'skills: wayfinder\n');
    await expect(Manifest.load(file)).rejects.toMatchObject({
      code: 'E_PARSE',
      message: /"skills" must be a list/,
    });
    await writeFile(file, '- a\n');
    await expect(Manifest.load(file)).rejects.toMatchObject({
      code: 'E_PARSE',
      message: /mapping/,
    });
    await writeFile(file, 'skills: [a\n');
    await expect(Manifest.load(file)).rejects.toMatchObject({ code: 'E_PARSE' });
    await mkdir(join(dir, 'd'));
    await expect(loadYaml(join(dir, 'd'))).rejects.toMatchObject({ code: 'E_IO' });
  });
});
