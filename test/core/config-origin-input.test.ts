import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveAlias, parseOriginInput, validateOriginUrl } from '../../src/core/origin-input.js';
import type { OriginSpec } from '../../src/core/types.js';
import { ALIAS_RE } from '../../src/lib/names.js';
import { removeDir, tempDir } from '../support/sandbox.js';

let dir: string;
beforeAll(async () => {
  dir = await tempDir();
  await mkdir(join(dir, 'my-skills'), { recursive: true });
  await mkdir(join(dir, 'with#hash'), { recursive: true });
  // a bare repository: HEAD + objects/, no .git
  await mkdir(join(dir, 'bare.git', 'objects'), { recursive: true });
  await writeFile(join(dir, 'bare.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(dir, 'file.json'), '{}');
});
afterAll(async () => removeDir(dir));

describe('parseOriginInput: one row per matcher', () => {
  it.each<[string, string, Partial<OriginSpec>]>([
    // shorthand
    [
      'shorthand',
      'obra/superpowers',
      { type: 'git', url: 'https://github.com/obra/superpowers.git', alias: 'superpowers' },
    ],
    [
      'shorthand, generic repo → owner',
      'mattpocock/skills',
      { url: 'https://github.com/mattpocock/skills.git', alias: 'mattpocock' },
    ],
    ['shorthand + ref', 'mattpocock/skills#v1.2.3', { ref: 'v1.2.3', alias: 'mattpocock' }],
    [
      'shorthand + root',
      'cursor/plugins/pstack/',
      { url: 'https://github.com/cursor/plugins.git', root: 'pstack', alias: 'pstack' },
    ],
    [
      'shorthand + nested root + ref',
      'cursor/plugins/a/b#main',
      { root: 'a/b', ref: 'main', alias: 'b' },
    ],
    [
      'shorthand + .git',
      'obra/superpowers.git',
      { url: 'https://github.com/obra/superpowers.git' },
    ],
    [
      'empty ref is dropped',
      'obra/superpowers#',
      { url: 'https://github.com/obra/superpowers.git' },
    ],
    // prefixed
    [
      'github:',
      'github:obra/superpowers',
      { url: 'https://github.com/obra/superpowers.git', alias: 'superpowers' },
    ],
    [
      'github: + root + ref',
      'GitHub:/cursor/plugins/pstack/#v1',
      { url: 'https://github.com/cursor/plugins.git', root: 'pstack', ref: 'v1' },
    ],
    [
      'gitlab:',
      'gitlab:group/sub/repo.git#dev',
      { url: 'https://gitlab.com/group/sub/repo.git', ref: 'dev', alias: 'repo' },
    ],
    // URLs
    [
      'github https',
      'https://github.com/obra/superpowers',
      { url: 'https://github.com/obra/superpowers.git' },
    ],
    [
      'github https + .git + ref',
      'https://www.github.com/obra/superpowers.git#v2',
      { url: 'https://github.com/obra/superpowers.git', ref: 'v2' },
    ],
    [
      'github tree url',
      'https://github.com/openai/skills/tree/main/skills/.curated',
      {
        url: 'https://github.com/openai/skills.git',
        ref: 'main',
        root: 'skills/.curated',
        alias: 'curated',
      },
    ],
    [
      'github blob url without dirs',
      'https://github.com/openai/skills/blob/v1',
      { url: 'https://github.com/openai/skills.git', ref: 'v1' },
    ],
    [
      'github tree url, explicit ref wins',
      'https://github.com/openai/skills/tree/main/x#v3',
      { ref: 'v3', root: 'x' },
    ],
    [
      'github url with a sub dir',
      'http://github.com/a/b/docs',
      { url: 'https://github.com/a/b.git', root: 'docs' },
    ],
    [
      'github url with a user is a plain git url',
      'https://me@github.com/a/b.git',
      { url: 'https://me@github.com/a/b.git' },
    ],
    [
      'gitlab repo url',
      'https://gitlab.com/group/sub/repo/',
      { url: 'https://gitlab.com/group/sub/repo.git', alias: 'repo' },
    ],
    [
      'gitlab tree url',
      'https://gitlab.com/group/repo/-/tree/dev/skills',
      { url: 'https://gitlab.com/group/repo.git', ref: 'dev', root: 'skills' },
    ],
    [
      'gitlab blob url, no dir',
      'https://gitlab.example.com/g/repo/-/blob/v1',
      { url: 'https://gitlab.example.com/g/repo', ref: 'v1' },
    ],
    [
      'other host',
      'ssh://git@example.com/team/tools.git',
      { url: 'ssh://git@example.com/team/tools.git', alias: 'tools' },
    ],
    [
      'file url',
      'file:///srv/git/r.git#main',
      { type: 'git', url: 'file:///srv/git/r.git', ref: 'main' },
    ],
    // scp-like
    [
      'scp github',
      'git@github.com:obra/superpowers',
      { url: 'git@github.com:obra/superpowers.git', alias: 'superpowers' },
    ],
    [
      'scp github + root + ref',
      'git@github.com:cursor/plugins.git/pstack#v1',
      { url: 'git@github.com:cursor/plugins.git', root: 'pstack', ref: 'v1' },
    ],
    [
      'scp other host',
      'git@host.example:a/B.C.git#x',
      { url: 'git@host.example:a/B.C.git', ref: 'x', alias: 'b.c' },
    ],
    ['scp github without repo', 'git@github.com:solo', { url: 'git@github.com:solo' }],
  ])('%s: %s', (_label, input, expected) => {
    expect(parseOriginInput(input, { cwd: dir })).toMatchObject(expected);
  });

  it('local directories: absolute, ./relative, ~, bare words, a bare repository, a # in the name', () => {
    expect(parseOriginInput(join(dir, 'my-skills'))).toEqual({
      alias: 'my-skills',
      type: 'local',
      path: join(dir, 'my-skills'),
    });
    expect(parseOriginInput('./my-skills', { cwd: dir })).toMatchObject({ type: 'local' });
    expect(parseOriginInput('my-skills', { cwd: dir })).toMatchObject({
      path: join(dir, 'my-skills'),
    });
    expect(parseOriginInput('with#hash', { cwd: dir })).toMatchObject({
      type: 'local',
      path: join(dir, 'with#hash'),
    });
    expect(parseOriginInput('~', { cwd: dir })).toMatchObject({ type: 'local', path: homedir() });
    expect(parseOriginInput('./bare.git', { cwd: dir })).toEqual({
      alias: 'bare',
      type: 'git',
      url: join(dir, 'bare.git'),
    });
  });

  it('applies alias/ref/root/layout options', () => {
    const layout = { skills: 'x/*' };
    expect(
      parseOriginInput('a/b#v0', { alias: 'x', ref: 'v1', root: '/sub/', layout, cwd: dir }),
    ).toEqual({
      alias: 'x',
      type: 'git',
      url: 'https://github.com/a/b.git',
      ref: 'v1',
      root: 'sub',
      layout,
    });
    expect(parseOriginInput('a/b/c', { root: '/', cwd: dir })).not.toHaveProperty('root');
  });

  it.each<[string, string, RegExp]>([
    ['empty', '   ', /Empty origin spec/],
    ['garbage', 'not a spec', /Unrecognised origin/],
    ['missing explicit path', './nope', /does not exist/],
    ['a file, not a directory', './file.json', /must be a directory/],
    ['github: without repo', 'github:solo', /needs an owner and a repository/],
    ['github url without repo', 'https://github.com/solo', /needs an owner and a repository/],
    ['unparsable url', 'https://exa mple.com/x', /Invalid origin URL/],
    ['refused scheme', 'ftp://host/r.git', /Refusing.*unsupported scheme/],
    ['option-looking host', 'ssh://-oProxyCommand=touch%20x/repo', /Refusing/],
    ['transport helper', 'ext::sh -c touch% /tmp/x', /Unrecognised|Refusing/],
    ['invalid alias', 'a/b', /invalid origin alias/],
  ])('rejects %s', (label, input, message) => {
    const opts = label === 'invalid alias' ? { alias: 'Bad Alias', cwd: dir } : { cwd: dir };
    expect(() => parseOriginInput(input, opts)).toThrow(message);
  });

  it('error codes: E_USAGE for empty input and bad aliases, E_ORIGIN otherwise', () => {
    expect(() => parseOriginInput('')).toThrow(expect.objectContaining({ code: 'E_USAGE' }));
    expect(() => parseOriginInput('a/b', { alias: '-x' })).toThrow(
      expect.objectContaining({ code: 'E_USAGE' }),
    );
    expect(() => parseOriginInput('?', { cwd: dir })).toThrow(
      expect.objectContaining({ code: 'E_ORIGIN', hint: expect.stringContaining('owner/repo') }),
    );
    expect(() => parseOriginInput('./file.json', { cwd: dir })).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('palm origin import') }),
    );
  });
});

