/**
 * The fix-cli rulings of the 0.2 persona rerun (FINDINGS-v2.md) about what commands print: each
 * test is named after its ids. The engine is faked with the results a persona saw.
 */
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CheckReport,
  InstallOutcome,
  LockEntry,
  UpdatePlan,
  UpdatePlanItem,
} from '../../src/core/types.js';
import type { EntityInfo, InstalledRow } from '../../src/create/engine.js';
import { createClackUI } from '../../src/ui/prompts.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import {
  entity,
  fakeEngine,
  fakeListing,
  fakeScope,
  lockEntry,
  outcome,
  palm,
  type ScopeSpec,
} from './fakes.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await removeDir(sb.root);
});

const scope = (over: Partial<ScopeSpec> = {}) =>
  fakeScope({ root: sb.project, targets: ['claude'], ...over });

const skill = (name: string, source = 'obra/superpowers'): LockEntry =>
  lockEntry({ kind: 'skill', name, source, files: [`.claude/skills/${name}/SKILL.md`] });

const result = (outcomes: InstallOutcome[]) => ({ outcomes, failures: [], warnings: [] });

const row = (entry: LockEntry): InstalledRow => ({ entry, source: {}, layer: 'team' });

describe('K21, B21, D13: a bare install prints what changed; notes once; skips per source', () => {
  it('collapses unchanged entries and prints a shared note once', async () => {
    const note = 'cursor reads .claude/skills; no second copy';
    const outcomes = [
      outcome(skill('a'), 're-rendered', [note]),
      outcome(skill('b'), 're-rendered', [note]),
      ...['c', 'd', 'e'].map((n) => outcome(skill(n), 'unchanged', [note])),
    ];
    const deps = fakeEngine({ scopes: [scope()], syncScope: async () => result(outcomes) });
    const r = await palm(sb, ['install'], { deps });
    expect(r.stdout).toBe(
      [
        '~ skill  a   .claude/skills/a/   1 file   (cursor reads .claude/skills; no second copy)',
        '~ skill  b   .claude/skills/b/   1 file',
        '2 re-rendered, 3 unchanged.',
        '',
      ].join('\n'),
    );
  });

  it('skipped entries of one source are one row', async () => {
    const outcomes = ['a', 'b', 'c'].map((n) =>
      outcome(skill(n, './kit'), 'skipped', ['a directory source; palm install re-renders it']),
    );
    const deps = fakeEngine({ scopes: [scope()], syncScope: async () => result(outcomes) });
    const r = await palm(sb, ['install'], { deps });
    expect(r.stdout).toBe(
      '⊘ source  ./kit   3 entries   a directory source; palm install re-renders it\n3 skipped.\n',
    );
  });

  it('the update plan counts unchanged entries and gives skipped ones a line per source', async () => {
    const item = (name: string, mark: UpdatePlanItem['mark'], source: string, note?: string) => ({
      mark,
      kind: 'skill' as const,
      name,
      source,
      atRisk: [],
      ...(note ? { note } : {}),
    });
    const plan: UpdatePlan = {
      scope: 'project',
      sources: [
        { name: 'obra/superpowers', ref: '^4', from: 'v4.0.3', to: 'v4.0.3', latest: 'v5.0.0' },
      ],
      items: [
        item('a', 'unchanged', 'obra/superpowers'),
        item('b', 'unchanged', 'obra/superpowers'),
        item('x', 'skipped', './kit', 'a directory source; palm install re-renders it'),
        item('y', 'skipped', './kit', 'a directory source; palm install re-renders it'),
      ],
      failures: [],
      warnings: [],
    };
    const deps = fakeEngine({ planUpdate: async () => plan, planChanges: () => 0 });
    const r = await palm(sb, ['update', '--dry-run'], { deps });
    expect(r.stdout).toBe(
      [
        'Update plan (project scope)',
        'obra/superpowers   ^4   v4.0.3   latest v5.0.0',
        '⊘ skipped   source   ./kit   2 entries   a directory source; palm install re-renders it',
        '= 2 unchanged',
        'Nothing to update.',
        '',
      ].join('\n'),
    );
  });
});

