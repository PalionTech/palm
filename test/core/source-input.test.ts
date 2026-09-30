import { mkdir, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveSourceName,
  looksLikeSourceInput,
  parseSourceInput,
  validateSourceUrl,
} from '../../src/core/source-input.js';
import type { Source } from '../../src/core/types.js';
import { removeDir, tempDir } from '../support/sandbox.js';

let root: string;
let project: string;
beforeEach(async () => {
  root = await tempDir();
  project = join(root, 'project');
  await mkdir(join(project, 'agent-kit', 'nested'), { recursive: true });
  await mkdir(join(root, 'elsewhere'), { recursive: true });
});
afterEach(async () => removeDir(root));

const parse = (input: string, opts: Parameters<typeof parseSourceInput>[1] = {}) =>
  parseSourceInput(input, { cwd: project, projectRoot: project, ...opts });

describe('parseSourceInput: repositories', () => {
  it.each<[string, Source]>([
    [
      'obra/superpowers',
      { name: 'obra/superpowers', type: 'git', url: 'https://github.com/obra/superpowers.git' },
    ],
    [
      'mattpocock/skills#v1.2.3',
      {
        name: 'mattpocock/skills',
        type: 'git',
        url: 'https://github.com/mattpocock/skills.git',
        ref: 'v1.2.3',
      },
    ],
    [
      'cursor/plugins/pstack/sub',
      {
        name: 'cursor/plugins',
        type: 'git',
        url: 'https://github.com/cursor/plugins.git',
        root: 'pstack/sub',
      },
    ],
    [
      'github:obra/superpowers#^4',
      {
        name: 'obra/superpowers',
        type: 'git',
        url: 'https://github.com/obra/superpowers.git',
        ref: '^4',
      },
    ],
    [
      'https://github.com/obra/superpowers',
      { name: 'obra/superpowers', type: 'git', url: 'https://github.com/obra/superpowers.git' },
    ],
    [
      'https://github.com/o/r/tree/main/plugins/x',
      {
        name: 'o/r',
        type: 'git',
        url: 'https://github.com/o/r.git',
        ref: 'main',
        root: 'plugins/x',
      },
    ],
    [
      'https://gitlab.acme.com/platform/agent-kit.git#^1',
      {
        name: 'agent-kit',
        type: 'git',
        url: 'https://gitlab.acme.com/platform/agent-kit.git',
        ref: '^1',
      },
    ],
    [
      'ssh://git@host.example/team/kit.git',
      { name: 'kit', type: 'git', url: 'ssh://git@host.example/team/kit.git' },
    ],
    [
      'git@github.com:obra/superpowers.git#v4.0.3',
      {
        name: 'superpowers',
        type: 'git',
        url: 'git@github.com:obra/superpowers.git',
        ref: 'v4.0.3',
      },
    ],
    [
      'git@gitlab.example.com:team/sub/tools.git',
      { name: 'tools', type: 'git', url: 'git@gitlab.example.com:team/sub/tools.git' },
    ],
  ])('%s', (input, source) => {
    expect(parse(input)).toEqual(source);
  });

  it('applies --as, a ref, a root and a layout from the options', () => {
    expect(
      parse('owner/repo#v1', { as: 'kit', ref: 'v2', root: '/sub/', layout: { skills: ['x/*'] } }),
    ).toEqual({
      name: 'kit',
      type: 'git',
      url: 'https://github.com/owner/repo.git',
      ref: 'v2',
      root: 'sub',
      layout: { skills: ['x/*'] },
    });
    expect(() => parse('owner/repo', { as: 'bad name' })).toThrowError(
      expect.objectContaining({ code: 'E_USAGE' }),
    );
  });

  it('warns for plain-text transports and refuses unsafe URLs', () => {
    expect(validateSourceUrl('http://h/r.git').warning).toMatch(/unencrypted/);
    for (const bad of [
      'ext::sh -c touch% /tmp/x',
      'ssh://-oProxyCommand=touch%20x/repo',
      'ftp://h/r.git',
    ])
      expect(() => parse(bad), bad).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/E_SOURCE|E_USAGE/) }),
      );
    expect(() => parse('ssh://-oProxyCommand=touch%20x/repo')).toThrowError(
      expect.objectContaining({ code: 'E_SOURCE' }),
    );
  });
});

