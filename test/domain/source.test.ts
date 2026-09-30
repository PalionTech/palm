import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Source } from '../../src/core/types.js';
import { Manifest } from '../../src/domain/manifest.js';
import {
  normalizeSource,
  SourceRef,
  SourceSet,
  sourceNameKind,
  toManifestSource,
} from '../../src/domain/source.js';
import { validateSourceUrl } from '../../src/domain/source-url.js';

const BASE = '/work/project';
const W = 'palm.yaml';

describe('sourceNameKind', () => {
  it.each([
    ['mattpocock/skills', 'github'],
    ['obra/superpowers', 'github'],
    ['./agent-kit', 'local'],
    ['../shared', 'local'],
    ['/abs/kit', 'local'],
    ['.', 'local'],
    ['acme-kit', 'named'],
    ['a/b/c', 'github'],
  ])('%s → %s', (key, kind) => {
    expect(sourceNameKind(key)).toBe(kind);
  });
});

describe('normalizeSource', () => {
  it('reads owner/repo as GitHub, a path key as local, a named key with url or path', () => {
    expect(normalizeSource('mattpocock/skills', { ref: 'v1.2.3' }, BASE, W)).toEqual({
      name: 'mattpocock/skills',
      type: 'git',
      url: 'https://github.com/mattpocock/skills.git',
      ref: 'v1.2.3',
    });
    expect(normalizeSource('./agent-kit', {}, BASE, W)).toEqual({
      name: './agent-kit',
      type: 'local',
      path: '/work/project/agent-kit',
    });
    expect(
      normalizeSource(
        'acme-kit',
        {
          url: 'https://gitlab.acme.com/platform/agent-kit.git',
          root: 'kit/',
          alias: 'kit',
          layout: { agents: ['people/*.md'] },
        },
        BASE,
        W,
      ),
    ).toEqual({
      name: 'acme-kit',
      type: 'git',
      url: 'https://gitlab.acme.com/platform/agent-kit.git',
      root: 'kit',
      alias: 'kit',
      layout: { agents: ['people/*.md'] },
    });
    expect(normalizeSource('tools', { path: '~/tools' }, BASE, W)).toMatchObject({
      type: 'local',
      path: join(homedir(), 'tools'),
    });
    expect(
      normalizeSource('owner/repo', { url: 'git@github.com:owner/repo.git' }, BASE, W),
    ).toMatchObject({
      url: 'git@github.com:owner/repo.git',
    });
  });

  it('refuses what palm.yaml cannot mean, naming where', () => {
    const cases: Array<[string, unknown]> = [
      ['acme-kit', {}],
      ['acme-kit', { url: 'x', path: './y' }],
      ['./kit', { ref: 'v1' }],
      ['a/b', { alias: 'Not Valid' }],
      ['a/b', { ref: '--upload-pack=x' }],
      ['a/b', { root: '../outside' }],
      ['a/b', { layout: 'skills/*' }],
      ['a/b', 'not a mapping'],
    ];
    for (const [name, raw] of cases) {
      expect(() => normalizeSource(name, raw as never, BASE, W), JSON.stringify(raw)).toThrowError(
        expect.objectContaining({ code: 'E_PARSE', message: expect.stringContaining('palm.yaml') }),
      );
    }
    expect(() => normalizeSource('evil', { url: '--upload-pack=touch x' }, BASE, W)).toThrowError(
      expect.objectContaining({ code: 'E_SOURCE' }),
    );
  });
});

describe('a GitHub subdirectory source (ruling 20)', () => {
  it('owner/repo/sub/dir names the repository and its root, and palm.yaml repeats neither', () => {
    const s = normalizeSource('cursor/plugins/pstack/sub', { ref: 'main' }, BASE, 'palm.yaml');
    expect(s).toEqual({
      name: 'cursor/plugins/pstack/sub',
      type: 'git',
      url: 'https://github.com/cursor/plugins.git',
      root: 'pstack/sub',
      ref: 'main',
    });
    expect(toManifestSource(s, BASE)).toEqual({ ref: 'main' });
    expect(toManifestSource({ ...s, root: 'other' }, BASE)).toMatchObject({
      url: 'https://github.com/cursor/plugins.git',
      root: 'other',
    });
  });
});

