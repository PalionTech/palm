import { describe, expect, it } from 'vitest';
import {
  applyPassthrough,
  interpretInstall,
  interpretRemove,
  interpretWords,
  prepareArgv,
} from '../../src/commands/grammar.js';
import type { KnownSource } from '../../src/commands/hints.js';
import { parseArgv } from '../../src/commands/program.js';
import { PalmError } from '../../src/core/errors.js';

const declared =
  (...names: string[]) =>
  (word: string) =>
    names.includes(word);

const SOURCES: KnownSource[] = [
  { name: 'mattpocock/skills', input: 'mattpocock/skills', owner: 'mattpocock', repo: 'skills' },
  { name: 'obra/superpowers', input: 'obra/superpowers', owner: 'obra', repo: 'superpowers' },
];
const KIT: KnownSource = { name: 'kit', input: 'https://gitlab.acme.com/kit.git', repo: 'kit' };

function usageOf(fn: () => unknown): { message: string; hint?: string } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PalmError);
    expect((e as PalmError).code).toBe('E_USAGE');
    return { message: (e as PalmError).message, hint: (e as PalmError).hint };
  }
  throw new Error('expected E_USAGE');
}

describe('interpretInstall: the source first (DESIGN.md §10)', () => {
  it.each([
    [[], { names: [] }],
    [['obra/superpowers'], { source: 'obra/superpowers', names: [] }],
    [
      ['mattpocock/skills', 'tdd', 'handoff'],
      { source: 'mattpocock/skills', names: [{ name: 'tdd' }, { name: 'handoff' }] },
    ],
    [
      ['mattpocock/skills', 'skill:tdd', 'mcp:docs'],
      {
        source: 'mattpocock/skills',
        names: [
          { kind: 'skill', name: 'tdd' },
          { kind: 'mcp', name: 'docs' },
        ],
      },
    ],
    [['obra/superpowers/skills#v4'], { source: 'obra/superpowers/skills#v4', names: [] }],
    [
      ['https://gitlab.acme.com/platform/agent-kit.git#v1', 'reviewer'],
      {
        source: 'https://gitlab.acme.com/platform/agent-kit.git#v1',
        names: [{ name: 'reviewer' }],
      },
    ],
    [
      ['git@github.com:obra/superpowers.git'],
      { source: 'git@github.com:obra/superpowers.git', names: [] },
    ],
    [['./agent-kit', 'review'], { source: './agent-kit', names: [{ name: 'review' }] }],
    [['mcp', 'docs'], { mcp: true, names: [{ name: 'docs' }] }],
    [['mcp'], { mcp: true, names: [] }],
  ])('%j', (words, expected) => {
    expect(interpretInstall(words, { isDeclared: declared() })).toEqual(expected);
  });

  it('takes a name or alias palm.yaml declares as the source', () => {
    const isDeclared = declared('acme-kit', 'kit');
    expect(interpretInstall(['acme-kit', 'reviewer'], { isDeclared })).toEqual({
      source: 'acme-kit',
      names: [{ name: 'reviewer' }],
    });
    expect(interpretInstall(['kit'], { isDeclared })).toEqual({ source: 'kit', names: [] });
  });

  it('keeps a bare first word for the command while commander parses (no palm.yaml yet)', () => {
    expect(interpretInstall(['acme-kit', 'reviewer'])).toEqual({
      source: 'acme-kit',
      names: [{ name: 'reviewer' }],
    });
  });
});

