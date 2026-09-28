import { describe, expect, it } from 'vitest';
import { type Invocation, interpretWords, VERBS } from '../../src/commands/grammar.js';
import { parseArgv } from '../../src/commands/program.js';
import {
  parseKind,
  parseResource,
  RESOURCES,
  type Resource,
  resourceWords,
  SHORT_NAMES,
} from '../../src/core/kinds.js';

/** The parts of an Invocation that say what runs (options compared separately). */
function what(argv: string[]): Pick<Invocation, 'command' | 'resource' | 'names' | 'marketplace'> {
  const { command, resource, names, marketplace } = parseArgv(argv).invocation;
  return { command, resource, names, marketplace };
}

function usageError(argv: string[]): { code?: string; message?: string; hint?: string } {
  try {
    parseArgv(argv);
  } catch (e) {
    return e as { code?: string; message?: string; hint?: string };
  }
  throw new Error(`palm ${argv.join(' ')} did not throw`);
}

/** singular, plural and short name of a resource (the forms every verb accepts). */
function forms(r: Resource): string[] {
  if (r === 'all') return ['all'];
  const plural = r === 'mcp' ? 'mcps' : `${r}s`;
  return [...new Set([r, plural, SHORT_NAMES[r] ?? r])];
}

describe('resource words', () => {
  it.each(RESOURCES.flatMap((r) => forms(r).map((w) => [w, r] as const)))(
    'parseResource(%j) → %s',
    (word, resource) => {
      expect(parseResource(word)).toBe(resource);
      expect(parseResource(word.toUpperCase())).toBe(resource);
    },
  );

  it('has the short names from the plan', () => {
    expect(SHORT_NAMES).toMatchObject({
      skill: 'sk',
      agent: 'ag',
      instruction: 'ins',
      command: 'cmd',
      hook: 'hk',
      mcp: 'mcp',
      plugin: 'pl',
      origin: 'orig',
      target: 'tg',
    });
  });

  it('parseKind stays entity-only; aliases still work', () => {
    expect(parseKind('origin')).toBeUndefined();
    expect(parseKind('tg')).toBeUndefined();
    expect(parseKind('rules')).toBe('instruction');
    expect(parseKind('servers')).toBe('mcp');
    expect(parseResource('wayfinder')).toBeUndefined();
    expect(parseResource(undefined)).toBeUndefined();
  });

  it('resourceWords lists every word of a resource', () => {
    expect(resourceWords('origin').sort()).toEqual(['orig', 'origin', 'origins']);
    expect(resourceWords('skill').sort()).toEqual(['sk', 'skill', 'skills']);
  });
});

describe('palm <verb> <kind> [names] (every verb × alias × kind form)', () => {
  const cases = VERBS.flatMap((v) =>
    [v.name, ...v.aliases].flatMap((word) =>
      v.resources.flatMap((r) => forms(r).map((form) => ({ verb: v.name, word, r, form }))),
    ),
  );

  it.each(cases)('palm $word $form x → $verb $r', ({ verb, word, r, form }) => {
    expect(what([word, form, 'x'])).toEqual({
      command: verb,
      resource: r,
      names: ['x'],
      marketplace: undefined,
    });
  });

  it.each(VERBS.filter((v) => !v.kindRequired).flatMap((v) => [v.name, ...v.aliases]))(
    'palm %s x (no kind) keeps x as a name',
    (word) => {
      expect(what([word, 'x'])).toMatchObject({ resource: undefined, names: ['x'] });
    },
  );

  it('search takes the kind word only when a query follows it', () => {
    expect(what(['search', 'mcp'])).toMatchObject({ resource: undefined, names: ['mcp'] });
    expect(what(['search', 'mcp', 'github', 'server'])).toMatchObject({
      resource: 'mcp',
      names: ['github', 'server'],
    });
  });

  it('get and update take names after the kind; the kind is optional', () => {
    expect(what(['get'])).toMatchObject({ command: 'get', resource: undefined, names: [] });
    expect(what(['update', 'origins', 'a', 'b'])).toMatchObject({
      resource: 'origin',
      names: ['a', 'b'],
    });
    expect(what(['ls', 'all'])).toMatchObject({ command: 'get', resource: 'all' });
  });

  it.each([
    [['install', 'target', 'claude'], 'palm install does not take targets', '--target'],
    [['install', 'all'], 'palm install does not take all', 'palm install takes'],
    [['rm', 'targets', 'x'], 'palm uninstall does not take targets', 'palm get targets'],
    [['describe', 'all'], 'palm describe does not take all', 'palm get all'],
    [['update', 'tg'], 'palm update does not take targets', 'palm get targets'],
    [['create', 'origin', 'x'], 'palm create does not take origins', 'palm create takes'],
    [['create', 'hook', 'x'], 'palm create does not take hooks', 'palm create takes'],
    [['search', 'origins', 'x'], 'palm search does not take origins', 'palm get origins'],
    [['describe'], 'name what to describe', 'palm describe skill <name>'],
    [['describe', 'tdd'], '"tdd" is not something palm can describe', 'palm describe skill tdd'],
    [['create'], 'name what to create', 'palm create skill'],
  ])('palm %j → E_USAGE %j', (argv, message, hint) => {
    const err = usageError(argv as string[]);
    expect(err).toMatchObject({ code: 'E_USAGE', message });
    expect(err.hint).toContain(hint);
  });

  it('interpretWords is the same parser without commander', () => {
    expect(interpretWords('get', ['sk', 'a', 'b'])).toEqual({
      resource: 'skill',
      names: ['a', 'b'],
    });
    expect(interpretWords('install', ['wayfinder'])).toEqual({ names: ['wayfinder'] });
  });
});

