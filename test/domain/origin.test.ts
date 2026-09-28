import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PalmError } from '../../src/core/errors.js';
import { hashValue } from '../../src/core/hash.js';
import type { OriginSpec } from '../../src/core/types.js';
import {
  assertAliasFormat,
  expandTilde,
  type MatchRank,
  Origin,
  OriginAliasError,
  sanitizeAlias,
  stripGit,
  trimSlashes,
  urlParts,
} from '../../src/domain/origin.js';

const HOME_DIR = join(homedir(), 'palm-origin-domain-test');
const git = (url: string, extra: Partial<OriginSpec> = {}): Origin =>
  new Origin({ alias: 'o', type: 'git', url, ...extra });
const local = (path: string, extra: Partial<OriginSpec> = {}): Origin =>
  new Origin({ alias: 'l', type: 'local', path, ...extra });

describe('string helpers', () => {
  it('trims slashes, strips .git and expands ~', () => {
    expect(trimSlashes('//a/b//')).toBe('a/b');
    expect(stripGit('repo.GIT')).toBe('repo');
    expect(stripGit('repo.github')).toBe('repo.github');
    expect(expandTilde('~')).toBe(homedir());
    expect(expandTilde('~/x/y')).toBe(join(homedir(), 'x/y'));
    expect(expandTilde('x/~')).toBe('x/~');
  });

  it.each<[string, { host: string; segs: string[] }]>([
    ['https://GitHub.com/a/b.git', { host: 'github.com', segs: ['a', 'b.git'] }],
    ['https://host/a%20b/c', { host: 'host', segs: ['a b', 'c'] }],
    [
      'git@Example.org:team/sub/repo.git',
      { host: 'example.org', segs: ['team', 'sub', 'repo.git'] },
    ],
    ['ssh://git@host:2222/a/b', { host: 'host', segs: ['a', 'b'] }],
    ['file:///srv/git/r%20x.git', { host: 'file', segs: ['srv', 'git', 'r x.git'] }],
    ['/srv/git/bare.git', { host: 'file', segs: ['srv', 'git', 'bare.git'] }],
    ['custom:///x/y', { host: 'custom', segs: ['x', 'y'] }],
    ['', { host: 'file', segs: [] }],
  ])('urlParts(%j)', (url, expected) => {
    expect(urlParts(url)).toEqual(expected);
  });
});

describe('alias rules', () => {
  it('sanitizes to the alias format', () => {
    expect(sanitizeAlias('My Origin')).toBe('my-origin');
    expect(sanitizeAlias('._-lead--')).toBe('lead');
    expect(sanitizeAlias('✓')).toBe('');
  });

  it('accepts valid aliases', () => {
    expect(() => assertAliasFormat('my.origin_2-b', 'E_USAGE')).not.toThrow();
  });

  it('throws E_USAGE (PalmError) or E_PARSE (OriginAliasError) with a suggestion', () => {
    let usage: unknown;
    try {
      assertAliasFormat('My Origin', 'E_USAGE');
    } catch (e) {
      usage = e;
    }
    expect(usage).toBeInstanceOf(PalmError);
    expect(usage).not.toBeInstanceOf(OriginAliasError);
    expect(usage).toMatchObject({
      code: 'E_USAGE',
      message: 'invalid origin alias "My Origin"',
      hint: expect.stringContaining('(e.g. `my-origin`)'),
    });
    let parse: unknown;
    try {
      assertAliasFormat('✓', 'E_PARSE', 'config.yaml');
    } catch (e) {
      parse = e;
    }
    expect(parse).toBeInstanceOf(OriginAliasError);
    expect(parse).toMatchObject({
      code: 'E_PARSE',
      message: 'config.yaml: invalid origin alias "✓"',
      hint: expect.not.stringContaining('e.g.'),
    });
  });
});