describe('interpretInstall: palm 0.1 forms print the new form and run it', () => {
  it.each([
    [
      ['origin', 'mattpocock/skills'],
      'mattpocock',
      { form: 'palm install origin', replacement: 'palm install mattpocock/skills' },
    ],
    [
      ['skill', 'tdd@mattpocock'],
      'mattpocock',
      {
        form: 'palm install skill tdd@mattpocock',
        replacement: 'palm install mattpocock skill:tdd',
      },
    ],
    [
      ['tdd@mattpocock'],
      'mattpocock',
      { form: 'palm install tdd@mattpocock', replacement: 'palm install mattpocock tdd' },
    ],
    [
      ['skills', 'tdd@mp', 'handoff@mp'],
      'mp',
      {
        form: 'palm install skills tdd@mp handoff@mp',
        replacement: 'palm install mp skill:tdd skill:handoff',
      },
    ],
    [
      ['plugin', 'obra/superpowers'],
      'obra',
      {
        form: 'palm install plugin obra/superpowers',
        replacement: 'palm install obra/superpowers',
      },
    ],
    [
      ['skill', 'mattpocock/skills', 'tdd'],
      'mattpocock',
      {
        form: 'palm install skill mattpocock/skills tdd',
        replacement: 'palm install mattpocock/skills skill:tdd',
      },
    ],
  ])('%j', (words, alias, legacy) => {
    const w = interpretInstall(words, { isDeclared: declared(alias) });
    expect(w.legacy).toEqual(legacy);
  });

  it('prints no new form when what follows the kind word is no source', () => {
    expect(interpretInstall(['plugin', 'superpowers']).legacy).toBeUndefined();
  });

  it('runs a legacy alias as its source with the kind kept', () => {
    const w = interpretInstall(['skill', 'tdd@mattpocock'], { isDeclared: declared('mattpocock') });
    expect(w).toMatchObject({ source: 'mattpocock', names: [{ kind: 'skill', name: 'tdd' }] });
  });

  it('keeps an alias for the command while commander parses (no palm.yaml yet)', () => {
    expect(interpretInstall(['tdd@mp#v1'])).toEqual({ source: 'mp', names: [{ name: 'tdd' }] });
  });

  it('E16, L7: an alias names the declared source whose repository or owner it is', () => {
    const ctx = { isDeclared: declared('mattpocock/skills', 'obra/superpowers'), sources: SOURCES };
    expect(interpretInstall(['skill', 'grill-me@mattpocock'], ctx)).toEqual({
      source: 'mattpocock/skills',
      names: [{ kind: 'skill', name: 'grill-me' }],
      legacy: {
        form: 'palm install skill grill-me@mattpocock',
        replacement: 'palm install mattpocock/skills skill:grill-me',
      },
    });
    expect(interpretInstall(['brainstorming@superpowers'], ctx).source).toBe('obra/superpowers');
  });

  it('J8: an alias ~/.palm/config.yaml knows resolves to its repository', () => {
    const ctx = { isDeclared: declared(), legacyAliases: { mp: 'mattpocock/skills' } };
    expect(interpretInstall(['tdd@mp'], ctx).source).toBe('mattpocock/skills');
  });

  it('C23, D10, X22: a #ref on a name moves to the source location; an example never pastes it', () => {
    const ctx = { isDeclared: declared('mattpocock/skills'), sources: SOURCES };
    expect(usageOf(() => interpretInstall(['tdd@mattpocock#v1.2.3'], ctx))).toEqual({
      message: 'a version belongs to the source, not to a name',
      hint: '  palm install mattpocock/skills#v1.2.3 tdd',
    });
    const fresh = { isDeclared: declared() };
    expect(usageOf(() => interpretInstall(['skill', 'tdd@mattpocock#v1.2.3'], fresh)).hint).toBe(
      '  palm install mattpocock/skills#v1.2.3 skill:tdd',
    );
    expect(
      usageOf(() => interpretInstall(['tdd@acme#v2'], { ...fresh, scope: 'global' })).hint,
    ).toBe(
      '  palm install <owner/repo>#v2 tdd          for example  palm install mattpocock/skills#v1.0.0 tdd -g',
    );
  });

  it('J8: names from two aliases get one line per source', () => {
    const ctx = { isDeclared: declared('a'), legacyAliases: { b: 'obra/superpowers' } };
    const e = usageOf(() => interpretInstall(['tdd@a', 'grill@b'], ctx));
    expect(e.message).toBe('these names come from 2 sources; palm install takes one at a time:');
    expect(e.hint).toBe('  palm install a tdd\n  palm install obra/superpowers grill');
  });

  it('E16, Q3: an alias nothing resolves gets the 0.2 form; a declared source only when it offers the name', () => {
    expect(usageOf(() => interpretInstall(['tdd@mattpocock'], { isDeclared: declared() }))).toEqual(
      {
        message:
          '"mattpocock" is a palm 0.1 alias and palm.yaml declares no source for it; did you mean mattpocock/skills?',
        hint: '  palm install mattpocock/skills tdd',
      },
    );
    const e = usageOf(() =>
      interpretInstall(['tdd@acme'], { isDeclared: declared('kit'), sources: [KIT] }),
    );
    expect(e.hint).toBe(
      '  palm install <owner/repo> tdd             for example  palm install mattpocock/skills tdd',
    );
  });

  it('J8: install origin with several repositories gives one line each', () => {
    const e = usageOf(() =>
      interpretInstall(['origin', 'obra/superpowers', 'mattpocock/skills'], {
        isDeclared: declared(),
      }),
    );
    expect(e.hint).toBe('  palm install obra/superpowers\n  palm install mattpocock/skills');
  });

  it('a 0.1 name after a source is the same command with plain names', () => {
    const ctx = { isDeclared: declared('mattpocock/skills'), sources: SOURCES };
    expect(usageOf(() => interpretInstall(['mattpocock/skills', 'tdd#v1'], ctx)).hint).toBe(
      '  palm install mattpocock/skills#v1 tdd',
    );
    expect(
      usageOf(() => interpretInstall(['kit', 'tdd@mp'], { isDeclared: declared('kit') })).hint,
    ).toBe('  palm install kit tdd');
  });

  it('install origin needs the repository', () => {
    expect(usageOf(() => interpretInstall(['origin'])).hint).toBe('palm install obra/superpowers');
  });
});