describe('parseSourceInput: paths', () => {
  it('names a directory inside the project ./rel and keeps it absolute in memory', () => {
    expect(parse('./agent-kit')).toEqual({
      name: './agent-kit',
      type: 'local',
      path: join(project, 'agent-kit'),
    });
    expect(parse(join(project, 'agent-kit', 'nested'))).toMatchObject({
      name: './agent-kit/nested',
    });
    expect(parse('.')).toMatchObject({ name: '.', type: 'local', path: project });
    expect(parse('..', { cwd: join(project, 'agent-kit', 'nested') })).toMatchObject({
      name: './agent-kit',
    });
  });

  it('refuses a directory outside the project, a missing one and a ref on a directory with E_SOURCE', () => {
    for (const bad of ['../elsewhere', join(root, 'elsewhere'), './missing', './agent-kit#v1'])
      expect(() => parse(bad), bad).toThrowError(expect.objectContaining({ code: 'E_SOURCE' }));
    expect(() => parse('./agent-kit#v1')).toThrowError(
      expect.objectContaining({ hint: expect.stringContaining('file://') }),
    );
  });

  it('follows a symlink into the project, and refuses one that leaves it', async () => {
    await symlink(join(root, 'elsewhere'), join(project, 'out'));
    expect(() => parse('./out')).toThrowError(expect.objectContaining({ code: 'E_SOURCE' }));
  });

  it('reads a bare repository path as a git source', async () => {
    const bare = join(project, 'mirror.git');
    await execa('git', ['init', '-q', '--bare', bare]);
    expect(parse('./mirror.git#main')).toEqual({
      name: 'mirror',
      type: 'git',
      url: bare,
      ref: 'main',
    });
  });

  it('expands ~ against the home directory', () => {
    expect(() =>
      parseSourceInput('~/definitely-missing-palm-dir', { projectRoot: homedir() }),
    ).toThrowError(
      expect.objectContaining({ code: 'E_SOURCE', message: expect.stringContaining(homedir()) }),
    );
  });
});

describe('parseSourceInput: a bare word', () => {
  it('is E_USAGE whose first line is the fix (DESIGN §10)', () => {
    let err: unknown;
    try {
      parse('superpowers');
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      code: 'E_USAGE',
      message: '"superpowers" is not a repository. palm installs from git repositories:',
    });
    const hint = (err as { hint: string }).hint.split('\n');
    expect(hint[0]).toBe(
      'palm install <owner/repo> [names...]      for example  palm install obra/superpowers',
    );
    expect(hint[1]).toBe(
      'Not sure which repository? https://github.com/search?q=superpowers+SKILL.md&type=code',
    );
    expect(() => parse('')).toThrowError(expect.objectContaining({ code: 'E_USAGE' }));
    expect(() => parse('agent-kit')).toThrowError(expect.objectContaining({ code: 'E_USAGE' }));
  });
});

describe('looksLikeSourceInput', () => {
  it.each([
    ['owner/repo', true],
    ['owner/repo/sub#v1', true],
    ['github:owner/repo', true],
    ['https://host/x.git', true],
    ['git@host:x.git', true],
    ['./kit', true],
    ['~/kit', true],
    ['/abs/kit', true],
    ['tdd', false],
    ['skill:tdd', false],
    ['mcp', false],
    ['', false],
  ])('%s → %s', (word, yes) => {
    expect(looksLikeSourceInput(word)).toBe(yes);
  });

  it('agrees with parseSourceInput for GitHub shorthand', () => {
    const seg = fc.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,12}$/);
    fc.assert(
      fc.property(seg, seg, (owner, repo) => {
        const input = `${owner}/${repo}`;
        expect(looksLikeSourceInput(input)).toBe(true);
        expect(parse(input).type).toBe('git');
      }),
    );
  });
});

describe('deriveSourceName', () => {
  const git = (url: string, root?: string): Source => ({
    name: '',
    type: 'git',
    url,
    ...(root ? { root } : {}),
  });

  it('owner/repo for GitHub, else repo, else owner-repo, else a counter; never a taken name in any case', () => {
    expect(deriveSourceName(git('https://github.com/obra/superpowers.git'), [])).toBe(
      'obra/superpowers',
    );
    expect(
      deriveSourceName(git('https://github.com/obra/superpowers.git'), ['OBRA/superpowers']),
    ).toBe('superpowers');
    expect(deriveSourceName(git('https://gitlab.acme.com/platform/kit.git'), [])).toBe('kit');
    expect(deriveSourceName(git('https://gitlab.acme.com/platform/kit.git'), ['Kit'])).toBe(
      'platform-kit',
    );
    expect(
      deriveSourceName(git('https://gitlab.acme.com/platform/kit.git'), [
        'kit',
        'platform-kit',
        'platform-kit-2',
      ]),
    ).toBe('platform-kit-3');
  });

  it('keeps a local ./rel name', () => {
    expect(
      deriveSourceName({ name: './agent-kit', type: 'local', path: '/p/agent-kit' }, [
        './agent-kit',
      ]),
    ).toBe('./agent-kit');
    expect(deriveSourceName({ name: '', type: 'local', path: '/p/tools' }, [])).toBe('./tools');
  });
});