describe('Origin', () => {
  it('wraps a spec', () => {
    const o = git('https://github.com/a/b.git');
    expect(Origin.of(o)).toBe(o);
    expect(Origin.of(o.spec)).not.toBe(o);
    expect(Origin.of(o.spec).spec).toBe(o.spec);
    expect([o.alias, o.isGit, o.isLocal]).toEqual(['o', true, false]);
    expect([local('/x').isLocal, local('/x').isGit]).toEqual([true, false]);
  });

  it('derives the cache id from url + root (git) or path + root + hash (local), never the alias', () => {
    expect(git('https://github.com/Mattpocock/skills.git').id).toBe(
      'github.com__mattpocock__skills',
    );
    expect(git('git@github.com:cursor/plugins.git', { root: '/pstack/' }).id).toBe(
      'github.com__cursor__plugins__pstack',
    );
    expect(git('https://host/a b/c+d').id).toBe('host__a-b__c-d');
    expect(git('https://github.com/a/b.git', { alias: 'x' }).id).toBe(
      git('https://github.com/a/b.git', { alias: 'y', ref: 'v1' }).id,
    );
    const id = local('/Users/Max/My Skills', { root: 'sub' }).id;
    expect(id).toMatch(/^local__users__max__my-skills__sub-[0-9a-f]{8}$/);
    expect(local('/x/a/b').id).not.toBe(local('/x/a-b').id);
    expect(local('/x/a', { root: 'b' }).id).not.toBe(local('/x/a/b').id);
    expect(new Origin({ alias: 'n', type: 'git' }).id).toBe('file');
    expect(new Origin({ alias: 'n', type: 'local' }).id).toMatch(/^local-[0-9a-f]{8}$/);
  });

  it('describes itself for tables', () => {
    expect(local('/srv/mine').describe()).toBe('/srv/mine');
    expect(git('https://github.com/a/b.git').describe()).toBe('https://github.com/a/b.git');
    expect(git('https://github.com/a/b.git', { root: 'x/y' }).describe()).toBe(
      'https://github.com/a/b.git (x/y)',
    );
    expect(new Origin({ alias: 'n', type: 'local' }).describe()).toBe('');
    expect(new Origin({ alias: 'n', type: 'git' }).describe()).toBe('');
  });

  it('splits owner and repo', () => {
    expect(git('https://github.com/obra/superpowers.git').repoParts()).toEqual({
      owner: 'obra',
      repo: 'superpowers',
    });
    expect(git('https://host/solo').repoParts()).toEqual({ owner: undefined, repo: 'solo' });
    expect(new Origin({ alias: 'n', type: 'git' }).repoParts()).toEqual({
      owner: undefined,
      repo: 'origin',
    });
    expect(local('/code/my-skills').repoParts()).toEqual({ owner: 'code', repo: 'my-skills' });
    expect(local('/top').repoParts()).toEqual({ owner: undefined, repo: 'top' });
    expect(local('/').repoParts()).toEqual({ owner: undefined, repo: 'local' });
  });

  it('compares sources: url (case, .git and trailing slash aside) or resolved path', () => {
    const a = git('https://github.com/obra/superpowers.git');
    expect(a.sameSource(git('https://github.com/Obra/SuperPowers/', { ref: 'v2' }))).toBe(true);
    expect(a.sameSource(git('https://github.com/obra/superpowers.git', { root: 'x' }))).toBe(true);
    expect(a.sameSource(git('git@github.com:obra/superpowers.git'))).toBe(false);
    expect(a.sameSource(git('https://github.com/evil/superpowers.git'))).toBe(false);
    expect(a.sameSource(local('/srv/superpowers'))).toBe(false);
    expect(local('/srv/a/../b').sameSource(local('/srv/b'))).toBe(true);
    expect(local('/srv/a').sameSource(local('/srv/b'))).toBe(false);
    expect(new Origin({ alias: 'n', type: 'git' }).sameSource(git(''))).toBe(true);
    expect(new Origin({ alias: 'n', type: 'local' }).sameSource(local(''))).toBe(true);
  });

  const superpowers = git('https://github.com/obra/superpowers.git', { alias: 'superpowers' });
  const pstack = git('https://github.com/cursor/plugins.git', { alias: 'pstack', root: 'pstack' });
  const tools = git('git@gitlab.example.com:team/sub/tools.git', { alias: 'tools' });
  const mine = local(join(HOME_DIR, 'mine'), { alias: 'mine' });
  const mono = local(join(HOME_DIR, 'mono'), { alias: 'mono-web', root: 'packages/web' });
  const bare = git('/srv/git/bare.git', { alias: 'bare' });
  const bareRooted = git('/srv/git/bare.git', { alias: 'bare-docs', root: 'docs' });

  it.each<[string, Origin, string, MatchRank]>([
    ['alias', superpowers, 'SuperPowers', 3],
    ['empty', superpowers, '   ', 0],
    ['owner/repo', superpowers, 'obra/superpowers/', 2],
    ['url', superpowers, 'https://github.com/obra/superpowers', 2],
    ['owner alone', superpowers, 'obra', 0],
    ['owner/repo/root', pstack, 'Cursor/Plugins/PStack', 2],
    ['repo of a rooted origin', pstack, 'cursor/plugins', 1],
    ['url of a rooted origin', pstack, 'https://github.com/cursor/plugins.git', 1],
    ['other root', pstack, 'cursor/plugins/other', 0],
    ['scp: full path', tools, 'team/sub/tools', 2],
    ['scp: last two', tools, 'sub/tools', 2],
    ['scp itself', tools, 'git@gitlab.example.com:team/sub/tools.git', 2],
    ['local path', mine, `${join(HOME_DIR, 'mine')}/`, 2],
    ['local ~ path', mine, '~/palm-origin-domain-test/mine', 2],
    ['local relative path', mine, 'palm-origin-domain-test/mine', 0],
    ['local other path', mine, join(HOME_DIR, 'other'), 0],
    ['local + root', mono, '~/palm-origin-domain-test/mono/packages/web', 2],
    ['local dir of a rooted origin', mono, join(HOME_DIR, 'mono'), 1],
    ['local ~ alone', mine, '~', 0],
    ['bare repo path', bare, '/srv/git/bare.git', 2],
    ['bare repo: no owner/repo form', bare, 'git/bare', 0],
    ['bare repo + root', bareRooted, '/srv/git/bare.git/docs', 2],
    ['bare repo dir of a rooted origin', bareRooted, '/srv/git/bare.git', 1],
  ])('matchRank %s: %j', (_label, origin, query, rank) => {
    expect(origin.matchRank(query)).toBe(rank);
    expect(origin.matches(query)).toBe(rank > 0);
  });

  it('names index files by id, git ref and layout hash', () => {
    const cache = '/c';
    expect(git('https://github.com/a/b.git').indexFile(cache)).toBe(
      '/c/github.com__a__b.index.json',
    );
    expect(git('https://github.com/a/b.git', { ref: 'feat/x' }).indexFile(cache)).toBe(
      '/c/github.com__a__b@feat-x.index.json',
    );
    expect(git('https://github.com/a/b.git', { ref: 'v1' }).indexFile(cache, 'v2')).toBe(
      '/c/github.com__a__b@v2.index.json',
    );
    const layout = { skills: ['s/*'], nameFrom: 'dirname' as const };
    const hash = hashValue(layout)
      .replace(/^sha256:/, '')
      .slice(0, 8);
    expect(git('https://github.com/a/b.git', { layout }).indexFile(cache)).toBe(
      `/c/github.com__a__b~${hash}.index.json`,
    );
    const loc = local('/srv/x', { ref: 'ignored' });
    expect(loc.indexFile(cache)).toBe(`/c/${loc.id}.index.json`);
    expect(loc.indexFile(cache, 'v1')).toBe(`/c/${loc.id}.index.json`);
  });

  it('puts each requested ref in its own checkout slot, shared by aliases', () => {
    const latest = git('https://github.com/a/b.git').checkoutSlot('/c');
    expect(latest).toEqual({
      dir: '/c/github.com__a__b',
      name: 'repo',
      repoDir: '/c/github.com__a__b/repo',
      metaFile: '/c/github.com__a__b/checkout.json',
      lockFile: '/c/github.com__a__b/repo.lock',
    });
    const pinned = git('git@github.com:a/b.git', { alias: 'other', ref: 'release/1.x' });
    expect(pinned.checkoutSlot('/c')).toEqual({
      dir: '/c/github.com__a__b',
      name: 'ref-release-1.x',
      repoDir: '/c/github.com__a__b/ref-release-1.x',
      metaFile: '/c/github.com__a__b/checkout-ref-release-1.x.json',
      lockFile: '/c/github.com__a__b/ref-release-1.x.lock',
    });
  });
});
