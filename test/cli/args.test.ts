import { describe, expect, it } from 'vitest';
import { looksLikeRepoRef, parseInstallArgs } from '../../src/commands/install.js';
import {
  parseTargetList,
  splitKindArgs,
  splitNameOrigin,
  splitPassthrough,
} from '../../src/commands/shared.js';

describe('parseInstallArgs', () => {
  const cases: Array<{ argv: string[]; expected: Record<string, unknown> }> = [
    {
      argv: ['install', 'skill', 'wayfinder'],
      expected: {
        mode: 'install',
        kind: 'skill',
        specs: ['wayfinder'],
        scope: 'project',
        targets: undefined,
        adhoc: undefined,
      },
    },
    {
      argv: ['install', 'skills', 'a', 'b', 'c'],
      expected: { mode: 'install', kind: 'skill', specs: ['a', 'b', 'c'] },
    },
    {
      argv: ['install', 'wayfinder'],
      expected: { mode: 'install', kind: undefined, specs: ['wayfinder'] },
    },
    {
      argv: [
        'install',
        'mcp',
        'fs',
        '--',
        'npx',
        '-y',
        '@modelcontextprotocol/server-filesystem',
        '.',
      ],
      expected: {
        kind: 'mcp',
        specs: ['fs'],
        adhoc: {
          name: 'fs',
          command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '.'],
          url: undefined,
          headers: [],
          env: [],
          transport: undefined,
        },
      },
    },
    {
      argv: [
        'install',
        'mcp',
        'docs',
        '--url',
        'https://x',
        '--header',
        'Authorization=Bearer ${T}',
      ],
      expected: {
        kind: 'mcp',
        specs: ['docs'],
        adhoc: {
          name: 'docs',
          command: undefined,
          url: 'https://x',
          headers: ['Authorization=Bearer ${T}'],
          env: [],
          transport: undefined,
        },
      },
    },
    {
      argv: ['i', 'agent', 'x', '-g', '--target', 'claude,codex'],
      expected: { kind: 'agent', specs: ['x'], scope: 'global', targets: ['claude', 'codex'] },
    },
    {
      argv: [
        'add',
        'plugin',
        'superpowers@superpowers',
        '--from',
        'obra/superpowers',
        '--save-origin',
      ],
      expected: {
        kind: 'plugin',
        specs: ['superpowers@superpowers'],
        from: 'obra/superpowers',
        saveOrigin: true,
      },
    },
    {
      argv: ['install'],
      expected: { mode: 'sync', kind: undefined, specs: [], prune: false },
    },
    {
      argv: ['install', '--prune', '-y', '--dry-run'],
      expected: { mode: 'sync', prune: true },
    },
    {
      argv: ['-g', 'install', 'rules', 'ts-style', '-t', 'cursor'],
      expected: { kind: 'instruction', specs: ['ts-style'], scope: 'global', targets: ['cursor'] },
    },
    {
      argv: [
        'install',
        'mcp',
        'gh',
        '--url',
        'https://api.example/mcp',
        '--header',
        'A=1',
        '--header',
        'B=2',
        '--env',
        'X=y',
        '--transport',
        'sse',
        '--secrets',
        'literal',
      ],
      expected: {
        secrets: 'literal',
        adhoc: {
          name: 'gh',
          command: undefined,
          url: 'https://api.example/mcp',
          headers: ['A=1', 'B=2'],
          env: ['X=y'],
          transport: 'sse',
        },
      },
    },
  ];

  it.each(cases)('palm $argv', ({ argv, expected }) => {
    expect(parseInstallArgs(argv)).toMatchObject(expected);
  });

  it('carries global flags', () => {
    const p = parseInstallArgs([
      'install',
      'skill',
      'x',
      '--dry-run',
      '--force',
      '-y',
      '--offline',
      '--verbose',
      '--json',
    ]);
    expect(p.global).toMatchObject({
      dryRun: true,
      force: true,
      yes: true,
      offline: true,
      verbose: true,
      json: true,
    });
  });

  it('keeps flags after -- as part of the MCP command', () => {
    const p = parseInstallArgs([
      'install',
      'mcp',
      'x',
      '--',
      'node',
      'server.js',
      '--port',
      '3000',
      '-g',
    ]);
    expect(p.scope).toBe('project');
    expect(p.adhoc?.command).toEqual(['node', 'server.js', '--port', '3000', '-g']);
  });

  const errors: Array<{ argv: string[]; message: RegExp }> = [
    { argv: ['install', 'skill'], message: /name the skill/ },
    { argv: ['install', 'skill', 'x', '--', 'npx', 'y'], message: /ad hoc MCP server/ },
    { argv: ['install', 'x', '--url', 'https://a'], message: /ad hoc MCP server/ },
    { argv: ['install', 'mcp', 'a', 'b', '--url', 'https://a'], message: /exactly one name/ },
    {
      argv: ['install', 'mcp', 'a', '--header', 'A=1'],
      message: /needs a command after `--` or --url/,
    },
    { argv: ['install', 'mcp', 'a', '--url', 'https://a', '--', 'npx'], message: /not both/ },
    { argv: ['install', 'skill', 'x', '--prune'], message: /--prune/ },
    { argv: ['install', 'skill', 'x', '--target', 'vim'], message: /unknown target: vim/ },
    { argv: ['install', 'skill', 'x', '--secrets', 'plain'], message: /secret policy/ },
    { argv: ['install', 'skill', 'x', '--save-origin'], message: /--save-origin needs --from/ },
  ];

  it.each(errors)('rejects palm $argv', ({ argv, message }) => {
    expect(() => parseInstallArgs(argv)).toThrow(message);
    try {
      parseInstallArgs(argv);
    } catch (e) {
      expect(e).toMatchObject({ code: 'E_USAGE' });
    }
  });
});