describe('toManifestSource', () => {
  it('writes the location only where the name does not already say it, in a fixed order', () => {
    const gh: Source = {
      name: 'obra/superpowers',
      type: 'git',
      url: 'https://github.com/obra/superpowers.git',
      ref: '^4',
      alias: 'sp',
    };
    expect(Object.entries(toManifestSource(gh, BASE))).toEqual([
      ['ref', '^4'],
      ['alias', 'sp'],
    ]);
    const named: Source = {
      name: 'acme',
      type: 'git',
      url: 'https://gitlab.acme.com/a.git',
      root: 'kit',
      ref: '^1',
    };
    expect(Object.keys(toManifestSource(named, BASE))).toEqual(['url', 'root', 'ref']);
    const local: Source = { name: './agent-kit', type: 'local', path: '/work/project/agent-kit' };
    expect(toManifestSource(local, BASE)).toEqual({});
    const moved: Source = { name: 'kit', type: 'local', path: '/work/project/tools/kit' };
    expect(toManifestSource(moved, BASE)).toEqual({ path: './tools/kit' });
  });

  it('round-trips through normalizeSource', () => {
    const sources: Source[] = [
      {
        name: 'obra/superpowers',
        type: 'git',
        url: 'https://github.com/obra/superpowers.git',
        ref: '^4',
      },
      { name: 'acme', type: 'git', url: 'ssh://git@host/acme/kit.git', root: 'kit' },
      { name: './agent-kit', type: 'local', path: '/work/project/agent-kit' },
      { name: 'shared', type: 'local', path: '/work/shared', alias: 'sh' },
    ];
    for (const s of sources)
      expect(normalizeSource(s.name, toManifestSource(s, BASE), BASE, W)).toEqual(s);
  });
});

describe('SourceRef', () => {
  const gh = new SourceRef({
    name: 'cursor/plugins',
    type: 'git',
    url: 'https://github.com/cursor/plugins.git',
    root: 'pstack',
    alias: 'ps',
  });

  it('derives cache id, asset dir, index file and checkout dir from the location, never the name', () => {
    expect(gh.id).toBe('github.com__cursor__plugins__pstack');
    expect(gh.assetDir).toBe('cursor__plugins');
    expect(gh.checkoutDir('/c', 'abc')).toBe('/c/github.com__cursor__plugins__pstack/sha-abc');
    expect(gh.indexFile('/c', '0123456789abcdef')).toBe(
      '/c/github.com__cursor__plugins__pstack@01234567.index.json',
    );
    expect(gh.indexFile('/c', 'sha256:fedcba9876')).toMatch(/@fedcba98\.index\.json$/);
    const renamed = new SourceRef({ ...gh.source, name: 'other' });
    expect(renamed.id).toBe(gh.id);
    const layout = new SourceRef({ ...gh.source, layout: { skills: ['x/*'] } });
    expect(layout.indexFile('/c', 'abcdef12')).toMatch(/@abcdef12~[0-9a-f]{8}\.index\.json$/);
    expect(new SourceRef({ name: './kit', type: 'local', path: '/tmp/x/kit' }).id).toMatch(
      /^local__kit-[0-9a-f]{8}$/,
    );
  });

  it('matches its name, alias, owner/repo[/root], URL and path', () => {
    for (const q of [
      'cursor/plugins',
      'PS',
      'cursor/plugins/pstack',
      'https://github.com/cursor/plugins',
    ])
      expect(gh.matches(q), q).toBe(true);
    expect(gh.matchRank('cursor/plugins/pstack')).toBe(2);
    expect(gh.matchRank('https://github.com/cursor/plugins.git')).toBe(1);
    expect(gh.matches('cursor')).toBe(false);
    const local = new SourceRef({ name: './kit', type: 'local', path: '/tmp/x/kit' });
    expect(local.matches('/tmp/x/kit')).toBe(true);
    expect(local.describe()).toBe('/tmp/x/kit');
    expect(gh.describe()).toBe('https://github.com/cursor/plugins.git (pstack)');
  });

  it('sameLocation ignores URL case, .git and trailing slash, not the root', () => {
    const a = new SourceRef({ name: 'a', type: 'git', url: 'https://GitHub.com/x/y.git' });
    expect(
      a.sameLocation(new SourceRef({ name: 'b', type: 'git', url: 'https://github.com/x/y/' })),
    ).toBe(true);
    expect(
      a.sameLocation(
        new SourceRef({ name: 'b', type: 'git', url: 'https://github.com/x/y', root: 'r' }),
      ),
    ).toBe(false);
  });
});

