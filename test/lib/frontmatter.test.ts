import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeBody,
  parseFrontmatter,
  parseFrontmatterYaml,
  readFrontmatterFile,
  splitFrontmatter,
  stringifyFrontmatter,
  withFrontmatter,
} from '../../src/lib/frontmatter.js';
import { cleanupTmp, tmpDir, write } from '../support/sandbox.js';

afterEach(cleanupTmp);

describe('parseFrontmatter', () => {
  it('returns empty data and the whole text without frontmatter', () => {
    expect(parseFrontmatter('# Title\n\nBody\n')).toEqual({ data: {}, body: '# Title\n\nBody\n' });
  });

  it('treats an unclosed fence as no frontmatter', () => {
    const text = '---\nname: x\n\nno closing fence';
    expect(splitFrontmatter(text)).toEqual({ hasFrontmatter: false, raw: '', body: text });
  });

  it('parses LF frontmatter and strips blank lines before the body', () => {
    const r = parseFrontmatter('---\nname: tdd\ndescription: Test first\n---\n\n\n# TDD\n');
    expect(r).toEqual({ data: { name: 'tdd', description: 'Test first' }, body: '# TDD\n' });
  });

  it('tolerates CRLF line endings, a BOM and a `...` closing fence', () => {
    const r = parseFrontmatter('﻿---\r\nname: tdd\r\n...\r\n\r\nBody line\r\nsecond\r\n');
    expect(r).toEqual({ data: { name: 'tdd' }, body: 'Body line\nsecond\n' });
  });

  it('handles empty frontmatter', () => {
    expect(splitFrontmatter('---\n---\nbody').hasFrontmatter).toBe(true);
    expect(parseFrontmatter('---\n---\nbody')).toEqual({ data: {}, body: 'body' });
  });

  it('accepts duplicate keys (last wins) and ignores non-mapping YAML', () => {
    expect(parseFrontmatter('---\nname: a\nname: b\n---\n').data).toEqual({ name: 'b' });
    expect(parseFrontmatter('---\n- a\n- b\n---\n').data).toEqual({});
  });

  it('falls back per key when a value is invalid YAML', () => {
    const r = parseFrontmatter(
      [
        '---',
        '# leading comment',
        'name: verifier',
        'description: Use when... Examples: <example>Context: x</example>',
        '  more: text',
        '  # comment line',
        'quoted: "a: b" c: d',
        'flag: true',
        'off: false: no',
        "single: 'x: y' z: w",
        'tools: [Read, Grep]',
        '---',
        'Body',
      ].join('\n'),
    );
    expect(r.data).toEqual({
      name: 'verifier',
      description: 'Use when... Examples: <example>Context: x</example> more: text',
      quoted: '"a: b" c: d',
      flag: true,
      off: 'false: no',
      single: "'x: y' z: w",
      tools: ['Read', 'Grep'],
    });
    expect(r.body).toBe('Body');
  });

  it('unquotes and coerces raw fallback values', () => {
    const data = parseFrontmatterYaml('a: x: y\nd: |\n  text\n x: y: z\ne: >\n  more\n y: z: w\n');
    expect(data).toEqual({ a: 'x: y', d: 'text x: y: z', e: 'more y: z: w' });
    expect(parseFrontmatterYaml("a: 'x: y'\nb: [\nc: 1").a).toBe('x: y');
    expect(parseFrontmatterYaml('a: [\nb: false\n').b).toBe(false);
    expect(parseFrontmatterYaml('a: [\nb: "false"\n').b).toBe('false');
  });

  it('keeps the literal text of numeric versions', () => {
    const r = parseFrontmatter(
      '---\nversion: 1.10\nmetadata:\n  version: 2.0\n  author: me\n---\n',
    );
    expect(r.data.version).toBe('1.10');
    expect(r.data.metadata).toEqual({ version: '2.0', author: 'me' });
    expect(parseFrontmatterYaml('{version: 3, metadata: {version: 4}}')).toEqual({
      version: '3',
      metadata: { version: '4' },
    });
  });

  it('returns {} for blank YAML', () => {
    expect(parseFrontmatterYaml('  \n')).toEqual({});
  });

  it('reads a file', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'SKILL.md');
    await write(file, '---\r\nname: x\r\n---\r\nBody\r\n');
    expect(await readFrontmatterFile(file)).toEqual({ data: { name: 'x' }, body: 'Body\n' });
  });
});

describe('normalizeBody', () => {
  it('drops leading blank lines and ends with exactly one newline', () => {
    expect(normalizeBody('\n  \r\n\t\nHello\r\n  world  \n\n\n')).toBe('Hello\n  world\n');
    expect(normalizeBody('  indented\n')).toBe('  indented\n');
    expect(normalizeBody(' \n\n')).toBe('');
  });
});

describe('withFrontmatter', () => {
  it('wraps ready YAML text and the body', () => {
    expect(withFrontmatter('a: 1', 'Body')).toBe('---\na: 1\n---\n\nBody\n');
    expect(withFrontmatter('a: 1\n', '')).toBe('---\na: 1\n---\n');
    expect(withFrontmatter('', '\nBody')).toBe('Body\n');
  });
});

describe('stringifyFrontmatter', () => {
  it('writes ---\\n<yaml>---\\n\\n<body>, drops undefined, keeps key order, round-trips', () => {
    const text = stringifyFrontmatter(
      { name: 'x', description: 'Has: colons', skip: undefined, tools: ['Read', 'Grep'] },
      'Body\n',
    );
    expect(text).toBe(
      '---\nname: x\ndescription: "Has: colons"\ntools:\n  - Read\n  - Grep\n---\n\nBody\n',
    );
    expect(parseFrontmatter(text)).toEqual({
      data: { name: 'x', description: 'Has: colons', tools: ['Read', 'Grep'] },
      body: 'Body\n',
    });
  });

  it('does not fold long lines', () => {
    const long = 'word '.repeat(40).trim();
    expect(stringifyFrontmatter({ description: long }, 'b')).toBe(
      `---\ndescription: ${long}\n---\n\nb\n`,
    );
  });

  it('is just the body when no key is defined', () => {
    expect(stringifyFrontmatter({ a: undefined }, 'Body')).toBe('Body\n');
  });
});