describe('validateOriginUrl', () => {
  it.each(['https://h/a.git', 'ssh://git@h/a.git', 'git@h:a/b.git', 'file:///r.git', '/srv/r.git'])(
    'accepts %s',
    (url) => {
      expect(validateOriginUrl(url)).toEqual({});
    },
  );

  it('warns for plain-text transports, naming the place', () => {
    expect(validateOriginUrl('http://h/a.git', 'config.yaml')).toEqual({
      warning: 'config.yaml http://h/a.git uses an unencrypted transport (http://)',
    });
    expect(validateOriginUrl('GIT://h/a.git').warning).toMatch(/\(git:\/\/\)/);
  });

  it.each<[string, string]>([
    ['', 'empty or padded'],
    [' https://h/a.git', 'empty or padded'],
    ['https://h/a.git\u0000', 'contains control characters'],
    ['https://h/\u007fa.git', 'contains control characters'],
    ['--upload-pack=x', 'git would read it as an option'],
    ['ext::sh', 'git transport helpers (ext::, fd::, …) are not allowed'],
    ['my-helper::x', 'git transport helpers (ext::, fd::, …) are not allowed'],
    ['ftp://h/a.git', 'unsupported scheme ftp://'],
    ['ssh://-oProxyCommand=x/r', 'host would be read as an option'],
    ['git@-h:a.git', 'host or path would be read as an option'],
    ['git@h:-a.git', 'host or path would be read as an option'],
    ['relative/path.git', 'not a URL git can fetch safely'],
  ])('refuses %j (%s)', (url, why) => {
    expect(() => validateOriginUrl(url, 'palm.yaml: origin "x"')).toThrow(
      expect.objectContaining({
        code: 'E_ORIGIN',
        message: expect.stringContaining(`Refusing palm.yaml: origin "x" URL "${url}": ${why}`),
        hint: expect.stringContaining('https://'),
      }),
    );
  });
});

