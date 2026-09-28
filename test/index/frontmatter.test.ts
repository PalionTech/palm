import { describe, expect, it } from 'vitest';
import {
  parseFrontmatter,
  splitFrontmatter,
  stringifyFrontmatter,
} from '../../src/index/frontmatter.js';
import { isValidSlug, slugify, toSlug } from '../../src/index/slug.js';

describe('parseFrontmatter', () => {
  it('returns empty data and the whole text when there is no frontmatter', () => {
    expect(parseFrontmatter('# Title\n\nBody\n')).toEqual({ data: {}, body: '# Title\n\nBody\n' });
  });

  it('treats an unclosed fence as no frontmatter', () => {
    const text = '---\nname: x\n\nno closing fence';
    expect(parseFrontmatter(text)).toEqual({ data: {}, body: text });
  });

  it('parses LF frontmatter and strips blank lines before the body', () => {
    const r = parseFrontmatter('---\nname: tdd\ndescription: Test first\n---\n\n\n# TDD\n');
    expect(r.data).toEqual({ name: 'tdd', description: 'Test first' });
    expect(r.body).toBe('# TDD\n');
  });

  it('tolerates CRLF line endings and a BOM', () => {
    const r = parseFrontmatter(
      '﻿---\r\nname: tdd\r\ndescription: Test first\r\n---\r\n\r\nBody line\r\nsecond\r\n',
    );
    expect(r.data).toEqual({ name: 'tdd', description: 'Test first' });
    expect(r.body).toBe('Body line\nsecond\n');
  });

  it('handles folded and literal block strings', () => {
    const r = parseFrontmatter(
      '---\ndescription: >\n  Use when implementing\n  any feature.\nnotes: |\n  line one\n  line two\n---\nbody',
    );
    expect(r.data.description).toBe('Use when implementing any feature.\n');
    expect(r.data.notes).toBe('line one\nline two\n');
  });

  it('falls back per key when a value is invalid YAML (unquoted colons)', () => {
    const r = parseFrontmatter(
      '---\nname: verifier\ndescription: Use this agent when... Examples: <example>Context: x</example>\ntools: [Read, Grep]\nmodel: sonnet\n---\nBody',
    );
    expect(r.data).toEqual({
      name: 'verifier',
      description: 'Use this agent when... Examples: <example>Context: x</example>',
      tools: ['Read', 'Grep'],
      model: 'sonnet',
    });
    expect(r.body).toBe('Body');
  });

  it('keeps the literal text of numeric versions', () => {
    const r = parseFrontmatter(
      '---\nversion: 1.10\nmetadata:\n  version: 2.0\n  author: me\n---\n',
    );
    expect(r.data.version).toBe('1.10');
    expect(r.data.metadata).toEqual({ version: '2.0', author: 'me' });
  });

  it('accepts duplicate keys (last wins)', () => {
    expect(parseFrontmatter('---\nname: a\nname: b\n---\n').data).toEqual({ name: 'b' });
  });

  it('handles empty frontmatter', () => {
    const s = splitFrontmatter('---\n---\nbody');
    expect(s.hasFrontmatter).toBe(true);
    expect(parseFrontmatter('---\n---\nbody')).toEqual({ data: {}, body: 'body' });
  });
});

describe('stringifyFrontmatter', () => {
  it('writes ---\\n<yaml>---\\n\\n<body> and round-trips', () => {
    const text = stringifyFrontmatter(
      { name: 'x', description: 'Has: colons', tools: ['Read', 'Grep'], skip: undefined },
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
});

describe('slugs', () => {
  it.each([
    ['tdd', true],
    ['grill-me', true],
    ['a1-b2', true],
    ['Poteto Mode', false],
    ['-lead', false],
    ['trail-', false],
    ['double--hyphen', false],
    ['under_score', false],
    ['x'.repeat(65), false],
    ['', false],
  ])('isValidSlug(%j) = %s', (s, ok) => {
    expect(isValidSlug(s)).toBe(ok);
  });

  it.each([
    ['Comment Sicko', 'comment-sicko'],
    ['C# Expert', 'c-expert'],
    ['CSharpExpert', 'c-sharp-expert'],
    ['Thinking-Beast-Mode', 'thinking-beast-mode'],
    ['Deploy To Vercel', 'deploy-to-vercel'],
    ['café_crème', 'cafe-creme'],
    ['!!!', ''],
  ])('slugify(%j) = %j', (input, out) => {
    expect(slugify(input)).toBe(out);
  });

  it('truncates to 64 characters without a trailing hyphen', () => {
    const s = slugify(`${'a'.repeat(63)} b`);
    expect(s.length).toBeLessThanOrEqual(64);
    expect(isValidSlug(s)).toBe(true);
  });

  it('toSlug falls back through candidates', () => {
    expect(toSlug('!!!', 'Dir Name')).toBe('dir-name');
    expect(toSlug(undefined, undefined)).toBe('unnamed');
  });
});