describe('interpretInstall: a word that is no source is "not a repository"', () => {
  const strict = (words: string[]) =>
    usageOf(() => interpretInstall(words, { isDeclared: declared() }));

  it.each([
    [['superpowers'], 'superpowers'],
    [['plugin', 'superpowers'], 'superpowers'],
  ])('%j names the repository and a search (Nora)', (words, word) => {
    expect(strict(words)).toEqual({
      message: `"${word}" is not a repository. palm installs from git repositories:`,
      hint: [
        '  palm install <owner/repo> [names...]      for example  palm install obra/superpowers',
        'Not sure which repository? https://github.com/search?q=superpowers+SKILL.md&type=code',
      ].join('\n'),
    });
  });

  it.each([[['tdd']], [['skill', 'tdd']]])(
    '%j names the repository of that skill (Lena)',
    (words) => {
      expect(strict(words)).toEqual({
        message: '"tdd" is not a repository. palm installs from git repositories:',
        hint: '  palm install <owner/repo> tdd             for example  palm install mattpocock/skills tdd',
      });
    },
  );

  it('keeps the names after a known repository name', () => {
    expect(strict(['superpowers', 'brainstorming']).hint).toContain(
      'for example  palm install obra/superpowers brainstorming',
    );
  });

  it('an unknown word gets an example and a search for it', () => {
    expect(strict(['frobnicate']).hint).toBe(
      [
        '  palm install <owner/repo> [names...]      for example  palm install mattpocock/skills tdd',
        'Not sure which repository? https://github.com/search?q=frobnicate+SKILL.md&type=code',
      ].join('\n'),
    );
  });
});