describe('L10, J10, Y6, R7: the lines under a row are commands that run', () => {
  it('L10: a kept edit names the way to keep it next to --force', async () => {
    const deps = fakeEngine({
      scopes: [scope({ scope: 'global' })],
      syncScope: async () => result([outcome(skill('tdd', 'mattpocock/skills'), 'modified')]),
    });
    const r = await palm(sb, ['install', '-g'], { deps });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      '    to keep your change, move it into your own source: palm create skill tdd -g\n',
    );
  });

  it('J10: a server from palm.yaml is shown as palm.yaml and installed with a bare install', async () => {
    const server = lockEntry({
      kind: 'mcp',
      name: 'brave-search',
      source: 'manifest',
      exec: { commands: [], hash: 'sha256:1' },
    });
    const deps = fakeEngine({
      scopes: [scope({ scope: 'global' })],
      syncScope: async () => result([outcome(server, 'skipped')]),
    });
    const r = await palm(sb, ['install', '-g'], { deps });
    expect(r.stdout).toContain('    see it:      palm install --dry-run --review -g\n');
    expect(r.stdout).toContain('    install it:  palm install -g\n');
    expect(r.stdout).not.toContain('manifest');
  });

  it('R7: a listing names kind:name where the source offers a name in two kinds', async () => {
    const listed = fakeListing({ name: 'cursor/plugins' }, [
      entity('continual-learning'),
      entity('continual-learning', { kind: 'agent' }),
    ]);
    const deps = fakeEngine({ scopes: [scope()], listSource: async () => listed });
    const r = await palm(sb, ['install', 'cursor/plugins'], { deps });
    expect(r.stdout).toContain(
      '    palm install cursor/plugins skill:continual-learning agent:continual-learning\n',
    );
  });
});

describe('L12, L15: --grep filters a listing; index notes are one line', () => {
  it('lists only the matches, pastes the first two, and offers no --all', async () => {
    const listed = fakeListing(
      { name: 'cursor/rules' },
      ['react-hooks', 'vue', 'react-query', 'react-native'].map((n) => entity(n)),
      { warnings: ['a', 'b'] },
    );
    const deps = fakeEngine({ scopes: [scope()], listSource: async () => listed });
    const r = await palm(sb, ['install', 'cursor/rules', '--grep', 'react'], { deps });
    expect(r.stdout).toContain('3 skills of 4 match "react"');
    expect(r.stdout).not.toContain('vue');
    expect(r.stdout).toContain('    palm install cursor/rules react-hooks react-query\n');
    expect(r.stdout).not.toContain('--all');
    expect(r.stdout).toContain(
      'i 2 notes from indexing cursor/rules (see: PALM_DEBUG=1 palm install cursor/rules)\n',
    );
    expect(r.stderr).toBe('');
  });

  it('says so when nothing matches and names the unfiltered listing', async () => {
    const listed = fakeListing({ name: 'cursor/rules' }, [entity('vue')]);
    const deps = fakeEngine({ scopes: [scope()], listSource: async () => listed });
    const r = await palm(sb, ['install', 'cursor/rules', '--grep', 'svelte'], { deps });
    expect(r.stdout).toContain('list everything it offers: palm install cursor/rules\n');
  });
});

describe('B11: at: is said at install and shown by get and describe', () => {
  it('install prints the placement once; get shows an at column', async () => {
    const placed = { ...skill('db'), at: 'packages/database' };
    const deps = fakeEngine({
      scopes: [scope()],
      installFromSource: async () => result([outcome(placed)]),
    });
    const r = await palm(sb, ['install', 'acme/kit', 'db', '--at', 'packages/database'], { deps });
    expect(r.stdout).toContain('i at packages/database (placed at the root until 0.3)\n');
    const get = await palm(sb, ['get'], {
      deps: fakeEngine({ listInstalled: async () => [row(placed)] }),
    });
    expect(get.stdout.split('\n')[0]).toMatch(/files\s+at$/);
    expect(get.stdout).toContain('packages/database');
  });
});

describe('B16, J20: targets print the root they resolve against; global paths read ~/', () => {
  it('get targets prints the root, and JSON carries it', async () => {
    const deps = () => fakeEngine({ scopes: [scope()] });
    const r = await palm(sb, ['get', 'targets'], { deps: deps() });
    expect(r.stdout.split('\n')[0]).toBe(`root: ${sb.project}`);
    const json = await palm(sb, ['get', 'targets', '--json'], { deps: deps() });
    expect(JSON.parse(json.stdout)).toMatchObject({ root: sb.project });
  });

  it('describe target -g prints ~/ paths', async () => {
    const global = fakeScope({ root: sb.home, scope: 'global', targets: ['claude'] });
    const r = await palm(sb, ['describe', 'target', 'claude', '-g'], {
      deps: fakeEngine({ scopes: [global] }),
    });
    expect(r.stdout).toContain('  root        ~\n');
    expect(r.stdout).toContain('  config dir  ~/.claude/\n');
  });
});

