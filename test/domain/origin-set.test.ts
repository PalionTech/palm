import { describe, expect, it } from 'vitest';
import type { OriginSpec } from '../../src/core/types.js';
import { Origin } from '../../src/domain/origin.js';
import { OriginSet } from '../../src/domain/origin-set.js';

const gh = (alias: string, repo: string, extra: Partial<OriginSpec> = {}): OriginSpec => ({
  alias,
  type: 'git',
  url: `https://github.com/${repo}.git`,
  ...extra,
});

const superpowers = gh('superpowers', 'obra/superpowers');
const spNext = gh('sp-next', 'obra/superpowers', { ref: 'next' });
const cursor = gh('cursor', 'cursor/plugins');
const pstack = gh('pstack', 'cursor/plugins', { root: 'pstack' });
const curated = gh('curated', 'openai/skills', { root: 'skills/.curated' });
const experimental = gh('experimental', 'openai/skills', { root: 'skills/.experimental' });
const mine: OriginSpec = { alias: 'mine', type: 'local', path: '/srv/mine' };

const user = OriginSet.of([superpowers, spNext, cursor, pstack, curated, experimental, mine]);

describe('OriginSet: layers and lookup', () => {
  it('starts empty', () => {
    const empty = OriginSet.of();
    expect(empty.size).toBe(0);
    expect(empty.all()).toEqual([]);
    expect(empty.aliases()).toEqual([]);
  });

  it('keeps user order, appends project-only aliases, and lets the project win a clash in place', () => {
    const fork = gh('fork', 'acme/superpowers-fork');
    const pinned = gh('cursor', 'cursor/plugins', { ref: 'v2' });
    const set = user.withProject([fork, pinned]);
    expect(set.aliases()).toEqual([
      'superpowers',
      'sp-next',
      'cursor',
      'pstack',
      'curated',
      'experimental',
      'mine',
      'fork',
    ]);
    expect(set.size).toBe(8);
    expect(set.byAlias('CURSOR')?.spec).toBe(pinned);
    expect(set.specs()[2]).toBe(pinned);
    expect(set.userSpecs()).toHaveLength(7);
    expect(set.userSpecs()[2]).toBe(cursor);
    expect(set.projectSpecs()).toEqual([fork, pinned]);
    expect(set.all().every((o) => o instanceof Origin)).toBe(true);
    expect(set.byAlias('nope')).toBeUndefined();
    // withProject replaces the project layer rather than adding to it
    expect(set.withProject([]).aliases()).toEqual(user.aliases());
  });

  it('accepts Origin instances as well as specs', () => {
    const o = new Origin(superpowers);
    expect(OriginSet.of([o]).byAlias('superpowers')).toBe(o);
  });
});

describe('OriginSet.resolveQuery', () => {
  const set = user.withProject([gh('fork', 'acme/superpowers-fork')]);

  it.each<[string, string, string]>([
    ['alias', 'superpowers', 'superpowers'],
    ['alias beats a repository match', 'SP-NEXT', 'sp-next'],
    ['exact owner/repo/root beats repo-only matches', 'cursor/plugins/pstack', 'pstack'],
    ['the root-less origin beats rooted ones', 'cursor/plugins', 'cursor'],
    ['url: the root-less origin beats rooted ones', 'https://github.com/cursor/plugins', 'cursor'],
    ['nested root', 'openai/skills/skills/.curated', 'curated'],
    ['local path', '/srv/mine/', 'mine'],
    ['project origin', 'acme/superpowers-fork', 'fork'],
  ])('%s: %j → %s', (_label, query, alias) => {
    expect(set.resolveQuery(query).alias).toBe(alias);
  });

  it('is ambiguous when several origins match equally well', () => {
    expect(() => set.resolveQuery('obra/superpowers')).toThrow(
      expect.objectContaining({
        code: 'E_AMBIGUOUS',
        message:
          '"obra/superpowers" matches 2 origins: superpowers (https://github.com/obra/superpowers.git), sp-next (https://github.com/obra/superpowers.git)',
        hint: 'Use the alias instead, e.g. -o superpowers.',
      }),
    );
    expect(() => set.resolveQuery('openai/skills')).toThrow(
      expect.objectContaining({
        code: 'E_AMBIGUOUS',
        message: expect.stringMatching(/curated \(.*\(skills\/\.curated\)\), experimental/),
      }),
    );
  });

  it('lists the sorted aliases when nothing matches', () => {
    expect(() => set.resolveQuery('nobody/nothing')).toThrow(
      expect.objectContaining({
        code: 'E_NOT_FOUND',
        message: 'No origin matches "nobody/nothing"',
        hint: 'Registered origins: curated, cursor, experimental, fork, mine, pstack, sp-next, superpowers. Use an alias, owner/repo[/root], the URL or the local path.',
      }),
    );
    expect(() => OriginSet.of().resolveQuery('x')).toThrow(
      expect.objectContaining({
        code: 'E_NOT_FOUND',
        hint: 'No origins are registered; add one with `palm install origin owner/repo`.',
      }),
    );
  });
});

