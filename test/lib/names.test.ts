import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ALIAS_RE,
  isSafeName,
  isSlug,
  isValidAlias,
  MAX_SLUG_LENGTH,
  SLUG_RE,
  slugify,
  stemOf,
} from '../../src/lib/names.js';

describe('isSlug', () => {
  it.each([
    ['tdd', true],
    ['grill-me', true],
    ['a1-b2', true],
    ['x'.repeat(64), true],
    ['x'.repeat(65), false],
    ['Poteto Mode', false],
    ['-lead', false],
    ['trail-', false],
    ['double--hyphen', false],
    ['under_score', false],
    ['', false],
  ])('isSlug(%j) = %s', (s, ok) => {
    expect(isSlug(s)).toBe(ok);
    if (s.length <= MAX_SLUG_LENGTH) expect(SLUG_RE.test(s)).toBe(ok);
  });
});

describe('slugify', () => {
  it.each([
    ['Comment Sicko', 'comment-sicko'],
    ['C# Expert', 'c-expert'],
    ['CSharpExpert', 'c-sharp-expert'],
    ['HTMLParser', 'html-parser'],
    ['Thinking-Beast-Mode', 'thinking-beast-mode'],
    ['camel_Case', 'camel-case'],
    ['café_crème', 'cafe-creme'],
    ['  --Hello, World!--  ', 'hello-world'],
    ['!!!', ''],
    ['', ''],
  ])('slugify(%j) = %j', (input, out) => {
    expect(slugify(input)).toBe(out);
  });

  it('truncates to 64 characters without a trailing hyphen', () => {
    const s = slugify(`${'a'.repeat(63)} b`);
    expect(s).toBe('a'.repeat(63));
    expect(slugify('b'.repeat(100))).toHaveLength(64);
  });

  it('is idempotent and returns a slug or empty (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        const once = slugify(text);
        expect(slugify(once)).toBe(once);
        expect(once === '' || isSlug(once)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('is idempotent on mixed-case words with separators (property)', () => {
    const word = fc.string({ unit: fc.constantFrom(...'aBcDeF09 _-./éÅ'), maxLength: 80 });
    fc.assert(
      fc.property(word, (text) => {
        expect(slugify(slugify(text))).toBe(slugify(text));
      }),
    );
  });
});

describe('isSafeName', () => {
  it.each([
    ['my-skill', true],
    ['My.Skill_2', true],
    ['a.b', true],
    ['0', true],
    ['', false],
    ['.', false],
    ['..', false],
    ['a..b', false],
    ['.hidden', false],
    ['-flag', false],
    ['a/b', false],
    ['a\\b', false],
    ['a\0b', false],
    ['a b', false],
  ])('isSafeName(%j) = %s', (s, ok) => {
    expect(isSafeName(s)).toBe(ok);
  });
});

describe('isValidAlias', () => {
  it.each([
    ['anthropic', true],
    ['my.org_skills-2', true],
    ['Upper', false],
    ['-x', false],
    ['.x', false],
    ['a/b', false],
    ['', false],
  ])('isValidAlias(%j) = %s', (s, ok) => {
    expect(isValidAlias(s)).toBe(ok);
    expect(ALIAS_RE.test(s)).toBe(ok);
  });
});

describe('stemOf', () => {
  const agentExts = ['.md', '.agent.md', '.chatmode.md', '.toml'];
  it.each([
    ['agents/reviewer.agent.md', agentExts, 'reviewer'],
    ['agents/Reviewer.AGENT.MD', agentExts, 'Reviewer'],
    ['agents/old.chatmode.md', agentExts, 'old'],
    ['agents/plain.md', agentExts, 'plain'],
    ['agents/codex.toml', agentExts, 'codex'],
    ['rules/style.instructions.md', ['.instructions.md', '.mdc', '.md'], 'style'],
    ['rules/cursor.mdc', ['.instructions.md', '.mdc', '.md'], 'cursor'],
    ['prompts/fix.prompt.md', ['.prompt.md', '.md', '.toml'], 'fix'],
    ['prompts/fix.txt', ['.prompt.md', '.md'], 'fix.txt'],
    ['x.md', ['', '.md'], 'x'],
    ['x.md', [], 'x.md'],
  ])('stemOf(%j) = %j', (file, exts, out) => {
    expect(stemOf(file, exts)).toBe(out);
  });
});