describe('J21, K18, J15, V12: describe finds what a person names', () => {
  it('J21: describe <source> <name> reads the index for an entity not installed', async () => {
    const mp = { name: 'mattpocock/skills' };
    const listed = fakeListing(mp, [entity('grill-me', { description: 'Grill the plan' })], {
      declared: true,
    });
    const deps = fakeEngine({
      scopes: [scope({ sources: [mp] })],
      listInstalled: async () => [],
      listSource: async () => listed,
    });
    const r = await palm(sb, ['describe', 'mattpocock/skills', 'grill-me'], { deps });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('skill grill-me  (offered by mattpocock/skills, not installed)');
    expect(r.stdout).toContain('  install it  palm install mattpocock/skills skill:grill-me\n');
  });

  it('K18, J15: a name two sources installed is ambiguous with a describe line per source', async () => {
    const a = lockEntry({ kind: 'agent', name: 'reviewer', source: 'acme' });
    const b = lockEntry({ kind: 'agent', name: 'reviewer', source: 'moved-kit' });
    const deps = fakeEngine({ listInstalled: async () => [row(a), row(b)] });
    const r = await palm(sb, ['describe', 'reviewer'], { deps });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      '    palm describe acme agent:reviewer\n    palm describe moved-kit agent:reviewer\n',
    );
  });

  it('V12: a bare file name is the installed path that ends with it', async () => {
    const hook = lockEntry({
      kind: 'hook',
      name: 'team',
      source: 'acme',
      files: ['.palm/assets/acme/team/hooks/setup.sh'],
    });
    const deps = fakeEngine({
      listInstalled: async (_ctx, _scope, q) => (q?.names ? [] : [row(hook)]),
      ownerOfPath: async (_ctx, path) => [{ entry: hook, match: 'file' as const, file: path }],
    });
    const r = await palm(sb, ['describe', 'setup.sh'], { deps });
    expect(r.stdout).toBe('.palm/assets/acme/team/hooks/setup.sh  file of hook team from acme\n');
  });
});

describe('L14, J25: get with an unknown --source, and without palm.yaml', () => {
  it('L14: an unknown --source is E_NOT_FOUND with the name it nearly is', async () => {
    const deps = fakeEngine({
      scopes: [scope({ sources: [{ name: 'PatrickJS/awesome-cursorrules' }] })],
    });
    const r = await palm(sb, ['get', '--source', 'awesome-cursorrule'], { deps });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      'x no source "awesome-cursorrule" in palm.yaml; did you mean PatrickJS/awesome-cursorrules?\n  palm get --source PatrickJS/awesome-cursorrules\n',
    );
  });

  it('J25: get sources without palm.yaml does not say palm.yaml declares nothing', async () => {
    const r = await palm(sb, ['get', 'sources'], { deps: fakeEngine({ scopes: [scope()] }) });
    expect(r.stdout).toBe(
      'No palm.yaml here yet; see what a source offers: palm install mattpocock/skills\n',
    );
  });
});

describe('K22: describe source prints the layout as YAML and one hash', () => {
  it('one line per kind, flow lists', async () => {
    const state = scope({ sources: [{ name: 'acme', url: 'https://x.dev/acme.git' }] });
    const ref = state.sources.byName('acme');
    if (ref) ref.source.layout = { skills: ['packages/*'], agents: 'people/*.md' };
    const deps = fakeEngine({
      scopes: [state],
      listSource: async () => fakeListing({ name: 'acme' }, [entity('review')]),
    });
    const r = await palm(sb, ['describe', 'source', 'acme'], { deps });
    expect(r.stdout).toContain(
      '  layout      skills: [packages/*]\n              agents: [people/*.md]\n',
    );
    expect(r.stdout.match(/8be01d4/g)).toHaveLength(1);
  });
});