describe('OriginSet.conflicts', () => {
  it('lists project aliases that point a user alias at another repository or directory', () => {
    const evil = gh('superpowers', 'evil/superpowers');
    const sameRepoPinned = gh('cursor', 'cursor/plugins', { ref: 'v1', root: 'x' });
    const otherDir: OriginSpec = { alias: 'mine', type: 'local', path: '/tmp/elsewhere' };
    const projectOnly = gh('fork', 'acme/fork');
    const set = user.withProject([evil, sameRepoPinned, otherDir, projectOnly]);
    const conflicts = set.conflicts();
    expect(conflicts.map((c) => [c.alias, c.user.spec, c.project.spec])).toEqual([
      ['superpowers', superpowers, evil],
      ['mine', mine, otherDir],
    ]);
    expect(user.conflicts()).toEqual([]);
    // today's precedence is unchanged: the project origin still wins
    expect(set.byAlias('superpowers')?.spec).toBe(evil);
  });
});

describe('OriginSet.add / without', () => {
  it('adds to the user layer by default and to the project layer on request', () => {
    const tools = gh('tools', 'acme/tools');
    const added = user.add(tools);
    expect(added.userSpecs().at(-1)).toBe(tools);
    expect(user.byAlias('tools')).toBeUndefined(); // immutable
    const proj = user.add(tools, 'project');
    expect(proj.projectSpecs()).toEqual([tools]);
    expect(proj.userSpecs()).toEqual(user.userSpecs());
  });

  it('replaces an origin with the same id in place (e.g. a new ref)', () => {
    const pinned = { ...superpowers, ref: 'v5' };
    const next = user.add(pinned);
    expect(next.aliases()).toEqual(user.aliases());
    expect(next.byAlias('superpowers')?.spec.ref).toBe('v5');
    // a project copy of a user origin (same id) is fine too
    expect(user.add(pinned, 'project').byAlias('superpowers')?.spec).toBe(pinned);
  });

  it('refuses an alias another origin uses (E_CONFLICT) and invalid aliases (E_USAGE)', () => {
    expect(() => user.add(gh('SuperPowers', 'acme/other'))).toThrow(
      expect.objectContaining({ code: 'E_USAGE' }),
    );
    expect(() => user.add(gh('superpowers', 'acme/other'), 'project')).toThrow(
      expect.objectContaining({
        code: 'E_CONFLICT',
        message:
          'Origin alias "superpowers" is already used by https://github.com/obra/superpowers.git',
        hint: expect.stringContaining('--alias <name>'),
      }),
    );
    expect(() => user.add({ alias: 'mine', type: 'local', path: '/other' })).toThrow(
      expect.objectContaining({ code: 'E_CONFLICT' }),
    );
  });

  it('removes an alias from both layers, case-insensitively', () => {
    const set = user.withProject([gh('superpowers', 'obra/superpowers', { ref: 'v1' })]);
    const next = set.without('SuperPowers');
    expect(next.byAlias('superpowers')).toBeUndefined();
    expect(next.userSpecs()).toHaveLength(6);
    expect(next.projectSpecs()).toEqual([]);
    expect(set.without('nope').aliases()).toEqual(set.aliases());
  });
});