describe('interpretRemove', () => {
  it.each([
    [['tdd'], { names: [{ name: 'tdd' }] }],
    [['mattpocock/skills', 'tdd'], { source: 'mattpocock/skills', names: [{ name: 'tdd' }] }],
    [['obra/superpowers'], { source: 'obra/superpowers', names: [] }],
    [
      ['skill:tdd', 'mcp:docs'],
      {
        names: [
          { kind: 'skill', name: 'tdd' },
          { kind: 'mcp', name: 'docs' },
        ],
      },
    ],
    [['acme-kit', 'reviewer'], { names: [{ name: 'acme-kit' }, { name: 'reviewer' }] }],
    [[], { names: [] }],
  ])('%j', (words, expected) => {
    expect(interpretRemove(words)).toEqual(expected);
  });

  it.each([
    [
      ['skill', 'tdd', 'handoff'],
      { form: 'palm remove skill tdd handoff', replacement: 'palm remove skill:tdd skill:handoff' },
    ],
    [['tdd@mp'], { form: 'palm remove tdd@mp', replacement: 'palm remove mp tdd' }],
    [
      ['skill', 'tdd@mp#v1'],
      { form: 'palm remove skill tdd@mp#v1', replacement: 'palm remove mp skill:tdd' },
    ],
    [['tdd@gone'], { form: 'palm remove tdd@gone', replacement: 'palm remove tdd' }],
  ])('palm 0.1 form %j', (words, legacy) => {
    expect(interpretRemove(words, { isDeclared: declared('mp') }).legacy).toEqual(legacy);
  });

  it('a declared source first, names after it', () => {
    expect(interpretRemove(['acme-kit', 'reviewer'], { isDeclared: declared('acme-kit') })).toEqual(
      { source: 'acme-kit', names: [{ name: 'reviewer' }] },
    );
  });

  it('a source leaves palm.yaml with its last entry', () => {
    expect(usageOf(() => interpretRemove(['origin', 'pstack'])).hint).toBe('palm get sources');
  });
});

describe('interpretWords: kind nouns for get and describe', () => {
  it.each([
    [[], {}],
    [['skills'], { resource: 'skill' }],
    [['sk', 'tdd'], { resource: 'skill', names: [{ name: 'tdd' }] }],
    [['agents'], { resource: 'agent' }],
    [['ins'], { resource: 'instruction' }],
    [['hk'], { resource: 'hook' }],
    [['mcp'], { resource: 'mcp' }],
    [['pl'], { resource: 'plugin' }],
    [['sources'], { resource: 'source' }],
    [['src'], { resource: 'source' }],
    [['targets'], { resource: 'target' }],
    [['tg'], { resource: 'target' }],
    [['all'], { resource: 'all' }],
    [['tdd'], { names: [{ name: 'tdd' }] }],
    [['skill:tdd'], { names: [{ kind: 'skill', name: 'tdd' }] }],
  ])('get %j', (words, expected) => {
    expect(interpretWords('get', words)).toEqual({ names: [], ...expected });
  });

  it.each([
    [['source', 'obra/superpowers'], { resource: 'source', names: [{ name: 'obra/superpowers' }] }],
    [['target', 'cursor'], { resource: 'target', names: [{ name: 'cursor' }] }],
    [['.claude/skills/tdd/SKILL.md'], { names: [{ name: '.claude/skills/tdd/SKILL.md' }] }],
    [['~/.claude/agents/x.md'], { names: [{ name: '~/.claude/agents/x.md' }] }],
    [['mcp:docs'], { names: [{ kind: 'mcp', name: 'docs' }] }],
  ])('describe %j', (words, expected) => {
    expect(interpretWords('describe', words)).toEqual(expected);
  });

  it.each([
    ['get', ['origins'], { form: 'palm get origins', replacement: 'palm get sources' }],
    ['get', ['orig'], { form: 'palm get orig', replacement: 'palm get sources' }],
    [
      'describe',
      ['origin', 'mattpocock'],
      { form: 'palm describe origin mattpocock', replacement: 'palm describe source mattpocock' },
    ],
    [
      'get',
      ['commands'],
      { form: 'palm get commands', replacement: 'palm get skills (commands install as skills)' },
    ],
  ] as const)('%s %j is a palm 0.1 word', (verb, words, legacy) => {
    expect(interpretWords(verb, [...words]).legacy).toEqual(legacy);
  });

  it('describe shows one thing', () => {
    expect(usageOf(() => interpretWords('describe', ['all'])).hint).toBe('palm get all');
  });
});

