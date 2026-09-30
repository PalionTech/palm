import { describe, expect, it, vi } from 'vitest';
import {
  applyPassthrough,
  interpretInstall,
  interpretRemove,
  interpretWords,
  prepareArgv,
} from '../../src/commands/grammar.js';
import { parseArgv } from '../../src/commands/program.js';
import { PalmError } from '../../src/core/errors.js';

vi.mock('../../src/commands/ports.js', () => import('./contract.js'));

const declared =
  (...names: string[]) =>
  (word: string) =>
    names.includes(word);

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
      { source: 'https://gitlab.acme.com/platform/agent-kit.git#v1', names: [{ name: 'reviewer' }] },
    ],
    [['git@github.com:obra/superpowers.git'], { source: 'git@github.com:obra/superpowers.git', names: [] }],
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
      { form: 'palm install skill tdd@mattpocock', replacement: 'palm install mattpocock skill:tdd' },
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
      { form: 'palm install plugin obra/superpowers', replacement: 'palm install obra/superpowers' },
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

  it('runs a legacy alias as its source with the kind kept', () => {
    const w = interpretInstall(['skill', 'tdd@mattpocock'], { isDeclared: declared('mattpocock') });
    expect(w).toMatchObject({ source: 'mattpocock', names: [{ kind: 'skill', name: 'tdd' }] });
  });

  it('a #ref belongs to update --to', () => {
    expect(usageOf(() => interpretInstall(['tdd@mp#v1']))).toEqual({
      message: 'a version belongs to the source in palm.yaml, not to a name',
      hint: 'palm update mp --to v1',
    });
  });

  it('names from two aliases install one source at a time', () => {
    const e = usageOf(() => interpretInstall(['tdd@a', 'grill@b']));
    expect(e.message).toBe('tdd@a grill@b names 2 sources; install from one source at a time');
    expect(e.hint).toBe('palm install a tdd');
  });

  it('an alias palm.yaml does not declare points at palm migrate', () => {
    expect(usageOf(() => interpretInstall(['tdd@mattpocock'], { isDeclared: declared() }))).toEqual({
      message: '"mattpocock" is not a source in palm.yaml',
      hint: 'declare the sources your palm 0.1 project used: palm migrate',
    });
  });

  it('install origin needs the repository', () => {
    expect(usageOf(() => interpretInstall(['origin'])).hint).toBe('palm install obra/superpowers');
  });
});

describe('interpretInstall: a word that is no source is "not a repository"', () => {
  const strict = (words: string[]) => usageOf(() => interpretInstall(words, { isDeclared: declared() }));

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

  it.each([[['tdd']], [['skill', 'tdd']]])('%j names the repository of that skill (Lena)', (words) => {
    expect(strict(words)).toEqual({
      message: '"tdd" is not a repository. palm installs from git repositories:',
      hint: '  palm install <owner/repo> tdd             for example  palm install mattpocock/skills tdd',
    });
  });

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
  ])('palm 0.1 form %j', (words, legacy) => {
    expect(interpretRemove(words).legacy).toEqual(legacy);
  });

  it('a source leaves palm.yaml with its last entry', () => {
    expect(usageOf(() => interpretRemove(['origin', 'pstack'])).hint).toBe(
      'palm get --source pstack',
    );
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
  it('reads install mcp --json <file or -> as the snippet, not JSON output', () => {
    expect(prepareArgv(['install', 'mcp', '--json', '-']).args).toEqual([
      'install',
      'mcp',
      '--mcp-json',
      '-',
    ]);
    expect(prepareArgv(['i', 'mcp', '--json', 'server.json']).args).toContain('--mcp-json');
    expect(prepareArgv(['install', 'mcp', 'docs', '--url', 'u', '--json']).args).toContain('--json');
    expect(prepareArgv(['install', 'obra/superpowers', '--json']).args).toContain('--json');
    expect(prepareArgv(['--secrets', 'literal', 'add', 'mcp', '--json', '-']).args).toContain(
      '--mcp-json',
    );
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
    expect(() =>
      applyPassthrough({ command: 'get', names: [], opts: {} }, ['x']),
    ).toThrow(/only for palm install mcp/);
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
    [['new', 'skill', 'notes'], { command: 'create', resource: 'skill', names: [{ name: 'notes' }] }],
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
      'install', 'mcp', 'xcodebuild', '--command', 'npx', '--arg', '-y', '--arg', 'xcodebuildmcp@latest',
      '--env', 'A=1', '--env', 'B=2', '--header', 'X=1', '--transport', 'stdio', '--cwd', 'tools',
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

  it('reads install mcp --json - as the snippet flag', () => {
    const { invocation } = parseArgv(['install', 'mcp', '--json', '-']);
    expect(invocation.opts).toMatchObject({ mcpJson: '-' });
    expect(invocation.opts.json).toBeUndefined();
  });

  it('update, get, describe, remove and create take their own flags', () => {
    expect(parseArgv(['update', 'kit', '--to', '^2', '--review', '--strict']).invocation.opts).toMatchObject({
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
      parseArgv(['create', 'agent', 'reviewer', '--in', 'kit', '--description', 'Reviews diffs']).invocation.opts,
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
    [['find', '.claude/skills/tdd/SKILL.md'], 'palm find is now: palm describe .claude/skills/tdd/SKILL.md'],
    [['config', 'get'], 'palm config is gone; targets live in palm.yaml (~/.palm/palm.yaml with -g)'],
    [['origin', 'add', 'mattpocock/skills'], 'palm origin add is now: palm install mattpocock/skills'],
    [['origin', 'list'], 'palm origin list is now: palm get sources'],
  ])('hidden palm 0.1 command %j names its replacement', (argv, line) => {
    expect(usageOf(() => parseArgv(argv))).toEqual({ message: line, hint: undefined });
  });

  it('search is gone and points at GitHub', () => {
    expect(usageOf(() => parseArgv(['search', 'tdd'])).message).toBe(
      'palm search is gone; find a repository (https://github.com/search?q=tdd+SKILL.md&type=code), then list it: palm install <owner/repo>',
    );
  });
});