describe('install: origins and repositories are not entity names', () => {
  const usageError = (argv: string[]): { code?: string; message?: string; hint?: string } => {
    try {
      parseInstallArgs(argv);
    } catch (e) {
      return e as { code?: string; message?: string; hint?: string };
    }
    throw new Error(`palm ${argv.join(' ')} did not throw`);
  };

  it.each([['origin'], ['origins'], ['registry'], ['Origin']])(
    'palm install %s anthropics/skills → E_USAGE with the origin-add hint',
    (word) => {
      const err = usageError(['install', word, 'anthropics/skills']);
      expect(err).toMatchObject({
        code: 'E_USAGE',
        message: `${word.toLowerCase()} is not an installable kind`,
      });
      expect(err.hint).toContain(
        'register a repository with: palm origin add <owner/repo | url | path>',
      );
    },
  );

  it.each([
    ['anthropics/skills'],
    ['anthropics/skills#v1'],
    ['https://github.com/anthropics/skills'],
    ['git@github.com:anthropics/skills.git'],
    ['github:anthropics/skills'],
    ['gitlab:group/repo'],
    ['./vendor/skills'],
    ['~/src/skills'],
  ])('palm install %s → E_USAGE pointing at origin add and --from', (spec) => {
    const err = usageError(['install', spec]);
    expect(err).toMatchObject({
      code: 'E_USAGE',
      message: `"${spec}" is a repository, not an entity name`,
    });
    expect(err.hint).toContain(`palm origin add ${spec}`);
    expect(err.hint).toContain(`palm install skill <name> --from ${spec}`);
  });

  it('leaves MCP registry names, refs with slashes and kind-qualified specs alone', () => {
    expect(parseInstallArgs(['install', 'io.github.upstash/context7'])).toMatchObject({
      kind: undefined,
      specs: ['io.github.upstash/context7'],
    });
    expect(parseInstallArgs(['install', 'wayfinder#feature/x'])).toMatchObject({
      specs: ['wayfinder#feature/x'],
    });
    expect(parseInstallArgs(['install', 'skill', 'origin'])).toMatchObject({
      kind: 'skill',
      specs: ['origin'],
    });
    expect(parseInstallArgs(['install', 'mcp', 'io.github.x/y'])).toMatchObject({
      kind: 'mcp',
      specs: ['io.github.x/y'],
    });
    expect(looksLikeRepoRef('wayfinder@mattpocock')).toBe(false);
    expect(looksLikeRepoRef('@modelcontextprotocol/server-filesystem')).toBe(false);
    expect(looksLikeRepoRef('owner/repo@alias')).toBe(true);
  });
});

describe('argument helpers', () => {
  it('splitPassthrough splits at the first --', () => {
    expect(splitPassthrough(['a', '--', 'b', '--', 'c'])).toEqual({
      args: ['a'],
      passthrough: ['b', '--', 'c'],
    });
    expect(splitPassthrough(['a'])).toEqual({ args: ['a'], passthrough: [] });
  });

  it('splitKindArgs only shifts real kinds', () => {
    expect(splitKindArgs(['servers', 'x'])).toEqual({ kind: 'mcp', rest: ['x'] });
    expect(splitKindArgs(['wayfinder'])).toEqual({ kind: undefined, rest: ['wayfinder'] });
    expect(splitKindArgs([])).toEqual({ kind: undefined, rest: [] });
  });

  it('splitNameOrigin follows the dependency grammar', () => {
    expect(splitNameOrigin('wayfinder@mattpocock#v1')).toEqual({
      name: 'wayfinder',
      origin: 'mattpocock',
    });
    expect(splitNameOrigin('io.github.github/github-mcp-server')).toEqual({
      name: 'io.github.github/github-mcp-server',
    });
    expect(splitNameOrigin('plain')).toEqual({ name: 'plain' });
  });

  it('parseTargetList validates and dedupes', () => {
    expect(parseTargetList('claude, Codex,claude')).toEqual(['claude', 'codex']);
    expect(parseTargetList(undefined)).toBeUndefined();
    expect(() => parseTargetList('claude,emacs')).toThrow(/emacs/);
  });
});