describe('argv', () => {
  it('attaches a value that starts with a dash to its option, so -y stays an --arg', () => {
    expect(prepareArgv(['install', 'mcp', 'x', '--arg', '-y', '--env', '-z', '-g']).args).toEqual([
      'install',
      'mcp',
      'x',
      '--arg=-y',
      '--env=-z',
      '-g',
    ]);
    expect(prepareArgv(['install', 'mcp', '--snippet', '-']).args).toEqual([
      'install',
      'mcp',
      '--snippet',
      '-',
    ]);
  });

  it('splits at -- and turns the 0.1 ad hoc command into --command and --arg', () => {
    const { args, passthrough } = prepareArgv(['install', 'mcp', 'fs', '--', 'npx', '-y', 'srv']);
    expect(args).toEqual(['install', 'mcp', 'fs']);
    const inv = applyPassthrough(
      { command: 'install mcp', names: [{ name: 'fs' }], opts: {} },
      passthrough,
    );
    expect(inv.opts).toMatchObject({ command: 'npx', arg: ['-y', 'srv'] });
    expect(inv.legacy).toEqual({
      form: 'palm install mcp fs -- npx -y srv',
      replacement: 'palm install mcp fs --command npx --arg -y --arg srv',
    });
    expect(() => applyPassthrough({ command: 'get', names: [], opts: {} }, ['x'])).toThrow(
      /only for palm install mcp/,
    );
  });
});