describe('SourceSet', () => {
  const s = (name: string, extra: Partial<Source> = {}): Source => ({
    name,
    type: 'git',
    url: `https://github.com/${name.includes('/') ? name : `x/${name}`}.git`,
    ...extra,
  });

  it('rejects duplicate names and aliases, case-insensitively, naming both', () => {
    expect(() => SourceSet.of([s('a/kit'), s('A/Kit', { url: 'https://h/o.git' })])).toThrowError(
      expect.objectContaining({
        code: 'E_PARSE',
        message: expect.stringMatching(/"a\/kit" and "A\/Kit"/),
      }),
    );
    expect(() => SourceSet.of([s('kit'), s('acme', { alias: 'KIT' })])).toThrowError(
      expect.objectContaining({ code: 'E_PARSE' }),
    );
    expect(() => SourceSet.of([s('one', { alias: 'k' }), s('two', { alias: 'k' })])).toThrowError(
      expect.objectContaining({ code: 'E_PARSE' }),
    );
    expect(SourceSet.of([s('one', { alias: 'o' }), s('two')]).size).toBe(2);
  });

  it('builds from a manifest and finds by name or alias in any case', () => {
    const m = Manifest.of({
      sources: {
        'mattpocock/skills': { skills: ['tdd'] },
        acme: { url: 'https://h/a.git', alias: 'kit', agents: ['r'] },
      },
    });
    const set = SourceSet.fromManifest(m, BASE, W);
    expect(set.names()).toEqual(['mattpocock/skills', 'acme']);
    expect(set.byName('KIT')?.name).toBe('acme');
    expect(set.byName('MattPocock/Skills')?.name).toBe('mattpocock/skills');
    expect(set.byName('nope')).toBeUndefined();
  });

  it('resolveQuery: name or alias beats location; nothing is E_NOT_FOUND; a tie is E_AMBIGUOUS', () => {
    const set = SourceSet.of([
      s('cursor/plugins', { root: 'a' }),
      s('b-plugins', { url: 'https://github.com/cursor/plugins.git', root: 'b' }),
    ]);
    expect(set.resolveQuery('b-plugins').name).toBe('b-plugins');
    expect(set.resolveQuery('cursor/plugins/b').name).toBe('b-plugins');
    expect(() => set.resolveQuery('https://github.com/cursor/plugins')).toThrowError(
      expect.objectContaining({ code: 'E_AMBIGUOUS' }),
    );
    expect(() => set.resolveQuery('zzz')).toThrowError(
      expect.objectContaining({ code: 'E_NOT_FOUND', hint: 'palm get sources' }),
    );
  });

  it('add replaces the source of that name and location, keeps a second name for one location (Z2), and refuses a taken name', () => {
    const set = SourceSet.of([s('acme', { url: 'https://h/acme.git' }), s('other')]);
    const moved = set.add({ name: 'ACME', type: 'git', url: 'https://h/acme', ref: 'v2' });
    expect(moved.names()).toEqual(['ACME', 'other']);
    const second = set.add({ name: 'kit', type: 'git', url: 'https://h/acme', ref: 'v2' });
    expect(second.names()).toEqual(['acme', 'other', 'kit']);
    const renamed = set.without('acme').add({ name: 'kit', type: 'git', url: 'https://h/acme' });
    expect(renamed.names()).toEqual(['other', 'kit']);
    expect(() => set.add({ name: 'OTHER', type: 'git', url: 'https://h/new.git' })).toThrowError(
      expect.objectContaining({ code: 'E_CONFLICT' }),
    );
    expect(set.without('ACME').names()).toEqual(['other']);
  });
});

describe('validateSourceUrl', () => {
  it('accepts https, ssh, scp-like, file:// and absolute paths; warns for http and git://', () => {
    for (const ok of [
      'https://github.com/a/b.git',
      'ssh://git@host/a/b.git',
      'git@github.com:a/b.git',
      'file:///tmp/r.git',
      '/srv/repos/r.git',
    ])
      expect(validateSourceUrl(ok)).toEqual({});
    expect(validateSourceUrl('http://host/a/b.git').warning).toMatch(/unencrypted/);
    expect(validateSourceUrl('git://host/a/b.git').warning).toMatch(/unencrypted/);
  });

  it('refuses option-looking values, transport helpers, odd schemes and control characters', () => {
    for (const bad of [
      '--upload-pack=touch /tmp/pwned;true',
      '-oProxyCommand=sh',
      'ext::sh -c touch% /tmp/pwned',
      'fd::17',
      'file::/etc',
      'ftp://host/r.git',
      'ssh://-oProxyCommand=x/r',
      'git@-host:r.git',
      'https://host/r.git\nx',
      'relative/path.git',
    ]) {
      expect(() => validateSourceUrl(bad), bad).toThrowError(
        expect.objectContaining({ code: 'E_SOURCE', message: expect.stringMatching(/^refusing/) }),
      );
    }
  });
});
