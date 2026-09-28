import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseYaml,
  readYamlFile,
  stringifyYaml,
  writeYamlFile,
  yamlScalar,
} from '../../src/lib/yaml.js';
import { cleanupTmp, read, tmpDir, write } from '../support/sandbox.js';

afterEach(cleanupTmp);

describe('parseYaml / stringifyYaml / yamlScalar', () => {
  it('parses a document; empty or null documents are undefined', () => {
    expect(parseYaml('a: [1, 2]\n')).toEqual({ a: [1, 2] });
    expect(parseYaml('')).toBeUndefined();
    expect(parseYaml('# only a comment\n')).toBeUndefined();
    expect(parseYaml('~')).toBeUndefined();
  });

  it('throws an Error naming the source on invalid YAML', () => {
    expect(() => parseYaml('a: [', 'palm.yaml')).toThrow(/^invalid YAML in palm\.yaml: /);
    expect(() => parseYaml('a: 1\na: 2')).toThrow(/^invalid YAML: /);
  });

  it('stringifies in block style without folding', () => {
    const long = 'x '.repeat(80).trim();
    expect(stringifyYaml({ a: [1], b: long, e: [] })).toBe(`a:\n  - 1\nb: ${long}\ne: []\n`);
  });

  it('quotes scalars only when needed', () => {
    expect(yamlScalar('plain')).toBe('plain');
    expect(yamlScalar('a: b')).toBe('"a: b"');
    expect(yamlScalar('true')).toBe('"true"');
  });
});

describe('readYamlFile', () => {
  it('reads a file; missing or empty files are undefined', async () => {
    const dir = await tmpDir();
    expect(await readYamlFile(join(dir, 'missing.yaml'))).toBeUndefined();
    await write(join(dir, 'empty.yaml'), '');
    expect(await readYamlFile(join(dir, 'empty.yaml'))).toBeUndefined();
    await write(join(dir, 'a.yaml'), 'skills:\n  - tdd\n');
    expect(await readYamlFile(join(dir, 'a.yaml'))).toEqual({ skills: ['tdd'] });
    await write(join(dir, 'bad.yaml'), 'a: [');
    await expect(readYamlFile(join(dir, 'bad.yaml'))).rejects.toThrow(
      `invalid YAML in ${join(dir, 'bad.yaml')}`,
    );
  });
});

describe('writeYamlFile', () => {
  it('writes a fresh document with flow keys, a header comment and a mode', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'sub', 'palm.yaml');
    await writeYamlFile(
      file,
      { targets: ['claude', 'codex'], skills: ['a'], skip: undefined },
      {
        flowKeys: ['targets', 'skills-not-a-list'],
        comment: 'generated\nsecond line',
        mode: 0o600,
      },
    );
    expect(await read(file)).toBe(
      '# generated\n# second line\ntargets: [claude, codex]\nskills:\n  - a\n',
    );
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('matches a plain stringify when nothing is to be preserved', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'lock.yaml');
    const value = { version: 1, entries: [{ kind: 'skill', files: [], merged: [] }] };
    await writeYamlFile(file, value, { preserveFrom: false, comment: ' header' });
    expect(await read(file)).toBe(`#  header\n${stringifyYaml(value)}`);
    await writeYamlFile(file, 'scalar', { preserveFrom: false });
    expect(await read(file)).toBe('scalar\n');
  });

  it('patches an existing file: comments, order and untouched nodes survive', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'palm.yaml');
    await write(
      file,
      [
        '# project manifest',
        'targets: [claude]  # harnesses',
        'skills:',
        '  - tdd # keep me',
        '  - old',
        'mcp:',
        '  - name: fs # server',
        '    command: npx',
        'gone: 1',
        '',
      ].join('\n'),
    );
    await writeYamlFile(file, {
      targets: ['claude'],
      skills: ['new', 'tdd'],
      mcp: [{ name: 'fs', command: 'node' }],
      agents: ['x'],
    });
    expect(await read(file)).toBe(
      [
        '# project manifest',
        'targets: [claude] # harnesses',
        'skills:',
        '  - new',
        '  - tdd # keep me',
        'mcp:',
        '  - name: fs # server',
        '    command: node',
        'agents:',
        '  - x',
        '',
      ].join('\n'),
    );
  });

  it('puts a new key where the value orders it, flow keys in flow style', async () => {
    const file = join(await tmpDir(), 'palm.yaml');
    await write(file, '# project manifest\n\nskills:\n  - a@o\nmcp:\n  - x\n');
    const value = { targets: ['claude', 'codex'], skills: ['a@o'], agents: ['r@o'], mcp: ['x'] };
    await writeYamlFile(file, value, { flowKeys: ['targets'] });
    expect(await read(file)).toBe(
      '# project manifest\n\ntargets: [claude, codex]\nskills:\n  - a@o\nagents:\n  - r@o\nmcp:\n  - x\n',
    );
  });

  it('replaces nodes whose type changed', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'c.yaml');
    await write(file, 'a: [1]\nb: {x: 1}\n');
    await writeYamlFile(file, { a: { y: 2 }, b: [3] });
    expect(await readYamlFile(file)).toEqual({ a: { y: 2 }, b: [3] });
  });

  it('patches preserveFrom text instead of the file', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'init.yaml');
    await write(file, '# this comment is replaced\na: 0\n');
    const template = '# from template\na: 0\nb: keep # unchanged nodes keep comments\n';
    await writeYamlFile(file, { a: 1, b: 'keep' }, { preserveFrom: template });
    expect(await read(file)).toBe(
      '# from template\na: 1\nb: keep # unchanged nodes keep comments\n',
    );
  });

  it('keeps a comment-only template as the header', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'h.yaml');
    await writeYamlFile(file, { a: 1 }, { preserveFrom: '# header\n' });
    expect(await read(file)).toBe('# header\n\na: 1\n');
  });

  it('rewrites a blank or invalid existing file from scratch', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'broken.yaml');
    await write(file, 'a: [\n');
    await writeYamlFile(file, { a: [1] }, { flowKeys: ['a'] });
    expect(await read(file)).toBe('a: [1]\n');
    await write(file, '  \n');
    await writeYamlFile(file, { b: 2 });
    expect(await read(file)).toBe('b: 2\n');
  });
});