describe('global flags go anywhere', () => {
  it.each([
    [['-g', 'get', 'skills']],
    [['get', '-g', 'skills']],
    [['get', 'skills', '-g']],
    [['ls', 'sk', '--global']],
  ])('palm %j', (argv) => {
    const { invocation } = parseArgv(argv);
    expect(invocation).toMatchObject({ command: 'get', resource: 'skill' });
    expect(invocation.opts.global).toBe(true);
  });

  it('keeps the options of each verb', () => {
    const inv = parseArgv(['get', 'skills', '--available', '-o', 'matt', '--json']).invocation;
    expect(inv.opts).toMatchObject({ available: true, origin: 'matt', json: true });
    const s = parseArgv(['search', 'x', '--kind', 'skill', '--refresh']).invocation;
    expect(s.opts).toMatchObject({ kind: 'skill', refresh: true });
    const c = parseArgv(['new', 'skill', 'x', '--no-install']).invocation;
    expect(c).toMatchObject({ command: 'create', resource: 'skill', names: ['x'] });
    expect(c.opts.install).toBe(false);
  });

  it('splits the ad hoc MCP command off at --', () => {
    const { invocation, passthrough } = parseArgv([
      'i',
      'mcp',
      'fs',
      '--',
      'npx',
      '-y',
      'srv',
      '-g',
    ]);
    expect(invocation).toMatchObject({ command: 'install', resource: 'mcp', names: ['fs'] });
    expect(invocation.opts.global).toBeUndefined();
    expect(passthrough).toEqual(['npx', '-y', 'srv', '-g']);
  });
});

describe('old grammar: hidden aliases forward to the new verbs', () => {
  const originOpts = ['--alias', 'a', '--ref', 'v1', '--root', 'sub', '--layout', 'skills=x/*'];

  it.each([
    [
      ['origin', 'add', 'owner/repo'],
      ['install', 'origin', 'owner/repo'],
    ],
    [
      ['origin', 'add', 'owner/repo', ...originOpts],
      ['install', 'origin', 'owner/repo', ...originOpts],
    ],
    [
      ['origin', 'add', 'x', '--project'],
      ['install', 'origin', 'x', '--project'],
    ],
    [
      ['origin', 'list'],
      ['get', 'origins'],
    ],
    [
      ['origin', 'ls'],
      ['get', 'origins'],
    ],
    [
      ['origin', 'remove', 'matt'],
      ['uninstall', 'origin', 'matt'],
    ],
    [
      ['origin', 'rm', 'matt'],
      ['uninstall', 'origin', 'matt'],
    ],
    [
      ['origin', 'update'],
      ['update', 'origins'],
    ],
    [
      ['origin', 'update', 'matt'],
      ['update', 'origin', 'matt'],
    ],
    [['targets'], ['get', 'targets']],
    [
      ['targets', '-g'],
      ['get', 'targets', '-g'],
    ],
    [
      ['list', 'skills', '--available'],
      ['get', 'skills', '--available'],
    ],
    [
      ['info', 'skill', 'tdd'],
      ['describe', 'skill', 'tdd'],
    ],
  ])('palm %j = palm %j', (old, current) => {
    const a = parseArgv(old).invocation;
    const b = parseArgv(current).invocation;
    expect(what(old)).toEqual(what(current));
    expect(a.opts).toEqual(b.opts);
  });

  it('palm origin import f = palm install origin f, read as a marketplace', () => {
    expect(what(['origin', 'import', 'dir', '--project'])).toEqual({
      command: 'install',
      resource: 'origin',
      names: ['dir'],
      marketplace: true,
    });
  });
});

describe('utilities', () => {
  it.each([
    [['init'], { command: 'init', names: [] }],
    [['doctor', '--offline'], { command: 'doctor', names: [] }],
    [['config', 'get'], { command: 'config get', names: [] }],
    [['config', 'get', 'targets'], { command: 'config get', names: ['targets'] }],
    [
      ['config', 'set', 'targets', 'claude'],
      { command: 'config set', names: ['targets', 'claude'] },
    ],
    [['completion', 'zsh'], { command: 'completion', names: ['zsh'] }],
    [['cache', 'info'], { command: 'cache info', names: [] }],
    [['cache', 'clean', '--yes'], { command: 'cache clean', names: [] }],
    [['outdated'], { command: 'outdated', names: [] }],
    [['outdated', 'skills'], { command: 'outdated', names: ['skills'] }],
    [['why', 'skill', 'tdd@matt'], { command: 'why', names: ['skill', 'tdd@matt'] }],
    [
      ['find', '.claude/skills/tdd/SKILL.md'],
      { command: 'find', names: ['.claude/skills/tdd/SKILL.md'] },
    ],
    [['audit'], { command: 'audit', names: [] }],
    [['audit', 'skill', 'tdd'], { command: 'audit', names: ['skill', 'tdd'] }],
  ])('palm %j', (argv, expected) => {
    expect(parseArgv(argv as string[]).invocation).toMatchObject(expected);
  });

  it('keeps the global flags and their own options', () => {
    expect(parseArgv(['outdated', '-g', '--json']).invocation.opts).toMatchObject({
      global: true,
      json: true,
    });
    expect(parseArgv(['audit', '--strip']).invocation.opts).toMatchObject({ strip: true });
    expect(parseArgv(['find', 'x', '-g']).invocation.opts).toMatchObject({ global: true });
  });

  it.each([[['why']], [['why', 'skill']], [['find']]])(
    'palm %j: a missing argument is a usage error',
    (argv) => {
      expect(() => parseArgv(argv)).toThrow(/missing required argument/);
    },
  );
});
