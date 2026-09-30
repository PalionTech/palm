/**
 * R7 (with K9, J9, J10, L6, E16, C23, D10): every command palm prints for a person to paste
 * parses under palm's own grammar, runs in the scope the command ran in, and names no
 * placeholder, no undeclared source key and no source that does not exist. Each scenario runs a
 * command over the fake engine; every `palm …` command in its output goes back through
 * `parseArgv` and is checked against what the scenario's palm.yaml declares. The persona cases
 * of the second rerun (O3 O7 R4' O15 J6' N11 T9 N7 Q3 O16) also say which names mean two kinds
 * (every command names them with the kind), which typed words every command carries (`--force`,
 * `#ref`, `--as`, `--layout`, quoted words) and which it never pastes (a typo, `manifest`).
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgv } from '../../src/commands/program.js';
import { PalmError } from '../../src/core/errors.js';
import { looksLikeSourceInput } from '../../src/core/source-input.js';
import type {
  CheckReport,
  EntityRefSpec,
  LockEntry,
  Scope,
  Source,
  UI,
} from '../../src/core/types.js';
import type { EntityInfo, InstalledRow } from '../../src/create/engine.js';
import { removeDir, type Sandbox, sandbox, write } from '../support/sandbox.js';
import {
  entity,
  type FakeEngine,
  type FakeSource,
  fakeEngine,
  fakeListing,
  fakeScope,
  fakeUI,
  lockEntry,
  outcome,
  palm,
  type ScopeSpec,
} from './fakes.js';

// extracting the commands -----------------------------------------------------------------------

const VERBS = new Set(
  'init install add i remove rm uninstall update up check get list ls describe info create new migrate cache completion'.split(
    ' ',
  ),
);

/** Where a command starts: a line (after its mark), or after `: `, `? `, `| `, `for example  `, `(see: `. */
const COMMAND_START =
  /(^\s*(?:[x!i+~=⊘↺-] )?|:\s+|\? |\| |for example {2}|\(see: |PALM_DEBUG=1 )palm /g;

/** Where it ends: prose after it (`; `, `: `, ` (`, `)`, `, `, two spaces) or the line's end. */
const COMMAND_END = /;\s|:\s|\s\(|\)|,\s| {2}|$/;

/** Every command palm offers in `text`; a 0.1 form that `is now` another is what was typed, not an offer. */
function commandsIn(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n'))
    for (const m of line.matchAll(COMMAND_START)) {
      const from = (m.index ?? 0) + m[0].length - 'palm '.length;
      const rest = line.slice(from);
      const end = COMMAND_END.exec(rest.slice(5));
      const cmd = rest.slice(0, 5 + (end?.index ?? rest.length)).replace(/\.$/, '');
      const after = rest.slice(cmd.length);
      const verb = cmd.split(' ')[1] ?? '';
      const form = cmd.includes('<') && after.includes('for example');
      const typed = / is (now|gone)$/.test(cmd) || /^ is (now|gone)/.test(after);
      if (VERBS.has(verb) && !form && !typed) found.push(cmd.trim());
    }
  return found;
}

/** Shell words: single quotes group, as a shell reads them. */
function shellWords(cmd: string): string[] {
  return [...cmd.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '');
}

interface Scenario {
  name: string;
  argv: string[];
  deps?: () => FakeEngine;
  /** The scope the command ran in (every hint carries it). */
  scope?: Scope;
  /** Source keys palm.yaml declares after the run. */
  declared?: string[];
  /** Hints of this scenario point at the other scope (`it is installed globally: … -g`). */
  flips?: boolean;
  ui?: () => UI;
  setup?: (sb: Sandbox) => Promise<void>;
  /** O3: names that mean two kinds; a command that names one without its kind cannot paste. */
  twoKinds?: string[];
  /** J6', O15, T9, N7: text every command of the scenario carries (`--force`, `#v1`, a quoted word). */
  carries?: string[];
  /** N11, Q3, O16, J10: words no command pastes (a typo, a source that lacks the name, `manifest`). */
  never?: string[];
}

/** What is wrong with `cmd` as a command to paste after `s`; empty when it runs. */
function problemsOf(cmd: string, s: Scenario): string[] {
  const problems: string[] = [];
  if (/[<>]|\.\.\.|…/.test(cmd)) problems.push('names a placeholder');
  const words = shellWords(cmd).slice(1);
  let inv: ReturnType<typeof parseArgv>['invocation'];
  try {
    inv = parseArgv(words).invocation;
  } catch (e) {
    return [...problems, `does not parse: ${(e as Error).message}`];
  }
  const global = words.includes('-g') || words.includes('--global');
  if (global !== ((s.scope ?? 'project') === 'global') && !s.flips) problems.push('wrong scope');
  const declared = new Set(s.declared ?? []);
  const known = (w: string) => declared.has(w) || looksLikeSourceInput(w);
  for (const w of sourceWords(inv, declared)) if (!known(w)) problems.push(`names source ${w}`);
  const named = inv.resource === 'source' ? [] : inv.names;
  if (named.some((n: EntityRefSpec) => /[@#]/.test(n.name))) problems.push('0.1 name form');
  return [...problems, ...typedProblems(cmd, inv, s)];
}

/** O3, J6', N11: a two-kind name without its kind, a typed word dropped, a word pasted that must not be. */
function typedProblems(cmd: string, inv: Parsed, s: Scenario): string[] {
  const problems: string[] = [];
  const bare = (name: string) => inv.names.some((n) => n.name === name && !n.kind);
  for (const name of s.twoKinds ?? [])
    if (bare(name)) problems.push(`names ${name} without its kind`);
  for (const text of s.carries ?? []) if (!cmd.includes(text)) problems.push(`drops ${text}`);
  const words = shellWords(cmd);
  for (const word of s.never ?? []) if (words.includes(word)) problems.push(`pastes ${word}`);
  return problems;
}

type Parsed = ReturnType<typeof parseArgv>['invocation'];

/** `describe <source> <name>` names a source; `describe source <s>` a declared one. */
function describedSources(inv: Parsed, names: string[], declared: Set<string>): string[] {
  if (inv.resource === 'source')
    return names.map((n) => (declared.has(n) || looksLikeSourceInput(n) ? n : `undeclared ${n}`));
  return !inv.resource && names.length === 2 ? [names[0] ?? ''] : [];
}

/** Per command, the words it reads as sources. */
const SOURCE_WORDS: Readonly<
  Record<string, (inv: Parsed, names: string[], declared: Set<string>) => string[]>
> = {
  install: (inv) => (inv.source ? [inv.source.split('#')[0] ?? ''] : []),
  remove: (inv) => (inv.source ? [inv.source] : []),
  describe: describedSources,
  update: (_inv, names) => names,
  get: (inv) => {
    const source = (inv.opts as { source?: string }).source;
    return source ? [source] : [];
  },
};

/** The words a command reads as sources. */
function sourceWords(inv: Parsed, declared: Set<string>): string[] {
  const names = inv.names.map((n) => n.name);
  return SOURCE_WORDS[inv.command]?.(inv, names, declared) ?? [];
}

describe('commandsIn', () => {
  it('finds the commands of hints, not the words of messages', () => {
    const text = [
      'x "tdd" is not a repository. palm installs from git repositories:',
      '    palm install <owner/repo> tdd             for example  palm install mattpocock/skills tdd',
      'i palm install skill tdd@mp is now: palm install mp skill:tdd',
      '! skill tdd: 2 files are missing; fix: palm install kit skill:tdd --force',
      '  a command installs as a skill; create writes skills',
      'i 2 notes from indexing kit (see: PALM_DEBUG=1 palm install ./kit)',
      '  pbpaste | palm install mcp --snippet -',
    ].join('\n');
    expect(commandsIn(text)).toEqual([
      'palm install mattpocock/skills tdd',
      'palm install mp skill:tdd',
      'palm install kit skill:tdd --force',
      'palm install ./kit',
      'palm install mcp --snippet -',
    ]);
  });

  it('a form line is allowed only next to its example', () => {
    const s: Scenario = { name: 'x', argv: [] };
    expect(problemsOf('palm install <owner/repo> tdd', s)).toContain('names a placeholder');
    expect(problemsOf('palm install acme review', s)).toEqual(['names source acme']);
    expect(problemsOf('palm install acme review', { ...s, declared: ['acme'] })).toEqual([]);
    expect(problemsOf('palm install ./kit x -g', s)).toEqual(['wrong scope']);
  });
});

// the scenarios -----------------------------------------------------------------------------------

const MP: FakeSource = { name: 'mattpocock/skills' };
const LOCAL_KIT: FakeSource = { name: './.ai/agent-kit', path: '/p/.ai/agent-kit' };
const URL = 'https://gitlab.acme.com/platform/company-agent-kit.git';

let sb: Sandbox;
beforeAll(async () => {
  sb = await sandbox();
  await mkdir(join(sb.project, '.agents-kit'), { recursive: true });
  await write(
    join(sb.palmHome, 'config.yaml'),
    'origins:\n  - alias: mp\n    type: git\n    url: https://github.com/mattpocock/skills.git\n',
  );
});
afterAll(async () => {
  await removeDir(sb.root);
});

const scopeOf = (over: Partial<ScopeSpec>) =>
  fakeScope({ root: sb.project, targets: ['claude'], ...over });

const grill = lockEntry({ kind: 'skill', name: 'grill', source: LOCAL_KIT.name });
const tdd = lockEntry({
  kind: 'skill',
  name: 'tdd',
  source: MP.name,
  files: ['.claude/skills/tdd/SKILL.md'],
});
const row = (entry: LockEntry): InstalledRow => ({ entry, source: {}, layer: 'team' });
const nothing = { outcomes: [], failures: [], warnings: [] };
const program = (source: string, name = 'guard') =>
  lockEntry({ kind: 'hook', name, source, exec: { commands: [], hash: 'sha256:1' } });

const engineWith = (sources: FakeSource[], extra: Parameters<typeof fakeEngine>[0] = {}) =>
  fakeEngine({ scopes: [scopeOf({ sources, entries: [tdd, grill] })], ...extra });

const installing = (sources: FakeSource[]) =>
  engineWith(sources, { installFromSource: async () => nothing });

const LISTINGS: Scenario[] = [
  {
    name: 'K9, D9, J9: listing an undeclared URL with #ref, --as, -g',
    argv: ['install', `${URL}#v1.3.1`, '--as', 'acme', '-g'],
    scope: 'global',
    deps: () =>
      fakeEngine({
        scopes: [scopeOf({ scope: 'global' })],
        listSource: async () =>
          fakeListing({ name: 'company-agent-kit' }, [entity('incident'), entity('notes')], {
            warnings: ['w'],
          }),
      }),
  },
  {
    name: 'listing a declared source, R7 kinds',
    argv: ['install', MP.name],
    declared: [MP.name],
    deps: () =>
      engineWith([MP], {
        listSource: async () =>
          fakeListing(MP, [entity('x'), entity('x', { kind: 'agent' })], {
            declared: true,
            warnings: ['w'],
          }),
      }),
  },
  {
    name: 'L12: --grep with no match',
    argv: ['install', MP.name, '--grep', 'svelte'],
    declared: [MP.name],
    deps: () =>
      engineWith([MP], {
        listSource: async () => fakeListing(MP, [entity('vue')], { declared: true }),
      }),
  },
];

const FIRST_WORDS: Scenario[] = [
  ['B17', ['install', 'grill']],
  ['E15', ['install', '.agents-kit', 'reviewer']],
  ['L6 owner', ['install', 'mattpocock', 'tdd']],
  ['L6 generic', ['install', 'frobnicate']],
  ['L5 rules', ['install', 'rules']],
  ['L5 subagent', ['install', 'subagent', 'reviewer']],
  ['L5 servers', ['install', 'servers']],
  ['L7 legacy alias', ['install', 'skill', 'grill-me@mattpocock']],
  ['J8 config alias', ['install', 'tdd@mp']],
  ['E16 unknown alias', ['install', 'tdd@acme']],
  ['C23 pinned name', ['install', 'tdd@mattpocock#v1.2.3']],
  ['J8 two aliases', ['install', 'tdd@mattpocock', 'grill@acme']],
  ['J8 origin', ['install', 'origin', 'obra/superpowers', 'mattpocock/skills']],
  ['names after a source', ['install', MP.name, 'tdd@x']],
  ['E4 --from', ['install', 'skill', 'tdd', '--from', 'mattpocock/skills#v1']],
  ['E4 --ref', ['install', MP.name, 'tdd', '--ref', 'v1']],
  ['E4 --alias', ['install', URL, 'review', '--alias', 'acme']],
  ['E4 --project', ['install', MP.name, 'tdd', '--project']],
  ['E7 --targets', ['install', '--targets', 'codex']],
  ['E7 --local', ['install', '--local', '--targets', 'codex']],
  ['--all without a source', ['install', '--all']],
].map(([name, argv]) => ({
  name: name as string,
  argv: argv as string[],
  declared: [MP.name, LOCAL_KIT.name],
  deps: () => installing([MP, LOCAL_KIT]),
}));

const FRESH: Scenario[] = [
  ['Nora', ['install', 'superpowers']],
  ['Lena', ['install', 'tdd']],
  ['fresh owner alias', ['install', 'tdd@mattpocock']],
  ['D10 fresh pinned', ['install', 'skill', 'tdd@mattpocock#v1.2.3']],
].map(([name, argv]) => ({
  name: name as string,
  argv: argv as string[],
  deps: () => fakeEngine({ scopes: [scopeOf({})] }),
}));

const GLOBAL: Scenario[] = [
  {
    name: 'K15: a project source under -g',
    argv: ['install', 'acme', 'review', '-g'],
    scope: 'global',
    deps: () =>
      fakeEngine({
        scopes: [
          scopeOf({ scope: 'global' }),
          scopeOf({ sources: [{ name: 'acme', url: 'https://github.com/acme/kit.git' }] }),
        ],
      }),
  },
  {
    name: 'K15: a local project source under -g',
    argv: ['install', 'kit', 'review', '-g'],
    scope: 'global',
    deps: () =>
      fakeEngine({
        scopes: [
          scopeOf({ scope: 'global' }),
          scopeOf({ sources: [{ name: 'kit', path: '/p/kit' }] }),
        ],
      }),
  },
  {
    name: 'J9: -g not-a-repository',
    argv: ['install', 'frobnicate', '-g'],
    scope: 'global',
    deps: () => fakeEngine({ scopes: [scopeOf({ scope: 'global' })] }),
  },
  {
    name: 'J12: init -g',
    argv: ['init', '-g', '--target', 'claude'],
    scope: 'global',
  },
  ...[
    ['install', 'mcp', 'docs', '-g'],
    ['install', 'mcp', 'docs', '--url', 'ftp://x', '-g'],
    ['doctor', '-g'],
    ['outdated', '-g'],
    ['describe', 'all', '-g'],
    ['describe', 'a', 'b', '-g'],
  ].map((argv) => ({
    name: `J9: ${argv.join(' ')}`,
    argv,
    scope: 'global' as const,
    deps: () => fakeEngine({ scopes: [scopeOf({ scope: 'global' })] }),
  })),
];

const MCP: Scenario[] = [
  ['no name', ['install', 'mcp', '--url', 'https://x.dev']],
  ['no flags', ['install', 'mcp', 'docs']],
  ['registry name', ['install', 'mcp', 'io.github.github/github-mcp-server']],
  ['missing snippet', ['install', 'mcp', '--snippet', 'missing.json']],
  ['bad server name', ['install', 'mcp', 'bad name', '--url', 'https://x.dev']],
].map(([name, argv]) => ({ name: `L4 ${name}`, argv: argv as string[] }));

/** The failure an edited file gives: its hint names the entity without a kind, as the engine does. */
const edited = (verb: string, source: string, name: string) => ({
  kind: 'skill' as const,
  name,
  source,
  code: 'E_CONFLICT',
  message: 'a file changed since palm wrote it',
  hint: `palm ${verb} ${source} ${name} --force`,
});

const SUMMARIES: Scenario[] = [
  {
    name: 'K9: a program left out, source not declared after the run',
    argv: ['install', URL, '--all', '--as', 'acme'],
    deps: () =>
      fakeEngine({
        scopes: [scopeOf({})],
        installFromSource: async () => ({
          ...nothing,
          outcomes: [outcome(program('acme'), 'skipped')],
        }),
      }),
  },
  {
    name: 'J10: a palm.yaml server left out, -g',
    argv: ['install', '-g'],
    scope: 'global',
    deps: () =>
      fakeEngine({
        scopes: [scopeOf({ scope: 'global' })],
        syncScope: async () => ({
          ...nothing,
          outcomes: [outcome(program('manifest', 'docs'), 'skipped')],
        }),
      }),
  },
  {
    name: 'L10, O17: a kept edit',
    argv: ['install'],
    declared: [MP.name],
    deps: () =>
      fakeEngine({
        scopes: [scopeOf({ sources: [MP] })],
        syncScope: async () => ({
          ...nothing,
          outcomes: [outcome(tdd, 'modified')],
          failures: [edited('install', MP.name, 'tdd')],
        }),
      }),
  },
  {
    name: 'K9, L20: an engine hint for an undeclared key and a corrected name',
    argv: ['install', URL, 'tdd', 'grill-mee', '--as', 'acme'],
    deps: () =>
      fakeEngine({
        scopes: [scopeOf({})],
        installFromSource: async () => {
          throw new PalmError(
            'E_NOT_FOUND',
            '"grill-mee" is not in source acme; did you mean grill-me?',
            'palm install acme grill-me',
          );
        },
      }),
  },
];

const removedNothing = { removed: [], failures: [], warnings: [] };

const removing = (extra: Parameters<typeof fakeEngine>[0] = {}, second?: boolean) =>
  fakeEngine({
    scopes: second
      ? [scopeOf({ sources: [MP] }), scopeOf({ scope: 'global', entries: [grill] })]
      : [scopeOf({ sources: [MP, { name: 'team' }], entries: [tdd, grill] })],
    removeEntities: async () => removedNothing,
    ...extra,
  });

const REMOVES: Scenario[] = [
  { name: 'B17: near name', argv: ['remove', 'gril'], declared: [MP.name], deps: () => removing() },
  {
    name: 'installed in the other scope',
    argv: ['remove', 'grill'],
    flips: true,
    deps: () => removing({}, true),
  },
  {
    name: 'V11: flags carried',
    argv: ['remove', 'team', 'pr-helper', '--exclude'],
    declared: ['team'],
    deps: () =>
      removing({
        removeEntities: async () => ({
          ...removedNothing,
          failures: [
            {
              kind: 'skill' as const,
              name: 'pr-helper',
              source: 'team',
              code: 'E_CONFLICT',
              message: 'changed',
              hint: 'palm remove team pr-helper --force',
            },
          ],
        }),
      }),
  },
  { name: 'needs a name', argv: ['remove', URL], deps: () => removing() },
  { name: 'origin', argv: ['remove', 'origin', 'x'], deps: () => removing() },
];

const plan = { scope: 'project' as const, sources: [], items: [], failures: [], warnings: [] };
const UPDATES: Scenario[] = [
  {
    name: 'D10: --to with a declared source',
    argv: ['update', '--to', 'v2'],
    declared: [MP.name],
    deps: () => engineWith([MP]),
  },
  { name: 'D10: --to with none', argv: ['update', '--to', 'v2'], deps: () => engineWith([]) },
  { name: 'kinds', argv: ['update', 'skill', 'tdd'], deps: () => engineWith([]) },
  {
    name: 'no terminal to confirm',
    argv: ['update'],
    deps: () => fakeEngine({ planUpdate: async () => plan, planChanges: () => 1 }),
  },
];

const describeInfo = (entry: LockEntry): EntityInfo => ({
  entry,
  source: {},
  files: {},
  notes: [],
  selectedBy: 'manifest',
  exec: { commands: [], hash: 'sha256:abc', trusted: false },
});

const READS: Scenario[] = [
  {
    name: 'L14: unknown --source',
    argv: ['get', '--source', 'mattpocock/skill'],
    declared: [MP.name],
    deps: () => engineWith([MP]),
  },
  {
    name: 'L14: unknown --source, nothing near',
    argv: ['get', '-s', 'zzz'],
    deps: () => engineWith([MP]),
  },
  {
    name: 'get: nothing named',
    argv: ['get', 'nope'],
    deps: () => fakeEngine({ listInstalled: async () => [] }),
  },
  {
    name: 'K18: describe ambiguity',
    argv: ['describe', 'reviewer'],
    declared: ['acme', 'moved-kit'],
    deps: () =>
      fakeEngine({
        listInstalled: async () => [
          row(lockEntry({ kind: 'agent', name: 'reviewer', source: 'acme' })),
          row(lockEntry({ kind: 'agent', name: 'reviewer', source: 'moved-kit' })),
        ],
      }),
  },
  {
    name: 'J21: describe not installed, one source',
    argv: ['describe', 'grill-me'],
    declared: [MP.name],
    deps: () => engineWith([MP], { listInstalled: async () => [] }),
  },
  {
    name: 'J21: describe from a source, a near name',
    argv: ['describe', MP.name, 'grill-mee'],
    declared: [MP.name],
    deps: () =>
      engineWith([MP], {
        listInstalled: async () => [],
        listSource: async () => fakeListing(MP, [entity('grill-me')], { declared: true }),
      }),
  },
  {
    name: 'describe source unknown',
    argv: ['describe', 'source', 'mattpocock/skill'],
    declared: [MP.name],
    deps: () => engineWith([MP]),
  },
  {
    name: 'describe target unknown',
    argv: ['describe', 'target', 'vim'],
    deps: () => engineWith([]),
  },
  {
    name: 'describe path unknown',
    argv: ['describe', './nope.md'],
    deps: () => fakeEngine({ ownerOfPath: async () => [] }),
  },
  {
    name: 'describe an untrusted program',
    argv: ['describe', 'hook:guard'],
    declared: [MP.name],
    deps: () =>
      fakeEngine({
        listInstalled: async () => [row(program(MP.name))],
        describeEntity: async () => describeInfo(program(MP.name)),
      }),
  },
];

const failing: CheckReport = {
  scope: 'project',
  ok: false,
  checks: [
    {
      id: 'lock-disk',
      label: 'x',
      status: 'fail',
      problems: [{ message: 'a is missing', file: 'a', fix: 'palm install' }],
    },
  ],
};

const OTHERS: Scenario[] = [
  {
    name: 'init: already lists',
    argv: ['init'],
    deps: () =>
      fakeEngine({
        scopes: [scopeOf({})],
        enclosingProject: () => undefined,
        loadManifest: async () => ({ targets: ['claude'] }) as never,
      }),
  },
  { name: 'create: a command', argv: ['create', 'command', 'x'] },
  { name: 'create: not a kind', argv: ['create', 'mcp', 'x', '-g'], scope: 'global' },
  {
    name: 'check fix lines',
    argv: ['check'],
    deps: () => fakeEngine({ checkScope: async () => failing }),
  },
  { name: 'cache clean without a terminal', argv: ['cache', 'clean'] },
  { name: 'search', argv: ['search', 'mcp', 'brave'] },
  { name: 'origin remove', argv: ['origin', 'remove', 'x'] },
  { name: 'describe two things', argv: ['describe', 'a', 'b'], deps: () => engineWith([]) },
];

// the second rerun: two kinds, typed options, typos ----------------------------------------------

const AGENTIC: FakeSource = { name: 'JanDeDobbeleer/agentic' };
const SHA = 'e276d99d85e7f5951e45d524fbcfe7436ee78a37';
const golang = lockEntry({
  kind: 'skill',
  name: 'golang',
  source: AGENTIC.name,
  files: ['.agents/skills/golang/SKILL.md'],
});
const golangRule = lockEntry({ kind: 'instruction', name: 'golang', source: AGENTIC.name });
const markdownRule = lockEntry({ kind: 'instruction', name: 'markdown', source: AGENTIC.name });

const agentic = (extra: Parameters<typeof fakeEngine>[0] = {}) =>
  fakeEngine({
    scopes: [scopeOf({ sources: [AGENTIC], entries: [golang, golangRule, markdownRule] })],
    ...extra,
  });

/** What a failing `check` reports for one entity, with the engine's fix. */
const checkFailing =
  (entity: { kind: 'skill' | 'mcp'; name: string; source: string }, fix: string) =>
  async (): Promise<CheckReport> => ({
    scope: 'project',
    ok: false,
    checks: [
      {
        id: 'lock-disk',
        label: 'generated files match the lock',
        status: 'fail',
        problems: [{ entity, message: 'a file differs from what palm renders', fix }],
      },
    ],
  });

const TWO_KINDS: Scenario[] = [
  {
    name: "O3: a kept edit's --force line names the kind",
    argv: ['install'],
    twoKinds: ['golang'],
    carries: ['skill:golang', '--force'],
    deps: () =>
      agentic({
        syncScope: async () => ({
          ...nothing,
          outcomes: [outcome(golang, 'modified')],
          failures: [edited('install', AGENTIC.name, 'golang')],
        }),
      }),
  },
  {
    name: 'O3: a check fix names the kind',
    argv: ['check'],
    twoKinds: ['golang'],
    carries: ['skill:golang', '--force'],
    deps: () =>
      agentic({
        checkScope: checkFailing(
          { kind: 'skill', name: 'golang', source: AGENTIC.name },
          `palm install ${AGENTIC.name} golang --force`,
        ),
      }),
  },
  {
    name: "R4': a remove hint names the kind, so it never loops back",
    argv: ['remove', 'skill:golang'],
    twoKinds: ['golang'],
    carries: ['skill:golang', '--force'],
    deps: () =>
      agentic({
        removeEntities: async () => ({
          ...removedNothing,
          failures: [edited('remove', AGENTIC.name, 'golang')],
        }),
      }),
  },
  {
    name: 'O7, O3: every ambiguous name is corrected in one command that keeps --force',
    argv: ['install', AGENTIC.name, 'golang', 'markdown', '--force'],
    twoKinds: ['golang', 'markdown'],
    carries: [`${AGENTIC.name} skill:golang instruction:markdown --force`],
    deps: () =>
      agentic({
        installFromSource: async () => {
          throw new PalmError(
            'E_AMBIGUOUS',
            `"golang" names 2 kinds in source ${AGENTIC.name}: skill:golang, instruction:golang; "markdown" names 2 kinds in source ${AGENTIC.name}: skill:markdown, instruction:markdown`,
            `palm install ${AGENTIC.name} skill:golang`,
          );
        },
      }),
  },
  {
    name: "Y19': a name two sources installed gets one line per owner, with the typed options",
    argv: ['remove', 'elysia', '--force'],
    declared: ['./kit2', './agent-kit'],
    carries: ['elysia', '--force'],
    deps: () =>
      fakeEngine({
        scopes: [
          scopeOf({
            sources: [
              { name: './kit2', path: '/p/kit2' },
              { name: './agent-kit', path: '/p/agent-kit' },
            ],
            entries: [
              lockEntry({ kind: 'skill', name: 'elysia', source: './kit2' }),
              lockEntry({ kind: 'instruction', name: 'elysia', source: './agent-kit' }),
            ],
          }),
        ],
        removeEntities: async () => {
          throw new PalmError(
            'E_AMBIGUOUS',
            '"elysia" is installed from 2 sources: ./kit2, ./agent-kit',
            'palm remove ./kit2 elysia',
          );
        },
      }),
  },
  {
    name: 'M2: a plugin member that keeps an edit points back at the plugin',
    argv: ['remove', 'obra/superpowers', 'plugin:superpowers'],
    carries: ['plugin:superpowers', '--force'],
    never: ['brainstorming', 'skill:brainstorming'],
    deps: () =>
      fakeEngine({
        scopes: [
          scopeOf({
            sources: [{ name: 'obra/superpowers' }],
            entries: [
              lockEntry({ kind: 'plugin', name: 'superpowers', source: 'obra/superpowers' }),
              lockEntry({
                kind: 'skill',
                name: 'brainstorming',
                source: 'obra/superpowers',
                via: 'plugin:superpowers',
              }),
            ],
          }),
        ],
        removeEntities: async () => ({
          ...removedNothing,
          failures: [
            {
              ...edited('remove', 'obra/superpowers', 'brainstorming'),
              source: 'obra/superpowers',
            },
          ],
        }),
      }),
  },
];

/** A layout on a fake source (the fakes build none). */
function withLayout(state: ReturnType<typeof scopeOf>, name: string, layout: Source['layout']) {
  const ref = state.sources.byName(name);
  if (ref) (ref.source as Source).layout = layout;
  return state;
}

const TYPED: Scenario[] = [
  {
    name: 'O15: --ref after install origin keeps the typed repository',
    argv: ['install', 'origin', AGENTIC.name, '--ref', SHA, '--project'],
    carries: [`${AGENTIC.name}#${SHA}`],
    never: ['mattpocock/skills', 'origin', '--project'],
    deps: () => installing([]),
  },
  {
    name: "J6': the lines of install origin with several repositories carry -g",
    argv: ['install', 'origin', 'mattpocock/skills', 'obra/superpowers', '-g'],
    scope: 'global',
    carries: [' -g'],
    deps: () => fakeEngine({ scopes: [scopeOf({ scope: 'global' })] }),
  },
  {
    name: 'T9, K9: listing lines keep a typed --as and --layout',
    argv: ['install', URL, '--as', 'acme', '--layout', 'skills=packages/*'],
    carries: [URL, '--as acme', "--layout 'skills=packages/*'"],
    deps: () =>
      fakeEngine({
        scopes: [scopeOf({})],
        listSource: async () => fakeListing({ name: 'company-agent-kit' }, [entity('incident')]),
      }),
  },
  {
    name: 'N7: a project source under -g keeps its --as and --layout',
    argv: ['install', 'acme', 'reviewer', '-g'],
    scope: 'global',
    carries: ['--as acme', "--layout 'agents=people/*.md'"],
    deps: () =>
      fakeEngine({
        scopes: [
          scopeOf({ scope: 'global' }),
          withLayout(scopeOf({ sources: [{ name: 'acme', url: URL }] }), 'acme', {
            agents: ['people/*.md'],
          }),
        ],
      }),
  },
  {
    name: "J6': a typed word with a glob or a space is quoted when a hint repeats it",
    argv: ['install', MP.name, 'tdd', '--layout', 'skills=packages/*', '--as', 'my kit'],
    flips: true,
    carries: ["'skills=packages/*'", "'my kit'"],
    deps: () =>
      fakeEngine({
        openScope: async () => {
          throw new PalmError(
            'E_USAGE',
            '~/.claude is inside the global claude directory, not a project; your own setup takes -g',
            `palm install ${MP.name} tdd --layout skills=packages/* --as my kit -g`,
          );
        },
      }),
  },
  {
    name: 'N11: a typo is never pasted into a command',
    argv: ['install', 'reveiw'],
    declared: ['acme'],
    never: ['reveiw'],
    deps: () =>
      fakeEngine({
        scopes: [
          scopeOf({
            sources: [{ name: 'acme', url: URL }],
            entries: [lockEntry({ kind: 'skill', name: 'review', source: 'acme' })],
          }),
        ],
      }),
  },
  {
    name: 'O16: a kind-word typo names the kind before any source matches',
    argv: ['install', 'skil', 'golang'],
    carries: ['skill:golang'],
    never: ['skil', 'golang'],
    deps: () => agentic(),
  },
  {
    name: 'Q3: a declared source is the example only when it offers the name',
    argv: ['install', 'context7'],
    declared: ['obra/superpowers'],
    never: ['obra/superpowers', 'context7'],
    deps: () => fakeEngine({ scopes: [scopeOf({ sources: [{ name: 'obra/superpowers' }] })] }),
  },
  {
    name: "Y20': a mistyped directory gets the one it nearly names",
    argv: ['install', './.agents-kti', 'reviewer'],
    carries: ['./.agents-kit reviewer'],
    never: ['./.agents-kti'],
    deps: () =>
      fakeEngine({
        scopes: [scopeOf({})],
        installFromSource: async () => {
          throw new PalmError(
            'E_SOURCE',
            `no directory at ${join(sb.project, '.agents-kti')}`,
            'check the path, then run palm install ./.agents-kti',
          );
        },
      }),
  },
  {
    name: "Y20', Q15: a repository that is not there gets the one it nearly names",
    argv: ['install', 'anthropic/skills', 'pdf'],
    carries: ['anthropics/skills pdf'],
    deps: () =>
      fakeEngine({
        scopes: [scopeOf({})],
        installFromSource: async () => {
          throw new PalmError(
            'E_NOT_FOUND',
            'repository not found or private: https://github.com/anthropic/skills.git',
            'check the name, then try: git ls-remote https://github.com/anthropic/skills.git',
          );
        },
      }),
  },
  {
    name: "K15, X12, Y21': a project's directory under -g points back at the project",
    argv: ['install', './.agents-kit', 'reviewer', '-g'],
    scope: 'global',
    flips: true,
    carries: ['./.agents-kit reviewer'],
    never: ['-g'],
    deps: () =>
      fakeEngine({
        scopes: [scopeOf({ scope: 'global' })],
        installFromSource: async () => {
          throw new PalmError(
            'E_SOURCE',
            `${join(sb.project, '.agents-kit')} is outside the project ${sb.home}; a local source is a directory inside it`,
            'move the directory into the project, or publish it as a git repository and palm install its URL',
          );
        },
      }),
  },
  {
    name: "J10, R16': a palm.yaml server's fix is palm install mcp, never manifest",
    argv: ['check'],
    carries: ['palm install mcp docs --force'],
    never: ['manifest'],
    deps: () =>
      fakeEngine({
        checkScope: checkFailing(
          { kind: 'mcp', name: 'docs', source: 'manifest' },
          'palm install manifest docs --force',
        ),
      }),
  },
  {
    name: 'O25, Q17: removing a whole source asks, and --yes answers without a terminal',
    argv: ['remove', MP.name],
    declared: [MP.name],
    carries: [`palm remove ${MP.name} --yes`],
    deps: () => engineWith([MP]),
  },
  {
    name: 'M4: --local on an install points at the global scope',
    argv: ['install', MP.name, 'tdd', '--local'],
    flips: true,
    carries: [`${MP.name} tdd -g`],
  },
];

const SCENARIOS: Scenario[] = [
  ...TWO_KINDS,
  ...TYPED,
  ...LISTINGS,
  ...FIRST_WORDS,
  ...FRESH,
  ...GLOBAL,
  ...MCP,
  ...SUMMARIES,
  ...REMOVES,
  ...UPDATES,
  ...READS,
  ...OTHERS,
];

describe('R7: every hint palm prints parses under the grammar and runs where it was printed', () => {
  const seen: string[] = [];

  it.each(SCENARIOS.map((s) => [s.name, s] as const))('%s', async (_name, s) => {
    await s.setup?.(sb);
    const r = await palm(sb, s.argv, {
      ...(s.deps ? { deps: s.deps() } : {}),
      ui: s.ui?.() ?? fakeUI(),
    });
    const commands = commandsIn(`${r.stdout}\n${r.stderr}`);
    expect(
      commands.length,
      `${s.name} printed no command:\n${r.stdout}${r.stderr}`,
    ).toBeGreaterThan(0);
    const bad = commands
      .map((cmd) => ({ cmd, problems: problemsOf(cmd, s) }))
      .filter((c) => c.problems.length);
    expect(bad, `${r.stdout}${r.stderr}`).toEqual([]);
    seen.push(...commands);
  });

  it('covered every kind of hint', () => {
    expect(new Set(seen.map((c) => c.split(' ')[1])).size).toBeGreaterThanOrEqual(8);
  });
});
