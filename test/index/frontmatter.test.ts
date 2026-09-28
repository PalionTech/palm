import { describe, expect, it } from 'vitest';
import { toSlug } from '../../src/index/util.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';

describe('parseFrontmatter (scanner inputs)', () => {
  it('handles folded and literal block strings', () => {
    const r = parseFrontmatter(
      '---\ndescription: >\n  Use when implementing\n  any feature.\nnotes: |\n  line one\n  line two\n---\nbody',
    );
    expect(r.data.description).toBe('Use when implementing any feature.\n');
    expect(r.data.notes).toBe('line one\nline two\n');
  });
});

describe('toSlug', () => {
  it('keeps a slug, slugifies otherwise and falls back through candidates', () => {
    expect(toSlug('grill-me')).toBe('grill-me');
    expect(toSlug('Deploy To Vercel')).toBe('deploy-to-vercel');
    expect(toSlug('!!!', 'Dir Name')).toBe('dir-name');
    expect(toSlug(undefined, undefined)).toBe('unnamed');
  });
});