describe('C24, D24: check groups the files of an entity; --quiet; skipped is not ✓', () => {
  const missing = (file: string) => ({
    entity: { kind: 'skill' as const, name: 'tdd', source: 'mattpocock/skills' },
    file,
    message: `${file} is missing`,
    fix: 'palm install',
  });
  const report: CheckReport = {
    scope: 'project',
    ok: false,
    checks: [
      { id: 'manifest-lock', label: 'palm.yaml and the lock agree', status: 'ok', problems: [] },
      {
        id: 'local-sources',
        label: 'in-repo sources (cache empty; run palm install)',
        status: 'skip' as CheckReport['checks'][number]['status'],
        problems: [],
      },
      {
        id: 'lock-disk',
        label: '8 generated files differ from the lock',
        status: 'fail',
        problems: Array.from({ length: 8 }, (_, i) => missing(`.claude/skills/tdd/f${i}.md`)),
      },
    ],
  };

  it('one line per entity with a count; a skipped check is -', async () => {
    const r = await palm(sb, ['check'], { deps: fakeEngine({ checkScope: async () => report }) });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(
      [
        '✓ palm.yaml and the lock agree',
        '- in-repo sources (cache empty; run palm install)',
        'x 8 generated files differ from the lock',
        '',
        'x skill tdd: 8 files are missing (.claude/skills/tdd/f0.md, …); fix: palm install',
        '',
      ].join('\n'),
    );
  });

  it('--quiet prints the problems alone; --json keeps every one', async () => {
    const deps = () => fakeEngine({ checkScope: async () => report });
    const quiet = await palm(sb, ['check', '--quiet'], { deps: deps() });
    expect(quiet.stdout).toBe(
      'x skill tdd: 8 files are missing (.claude/skills/tdd/f0.md, …); fix: palm install\n',
    );
    const json = await palm(sb, ['check', '--json'], { deps: deps() });
    expect(JSON.parse(json.stdout).checks[2].problems).toHaveLength(8);
  });
});

describe('Y26, C28, D27: JSON says what a dry run would do, versions as fields, variables', () => {
  it('C28: dry-run outcomes are would-install', async () => {
    const deps = fakeEngine({
      scopes: [scope()],
      installFromSource: async () => result([outcome(skill('tdd'))]),
    });
    const r = await palm(sb, ['install', 'obra/superpowers', 'tdd', '--dry-run', '--json'], {
      deps,
    });
    expect(JSON.parse(r.stdout).outcomes[0].status).toBe('would-install');
  });

  it('D27: update --dry-run --json carries { ref, sha }', async () => {
    const plan: UpdatePlan = {
      scope: 'project',
      sources: [{ name: 'mp', ref: '^1.2', from: 'v1.2.3 (6acc160)', to: 'v1.2.4 (8be01d4)' }],
      items: [
        {
          mark: 'updated',
          kind: 'skill',
          name: 'tdd',
          source: 'mp',
          from: 'content 1a2b3c4',
          to: 'content 5d6e7f8',
          atRisk: [],
        },
      ],
      failures: [],
      warnings: [],
    };
    const deps = fakeEngine({ planUpdate: async () => plan, planChanges: () => 1 });
    const r = await palm(sb, ['update', '--dry-run', '--json'], { deps });
    const doc = JSON.parse(r.stdout);
    expect(doc.plan.sources[0]).toMatchObject({
      from: { ref: 'v1.2.3', sha: '6acc160' },
      to: { ref: 'v1.2.4', sha: '8be01d4' },
    });
    expect(doc.plan.items[0]).toMatchObject({ from: { content: '1a2b3c4' } });
  });

  it('Y26: get mcp --json carries each server variables', async () => {
    const docs = lockEntry({ kind: 'mcp', name: 'docs', source: 'manifest' });
    const info = {
      entry: docs,
      source: {},
      files: {},
      notes: [],
      selectedBy: 'manifest',
      secrets: [{ name: 'DOCS_TOKEN', set: false }],
    } as EntityInfo;
    const deps = fakeEngine({
      listInstalled: async () => [row(docs)],
      describeEntity: async () => info,
    });
    const r = await palm(sb, ['get', 'mcp', '--json'], { deps });
    expect(JSON.parse(r.stdout).items[0].variables).toEqual([{ name: 'DOCS_TOKEN', set: false }]);
  });
});