describe('deriveAlias', () => {
  const p = (s: string): OriginSpec => parseOriginInput(s, { cwd: '/' });
  const taken = (...aliases: string[]): OriginSpec[] =>
    aliases.map((alias) => ({ alias, type: 'git', url: 'x' }));

  it('prefers the root dir, then the repo (owner for generic names), then qualified forms', () => {
    expect(deriveAlias(p('obra/superpowers'), [])).toBe('superpowers');
    expect(deriveAlias(p('obra/superpowers'), taken('SUPERPOWERS'))).toBe('obra-superpowers');
    expect(deriveAlias(p('obra/superpowers'), taken('superpowers', 'obra-superpowers'))).toBe(
      'obra-superpowers-2',
    );
    expect(deriveAlias(p('anthropics/skills'), [])).toBe('anthropics');
    expect(deriveAlias(p('anthropics/skills'), taken('anthropics'))).toBe('anthropics-skills');
    expect(deriveAlias(p('cursor/plugins/pstack'), taken('pstack'))).toBe('cursor-pstack');
    expect(deriveAlias(p('cursor/plugins/pstack'), taken('pstack', 'cursor-pstack'))).toBe(
      'cursor-plugins-pstack',
    );
    expect(deriveAlias({ alias: '', type: 'local', path: '/srv/Team Skills' }, [])).toBe(
      'team-skills',
    );
    // generic names only fall back to the owner for git origins
    expect(deriveAlias({ alias: '', type: 'local', path: '/srv/skills' }, [])).toBe('skills');
  });

  it('falls back to "origin" when nothing usable is left', () => {
    expect(deriveAlias({ alias: '', type: 'git', url: 'https://h/✓' }, [])).toBe('origin');
    expect(deriveAlias({ alias: '', type: 'git', url: 'https://h/✓' }, taken('origin'))).toBe(
      'origin-2',
    );
  });

  it('always yields a valid alias', () => {
    for (const input of [
      'owner/_private',
      'Obra/SuperPowers',
      'x/-dash',
      'git@h.example:a/B.C.git',
    ]) {
      expect(deriveAlias(p(input), []), input).toMatch(ALIAS_RE);
    }
  });
});