describe('parseArgv: verbs, aliases and flags', () => {
  it.each([
    [['i', 'mattpocock/skills', 'tdd', '-g'], { command: 'install', source: 'mattpocock/skills' }],
    [['add', 'obra/superpowers', '--all'], { command: 'install', source: 'obra/superpowers' }],
    [['install'], { command: 'install', names: [] }],
    [['install', 'mcp', 'docs', '--url', 'https://x.dev/mcp'], { command: 'install mcp' }],
    [['uninstall', 'tdd'], { command: 'remove', names: [{ name: 'tdd' }] }],
    [['rm', 'mattpocock/skills', 'tdd'], { command: 'remove', source: 'mattpocock/skills' }],
    [['up', 'mattpocock/skills'], { command: 'update', names: [{ name: 'mattpocock/skills' }] }],
    [['check'], { command: 'check', names: [] }],
    [['ls', 'skills'], { command: 'get', resource: 'skill' }],
    [['list', 'sources'], { command: 'get', resource: 'source' }],
    [['info', 'tdd'], { command: 'describe', names: [{ name: 'tdd' }] }],
    [
      ['new', 'skill', 'notes'],
      { command: 'create', resource: 'skill', names: [{ name: 'notes' }] },
    ],
    [['init', '--here'], { command: 'init' }],
    [['migrate', '--dry-run'], { command: 'migrate' }],
    [['completion', 'zsh'], { command: 'completion', names: [{ name: 'zsh' }] }],
    [['cache', 'clean', '--yes'], { command: 'cache clean' }],
  ])('%j', (argv, expected) => {
    expect(parseArgv(argv).invocation).toMatchObject(expected);
  });

  it('merges the global flags into every command', () => {
    const { invocation } = parseArgv([
      'install',
      'acme-kit',
      'reviewer',
      '-g',
      '--dry-run',
      '--force',
      '-y',
      '--allow-exec',
      'hook:x@y=sha256:12345678',
      '--offline',
      '--json',
      '--secrets',
      'literal',
      '--targets',
      'claude,codex',
      '--at',
      'packages/db',
      '--as',
      'kit',
    ]);
    expect(invocation.opts).toMatchObject({
      global: true,
      dryRun: true,
      force: true,
      yes: true,
      allowExec: 'hook:x@y=sha256:12345678',
      offline: true,
      json: true,
      secrets: 'literal',
      targets: 'claude,codex',
      at: 'packages/db',
      as: 'kit',
    });
  });

  it('collects repeated MCP flags', () => {
    const { invocation } = parseArgv([
      'install',
      'mcp',
      'xcodebuild',
      '--command',
      'npx',
      '--arg',
      '-y',
      '--arg',
      'xcodebuildmcp@latest',
      '--env',
      'A=1',
      '--env',
      'B=2',
      '--header',
      'X=1',
      '--transport',
      'stdio',
      '--cwd',
      'tools',
    ]);
    expect(invocation.opts).toMatchObject({
      command: 'npx',
      arg: ['-y', 'xcodebuildmcp@latest'],
      env: ['A=1', 'B=2'],
      header: ['X=1'],
      transport: 'stdio',
      cwd: 'tools',
    });
  });

  it('--snippet names the README block; --json stays JSON output', () => {
    const { invocation } = parseArgv(['install', 'mcp', '--snippet', '-', '--json']);
    expect(invocation.opts).toMatchObject({ snippet: '-', json: true });
  });

  it('install takes --review', () => {
    const { invocation } = parseArgv(['install', 'obra/superpowers', 'session-start', '--review']);
    expect(invocation.opts).toMatchObject({ review: true });
  });

  it('update, get, describe, remove and create take their own flags', () => {
    expect(
      parseArgv(['update', 'kit', '--to', '^2', '--review', '--strict']).invocation.opts,
    ).toMatchObject({
      to: '^2',
      review: true,
      strict: true,
    });
    expect(parseArgv(['get', '-s', 'kit', '--files']).invocation.opts).toMatchObject({
      source: 'kit',
      files: true,
    });
    expect(parseArgv(['remove', 'brainstorming', '--exclude']).invocation.opts).toMatchObject({
      exclude: true,
    });
    expect(
      parseArgv(['create', 'agent', 'reviewer', '--in', 'kit', '--description', 'Reviews diffs'])
        .invocation.opts,
    ).toMatchObject({ in: 'kit', description: 'Reviews diffs' });
    expect(parseArgv(['init', '--target', 'claude,cursor']).invocation.opts).toMatchObject({
      target: 'claude,cursor',
    });
  });

  it.each([
    [['doctor'], 'palm doctor is now: palm check'],
    [['audit', '--strip'], 'palm audit is now: palm check'],
    [['outdated', 'skills'], 'palm outdated is now: palm update --dry-run'],
    [['why', 'skill', 'tdd@mattpocock'], 'palm why is now: palm describe skill tdd'],
    [
      ['find', '.claude/skills/tdd/SKILL.md'],
      'palm find is now: palm describe .claude/skills/tdd/SKILL.md',
    ],
    [
      ['config', 'get'],
      'palm config is gone; targets live in palm.yaml (~/.palm/palm.yaml with -g)',
    ],
    [
      ['origin', 'add', 'mattpocock/skills'],
      'palm origin add is now: palm install mattpocock/skills',
    ],
    [['origin', 'list'], 'palm origin list is now: palm get sources'],
  ])('hidden palm 0.1 command %j names its replacement', (argv, line) => {
    expect(usageOf(() => parseArgv(argv))).toEqual({ message: line, hint: undefined });
  });

  it('J18: search is gone and points at GitHub, and MCP servers at --snippet', () => {
    expect(usageOf(() => parseArgv(['search', 'tdd'])).message).toBe(
      'palm search is gone; find a repository (https://github.com/search?q=tdd+SKILL.md&type=code), then list it, for example: palm install mattpocock/skills; an MCP server comes from its README: pbpaste | palm install mcp --snippet -',
    );
    expect(usageOf(() => parseArgv(['search', 'mcp', 'brave'])).message).toBe(
      'palm search is gone; an MCP server comes from its README: pbpaste | palm install mcp --snippet -',
    );
  });
});