describe('E18, K18, C3, V11: remove says what it kept and repeats the flags that apply', () => {
  it('kept files are named with their owner or source; the count is what left', async () => {
    const entry = lockEntry({
      kind: 'agent',
      name: 'reviewer',
      source: 'acme',
      files: ['.claude/agents/reviewer.md', '.cursor/agents/reviewer.md'],
    });
    const deps = fakeEngine({
      scopes: [
        scope({ entries: [entry], sources: [{ name: 'acme', url: 'https://x.dev/acme.git' }] }),
      ],
      removeEntities: async () => ({
        removed: [entry],
        failures: [],
        warnings: [],
        kept: [
          {
            entry: { kind: 'agent', name: 'reviewer', source: 'acme' },
            files: ['.cursor/agents/reviewer.md'],
            reason: 'owned' as const,
            by: 'agent reviewer from moved-kit',
          },
        ],
      }),
    });
    const r = await palm(sb, ['remove', 'acme', 'reviewer'], { deps });
    expect(r.stdout).toBe(
      '- agent  reviewer   .claude/agents/reviewer.md   1 file   (kept 1 file, owned by agent reviewer from moved-kit)\n1 removed.\n',
    );
  });

  it('V11: a remove hint carries --exclude when the run had it', async () => {
    const entry = skill('pr-helper', 'team');
    const deps = fakeEngine({
      scopes: [scope({ entries: [entry] })],
      removeEntities: async () => ({
        removed: [],
        warnings: [],
        failures: [
          {
            kind: 'skill' as const,
            name: 'pr-helper',
            source: 'team',
            code: 'E_CONFLICT',
            message: 'a file changed since palm wrote it',
            hint: 'palm remove team pr-helper --force',
          },
        ],
      }),
    });
    const r = await palm(sb, ['remove', 'team', 'pr-helper', '--exclude'], { deps });
    expect(r.stderr).toContain('  palm remove team pr-helper --force --exclude\n');
  });
});

describe('D10, D11: update hints and --strict', () => {
  it('D10: --to without one source names a declared source', async () => {
    const deps = fakeEngine({ scopes: [scope({ sources: [{ name: 'mattpocock/skills' }] })] });
    const r = await palm(sb, ['update', '--to', 'v1.2.3'], { deps });
    expect(r.stderr).toBe(
      'x --to moves the ref of one source\n  palm update mattpocock/skills --to v1.2.3\n',
    );
  });

  it('D11: --strict says why it exits 1', async () => {
    const plan: UpdatePlan = {
      scope: 'project',
      sources: [],
      items: [],
      failures: [],
      warnings: [],
    };
    const deps = fakeEngine({ planUpdate: async () => plan, planChanges: () => 1 });
    const r = await palm(sb, ['update', '--dry-run', '--strict'], { deps });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('i --strict exits 1: 1 change would apply\n');
  });
});

describe('D15, Y7: yes/no questions are [y/N] text; a line answers with its first key', () => {
  it('confirm reads y, n or Enter (the default)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (d) => (shown += d.toString()));
    const ui = createClackUI({ input, output });
    const no = ui.confirm('Apply 3 changes?', false);
    input.write('\r');
    expect(await no).toBe(false);
    const yes = ui.confirm('Apply 3 changes?', false);
    input.write('y');
    expect(await yes).toBe(true);
    expect(shown).toBe('Apply 3 changes? [y/N] n\nApply 3 changes? [y/N] y\n');
  });

  it('Y7: "n" then Enter in one read is no, and nothing is left for the next prompt', async () => {
    const input = new PassThrough();
    const ui = createClackUI({ input, output: new PassThrough() });
    const first = ui.consent('Allow?', { canDiff: false });
    input.write('n\n');
    expect(await first).toBe('no');
    const second = ui.consent('Allow?', { canDiff: false });
    input.write('y');
    expect(await second).toBe('yes');
  });
});

describe('migrate ends with palm check (the CLI part of the migrate rulings)', () => {
  it('prints the check and fails when it fails', async () => {
    const deps = fakeEngine({
      migrateScope: async () => ({
        manifest: 'targets: [claude]\n',
        lock: '',
        sourcesAdded: [],
        movedAssets: [],
        exec: [],
        warnings: [],
        failures: [],
      }),
      checkScope: async () => ({
        scope: 'project',
        ok: false,
        checks: [{ id: 'lock-disk', label: '1 file differs', status: 'fail', problems: [] }],
      }),
    });
    const r = await palm(sb, ['migrate'], { deps });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('\npalm check:\nx 1 file differs\n');
  });
});
