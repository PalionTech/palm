/** The other verbs and utilities over the fake engine: what they ask the engine and what they print. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CheckReport,
  ExecUnit,
  MigrateReport,
  RemoveResult,
  TargetId,
  UpdatePlan,
} from '../../src/core/types.js';
import type { EntityInfo } from '../../src/create/engine.js';
import type { Manifest } from '../../src/domain/manifest.js';
import type { ScopePaths } from '../../src/domain/scope-paths.js';
import { exists, read, removeDir, type Sandbox, sandbox, write } from '../support/sandbox.js';
import { fakeEngine, fakeScope, fakeUI, lockEntry, outcome, palm } from './fakes.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await removeDir(sb.root);
});

const tdd = lockEntry({
  kind: 'skill',
  name: 'tdd',
  source: 'mattpocock/skills',
  render: { claude: 'sha256:1', cursor: 'sha256:1' },
  files: ['.claude/skills/tdd/SKILL.md'],
});
const docs = lockEntry({
  kind: 'mcp',
  name: 'docs',
  source: 'manifest',
  render: { claude: 'sha256:2' },
  merged: [{ file: '.mcp.json', at: '/mcpServers', id: 'palm:mcp:docs:0', key: 'docs' }],
});
const mp = {
  url: 'https://github.com/mattpocock/skills.git',
  ref: '^1.2',
  resolved: 'v1.2.3',
  sha: '8be01d4aa',
};

describe('palm get', () => {
  const rows = [
    { entry: tdd, source: mp, layer: 'team' as const },
    { entry: docs, source: {}, layer: 'team' as const },
  ];

  it('lists what is installed with source, ref, sha, targets, files and layer', async () => {
    const deps = fakeEngine({ listInstalled: async () => rows });
    const r = await palm(sb, ['get'], { deps });
    expect(r.stdout).toBe(
      [
        'kind   name  source             ref            sha      targets        files        layer',
        '─────  ────  ─────────────────  ─────────────  ───────  ─────────────  ───────────  ─────',
        'skill  tdd   mattpocock/skills  ^1.2 → v1.2.3  8be01d4  claude,cursor  1            team',
        'mcp    docs  manifest                                   claude         0 +1 merged  team',
        '',
      ].join('\n'),
    );
  });

  it('passes the kind, the names and --source to the engine', async () => {
    const deps = fakeEngine({ listInstalled: async () => rows.slice(0, 1) });
    await palm(sb, ['get', 'skills', 'tdd', '-s', 'mattpocock/skills'], { deps });
    expect(deps.calls.listInstalled?.[0]).toEqual([
      'project',
      { kind: 'skill', names: ['tdd'], source: 'mattpocock/skills' },
    ]);
  });

  it('--files prints every generated path with its entry', async () => {
    const deps = fakeEngine({ listInstalled: async () => rows });
    const r = await palm(sb, ['get', '--files'], { deps });
    expect(r.stdout).toBe(
      [
        '.claude/skills/tdd/SKILL.md  skill tdd  mattpocock/skills',
        '.mcp.json (merged)           mcp docs   manifest',
        '',
      ].join('\n'),
    );
  });

  it('get mcp shows the variables each server needs', async () => {
    const info = {
      entry: docs,
      source: {},
      files: {},
      notes: [],
      selectedBy: 'manifest',
      secrets: [{ name: 'DOCS_TOKEN', set: false }],
    } as EntityInfo;
    const deps = fakeEngine({
      listInstalled: async () => rows.slice(1),
      describeEntity: async () => info,
    });
    const r = await palm(sb, ['get', 'mcp'], { deps });
    expect(r.stdout).toContain('docs needs DOCS_TOKEN (not set)');
  });

  it('says so when nothing is installed, and fails for names that are not', async () => {
    const deps = fakeEngine({ listInstalled: async () => [] });
    const empty = await palm(sb, ['get', 'agents'], { deps });
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain('No agents installed in the project scope.');
    const missing = await palm(sb, ['get', 'nope'], { deps });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe('x nothing named nope is installed\n  palm get\n');
  });

  it('get sources and get targets read palm.yaml and the lock', async () => {
    const state = fakeScope({
      root: sb.project,
      targets: ['claude', 'cursor'],
      sources: [
        { name: 'mattpocock/skills', alias: 'mp', ref: '^1.2' },
        { name: './agent-kit', path: join(sb.project, 'agent-kit') },
      ],
      lockSources: {
        'mattpocock/skills': mp,
        './agent-kit': { path: 'agent-kit', tree: 'sha256:10934f8aa' },
      },
      entries: [tdd],
    });
    const sources = await palm(sb, ['get', 'sources'], { deps: fakeEngine({ scopes: [state] }) });
    expect(sources.stdout.split('\n').slice(2, 4)).toEqual([
      'mattpocock/skills  mp     git    ^1.2 → v1.2.3  8be01d4   1',
      './agent-kit               local  tree 10934f8   10934f8   0',
    ]);
    const targets = await palm(sb, ['get', 'targets'], { deps: fakeEngine({ scopes: [state] }) });
    expect(targets.stdout).toContain('claude    Claude    yes     .claude');
    expect(targets.stdout).toContain('codex     Codex     no      .codex');
  });
});

describe('palm describe', () => {
  it('prints an entity: source, ref, files per harness, notes, programs and trust', async () => {
    const hook = lockEntry({
      kind: 'hook',
      name: 'gh-cli',
      source: 'trailofbits/skills',
      path: 'plugins/gh-cli/hooks/hooks.json',
    });
    const info: EntityInfo = {
      entry: hook,
      source: { url: 'https://github.com/trailofbits/skills.git', ref: 'v2.1.0', sha: '82fe822aa' },
      files: { claude: ['.palm/assets/trailofbits__skills/gh-cli/hooks/a.sh'] },
      notes: ['opencode has no declarative hooks; skipped'],
      exec: {
        commands: [{ id: 'SessionStart//-', command: 'bash a.sh' }],
        hash: 'sha256:a7cc7911ff',
        trusted: false,
      },
      selectedBy: 'plugin:gh-cli',
    };
    const r = await palm(sb, ['describe', 'hook:gh-cli'], {
      deps: fakeEngine({ describeEntity: async () => info }),
    });
    expect(r.stdout).toBe(
      [
        'hook gh-cli  (installed, project scope)',
        '  source      trailofbits/skills  https://github.com/trailofbits/skills.git',
        '  ref         v2.1.0  82fe822',
        '  path        plugins/gh-cli/hooks/hooks.json',
        '  selected by plugin:gh-cli',
        '  claude      .palm/assets/trailofbits__skills/gh-cli/hooks/a.sh',
        '  note        opencode has no declarative hooks; skipped',
        '  runs        SessionStart//-  bash a.sh',
        '  trust       not trusted; allow it: palm install --allow-exec hook:gh-cli@trailofbits/skills=sha256:a7cc7911',
        '',
      ].join('\n'),
    );
  });

  it('for a path, the entity that wrote it', async () => {
    const deps = fakeEngine({
      ownerOfPath: async () => [
        { entry: tdd, match: 'file' as const, file: '.claude/skills/tdd/SKILL.md' },
      ],
    });
    const r = await palm(sb, ['describe', '.claude/skills/tdd/SKILL.md'], { deps });
    expect(r.stdout).toBe(
      '.claude/skills/tdd/SKILL.md  file of skill tdd from mattpocock/skills\n',
    );
    const none = await palm(sb, ['describe', 'obra/superpowers'], {
      deps: fakeEngine({ ownerOfPath: async () => [] }),
    });
    expect(none.code).toBe(1);
    expect(none.stderr).toBe(
      'x no installed entity wrote obra/superpowers\n  palm describe source obra/superpowers\n',
    );
  });

  it('describe source and describe target', async () => {
    const state = fakeScope({
      root: sb.project,
      targets: ['claude'],
      sources: [{ name: 'mattpocock/skills', ref: '^1.2' }],
      lockSources: { 'mattpocock/skills': { ...mp, descriptor: 'convention' } },
      entries: [tdd],
    });
    const deps = fakeEngine({
      scopes: [state],
      listSource: async () => {
        throw new Error('offline');
      },
    });
    const source = await palm(sb, ['describe', 'source', 'mattpocock/skills'], { deps });
    expect(source.stdout).toContain('  ref         ^1.2 → v1.2.3');
    expect(source.stdout).toContain('  detected    convention');
    expect(source.stdout).toContain('  offers      unknown (palm could not fetch it)');
    const target = await palm(sb, ['describe', 'target', 'cursor'], {
      deps: fakeEngine({ scopes: [state] }),
    });
    expect(target.stdout).toBe(
      [
        'target cursor  (Cursor)',
        '  active      no (add it to targets: in palm.yaml)',
        '  config dir  .cursor',
        '  writes to   .cursor/skills, .cursor/agents',
        '',
      ].join('\n'),
    );
  });

  it('shows one thing at a time', async () => {
    const r = await palm(sb, ['describe', 'tdd', 'handoff']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('x palm describe shows one thing at a time\n  palm describe tdd\n');
  });
});

describe('palm remove', () => {
  const removed = (result: Partial<RemoveResult>) =>
    fakeEngine({
      scopes: [
        fakeScope({ root: sb.project, sources: [{ name: 'acme-kit', url: 'https://x/acme.git' }] }),
      ],
      removeEntities: async () => ({ removed: [], failures: [], warnings: [], ...result }),
    });

  it('removes and says what was already absent (exit 0)', async () => {
    const deps = removed({ removed: [tdd] });
    const r = await palm(sb, ['remove', 'tdd', 'handoff'], { deps });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      '- skill  tdd   .claude/skills/tdd/   1 file\n1 removed.\ni handoff is not installed\n',
    );
  });

  it('reads a declared source as the first word and passes --exclude', async () => {
    const deps = removed({});
    await palm(sb, ['remove', 'acme-kit', 'reviewer', '--exclude'], { deps });
    expect(deps.calls.removeEntities?.[0]?.slice(0, 2)).toEqual([
      [{ name: 'reviewer', source: 'acme-kit' }],
      { scope: 'project', exclude: true },
    ]);
  });

  it('a file you changed keeps the entity and exits 1 with the --force command', async () => {
    const failure = {
      kind: 'skill' as const,
      name: 'tdd',
      source: 'mattpocock/skills',
      code: 'E_CONFLICT',
      message: '.claude/skills/tdd/SKILL.md was modified since install',
      hint: 'palm remove mattpocock/skills tdd --force',
    };
    const r = await palm(sb, ['remove', 'tdd'], { deps: removed({ failures: [failure] }) });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      'x skill tdd from mattpocock/skills: .claude/skills/tdd/SKILL.md was modified since install\n  palm remove mattpocock/skills tdd --force\n',
    );
    expect(r.stdout).not.toContain('is not installed');
  });

  it('needs a name', async () => {
    const r = await palm(sb, ['remove', 'obra/superpowers'], { deps: removed({}) });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      'x name what to remove from obra/superpowers\n  palm get --source obra/superpowers\n',
    );
  });
});

describe('palm update', () => {
  const unit = (hash: string, files: Array<[string, string]>): ExecUnit => ({
    kind: 'hook',
    entity: { kind: 'hook', name: 'team-skills', source: 'acme-kit' },
    key: 'hook:team-skills@acme-kit',
    commands: [],
    closure: {
      root: '.palm/assets/acme-kit/team-skills',
      inPlace: false,
      files: files.map(([path, h]) => ({ path, mode: 0o755, hash: h })),
      bytes: 10,
    },
    hash,
    rendered: {},
  });
  const plan: UpdatePlan = {
    scope: 'project',
    sources: [
      { name: 'mattpocock/skills', ref: '^1.2', from: 'v1.2.0 (3f2a1c9)', to: 'v1.2.3 (8be01d4)' },
    ],
    items: [
      {
        mark: 'updated',
        kind: 'skill',
        name: 'tdd',
        source: 'mattpocock/skills',
        atRisk: ['.claude/skills/tdd/SKILL.md'],
      },
      {
        mark: 'added',
        kind: 'skill',
        name: 'review',
        source: 'acme-kit',
        via: 'plugin:kit',
        atRisk: [],
      },
      {
        mark: 'updated',
        kind: 'hook',
        name: 'team-skills',
        source: 'acme-kit',
        atRisk: [],
        exec: {
          unit: unit('sha256:3e01a9f2bb', [['setup.sh', 'sha256:2']]),
          previous: unit('sha256:a7cc7911aa', [['setup.sh', 'sha256:1']]),
        },
      },
    ],
    failures: [],
    warnings: [],
  };

  it('--dry-run prints the plan, programs and changed files, and writes nothing', async () => {
    const deps = fakeEngine({ planUpdate: async () => plan, planChanges: () => 3 });
    const r = await palm(sb, ['update', '--dry-run'], { deps });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        'Update plan (project scope)',
        'mattpocock/skills   ^1.2   v1.2.0 (3f2a1c9) → v1.2.3 (8be01d4)',
        '~ updated   skill   tdd                   mattpocock/skills',
        '+ added     skill   review (plugin:kit)   acme-kit',
        '~ updated   hook    team-skills           acme-kit',
        '! hook team-skills: setup.sh changed (sha256:a7cc7911… → 3e01a9f2…); d shows the diff',
        '! you changed these files since palm wrote them; palm overwrites them only with --force:',
        '    .claude/skills/tdd/SKILL.md  (skill tdd)',
        'dry run: nothing written.',
        '',
      ].join('\n'),
    );
    expect(deps.calls.applyUpdate).toBeUndefined();
  });

  it('--strict exits 1 when a source is behind', async () => {
    const deps = fakeEngine({ planUpdate: async () => plan, planChanges: () => 3 });
    expect((await palm(sb, ['update', '--dry-run', '--strict'], { deps })).code).toBe(1);
  });

  it('asks, default no; --yes applies and prints the summary', async () => {
    const before = fakeScope({ root: sb.project, manifestTargets: ['claude'], entries: [tdd] });
    const deps = fakeEngine({
      scopes: [before],
      planUpdate: async () => plan,
      planChanges: () => 3,
      applyUpdate: async () => ({
        outcomes: [outcome(tdd, 'updated')],
        failures: [],
        warnings: [],
      }),
    });
    const r = await palm(sb, ['update', 'mattpocock/skills', '--to', '^2', '--yes'], { deps });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('~ skill  tdd   .claude/skills/tdd/   1 file\n1 updated.\n');
    expect(deps.calls.planUpdate?.[0]?.slice(0, 2)).toEqual([
      ['mattpocock/skills'],
      { scope: 'project', to: '^2' },
    ]);
    expect(deps.calls.applyUpdate?.[0]?.[1]).toEqual({ scope: 'project', to: '^2' });
  });

  it('--review pages the diffs before asking', async () => {
    const deps = fakeEngine({
      planUpdate: async () => plan,
      planChanges: () => 3,
      reviewText: async () => '--- setup.sh\n+++ setup.sh\n-echo 1\n+echo 2\n',
    });
    const r = await palm(sb, ['update', '--review', '--dry-run'], { deps });
    expect(r.stdout).toContain('--- setup.sh\n+++ setup.sh\n-echo 1\n+echo 2\n');
  });

  it('--to moves one source', async () => {
    const r = await palm(sb, ['update', '--to', '^2']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('x --to moves the ref of one source');
  });
});

describe('palm install <source> <names>', () => {
  it('hands src/exec the command line and --review through the context', async () => {
    const seen: Array<{ argv?: readonly string[]; review?: boolean }> = [];
    const deps = fakeEngine({
      scopes: [fakeScope({ root: sb.project, manifestTargets: ['claude'], entries: [tdd] })],
      installFromSource: async (ctx) => {
        const c = ctx as typeof ctx & { argv?: readonly string[]; flags: { review?: boolean } };
        seen.push({ argv: c.argv, review: c.flags.review });
        return { outcomes: [], failures: [], warnings: [] };
      },
    });
    await palm(sb, ['install', 'trailofbits/skills', 'gh-cli', '--review'], { deps });
    expect(seen).toEqual([
      { argv: ['install', 'trailofbits/skills', 'gh-cli', '--review'], review: true },
    ]);
  });

  it('prints the two lines for a program --all left out (skipped, not trusted)', async () => {
    const hook = lockEntry({
      kind: 'hook',
      name: 'gh-cli',
      source: 'trailofbits/skills',
      exec: { commands: [], hash: 'sha256:a7cc7911' },
    });
    const deps = fakeEngine({
      scopes: [fakeScope({ root: sb.project, manifestTargets: ['claude'], entries: [tdd] })],
      installFromSource: async () => ({
        outcomes: [outcome(tdd), outcome(hook, 'skipped')],
        failures: [],
        warnings: [],
      }),
    });
    const r = await palm(sb, ['install', 'trailofbits/skills', '--all'], { deps });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        '+ skill  tdd      .claude/skills/tdd/   1 file',
        '! hook   gh-cli   runs a program on your machine; not installed',
        '    see it:      palm install trailofbits/skills gh-cli --dry-run',
        '    install it:  palm install trailofbits/skills gh-cli',
        '1 installed.',
        '',
      ].join('\n'),
    );
  });
});

describe('palm install (bare): make the disk match palm.yaml', () => {
  it('prints = unchanged per entry and writes nothing on a clean clone', async () => {
    const state = fakeScope({ root: sb.project, manifestTargets: ['claude'], entries: [tdd] });
    const deps = fakeEngine({
      scopes: [state],
      syncScope: async () => ({
        outcomes: [outcome(tdd, 'unchanged')],
        failures: [],
        warnings: [],
      }),
    });
    const r = await palm(sb, ['install'], { deps });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('= skill  tdd   .claude/skills/tdd/   1 file\n1 unchanged.\n');
    expect(deps.calls.syncScope?.[0]).toEqual([{ scope: 'project' }, expect.any(Object)]);
  });

  it('says when palm.yaml lists nothing', async () => {
    const deps = fakeEngine({
      scopes: [fakeScope({ root: sb.project })],
      syncScope: async () => ({ outcomes: [], failures: [], warnings: [] }),
    });
    const r = await palm(sb, ['install'], { deps });
    expect(r.stdout).toBe(
      'i nothing to install: palm.yaml lists no entries\nsee what a source offers: palm install <owner/repo>\n',
    );
  });

  it('--all needs a source', async () => {
    const r = await palm(sb, ['install', '--all']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('palm install obra/superpowers --all');
  });
});

describe('palm init', () => {
  function initEngine(
    opts: { found?: TargetId[]; enclosing?: string; existing?: TargetId[] } = {},
  ) {
    let targets: TargetId[] | undefined = opts.existing;
    const manifest = {
      get targets() {
        return targets;
      },
      setTargets(t: TargetId[]) {
        targets = t;
        return this;
      },
      async save(file: string) {
        await writeFile(file, `targets: [${targets?.join(', ')}]\n`);
      },
    } as unknown as Manifest;
    return fakeEngine({
      loadManifest: async () => manifest,
      scopePaths: (scope, root) => ({ scope, root }) as unknown as ScopePaths,
      detectTargets: async () => opts.found ?? ['claude'],
      enclosingProject: () => opts.enclosing,
    });
  }

  it('writes the targets found here and the two ignore lines', async () => {
    const r = await palm(sb, ['init'], { deps: initEngine({ found: ['claude', 'cursor'] }) });
    expect(r.code).toBe(0);
    expect(await read(join(sb.project, 'palm.yaml'))).toBe('targets: [claude, cursor]\n');
    expect(await read(join(sb.project, '.gitignore'))).toBe('.palm/local/\npalm.local.yaml\n');
    expect(r.stdout).toBe(
      [
        '+ wrote palm.yaml: targets claude, cursor',
        '+ wrote .gitignore: .palm/local/, palm.local.yaml',
        'next: see what a source offers, for example palm install mattpocock/skills',
        '',
      ].join('\n'),
    );
  });

  it('keeps an existing .gitignore and adds only what is missing', async () => {
    await write(join(sb.project, '.gitignore'), 'node_modules\n/palm.local.yaml');
    await palm(sb, ['init', '--target', 'codex'], { deps: initEngine() });
    expect(await read(join(sb.project, '.gitignore'))).toBe(
      'node_modules\n/palm.local.yaml\n.palm/local/\n',
    );
    expect(await read(join(sb.project, 'palm.yaml'))).toBe('targets: [codex]\n');
  });

  it('refuses inside a project unless --here', async () => {
    const jobs = join(sb.project, 'packages', 'jobs');
    await write(join(jobs, '.keep'), '');
    const deps = initEngine({ enclosing: sb.project });
    const r = await palm(sb, ['init'], { deps, cwd: jobs });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      `x packages/jobs is inside project ${sb.project} (palm.yaml). Add entries with --at packages/jobs, or start a separate project here: palm init --here\n`,
    );
    expect(await exists(join(jobs, 'palm.yaml'))).toBe(false);
    const here = await palm(sb, ['init', '--here'], { deps, cwd: jobs });
    expect(here.code).toBe(0);
    expect(await exists(join(jobs, 'palm.yaml'))).toBe(true);
  });

  it('leaves targets palm.yaml already lists, unless --target', async () => {
    const r = await palm(sb, ['init'], { deps: initEngine({ existing: ['claude'] }) });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      'i palm.yaml already lists targets: claude\nchange them: palm init --target claude,cursor\n',
    );
    expect(await exists(join(sb.project, 'palm.yaml'))).toBe(false);
    await palm(sb, ['init', '--target', 'cursor'], { deps: initEngine({ existing: ['claude'] }) });
    expect(await read(join(sb.project, 'palm.yaml'))).toBe('targets: [cursor]\n');
  });

  it('needs a target when none is found, and is a project command', async () => {
    const none = await palm(sb, ['init'], { deps: initEngine({ found: [] }) });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('palm init --target claude');
    const global = await palm(sb, ['init', '-g']);
    expect(global.code).toBe(2);
  });
});

describe('utilities', () => {
  it('cache clean needs --yes without a terminal', async () => {
    const deps = fakeEngine({ cleanCache: async () => ({ removedBytes: 2048 }) });
    const no = await palm(sb, ['cache', 'clean'], { deps });
    expect(no.code).toBe(1);
    expect(no.stderr).toContain('confirm it: palm cache clean --yes');
    const yes = await palm(sb, ['cache', 'clean', '--yes'], { deps });
    expect(yes.code).toBe(0);
    expect(yes.stdout).toMatch(/^- .*cache \(2\.0 KB\)\n/);
    const asked = await palm(sb, ['cache', 'clean'], {
      deps,
      ui: fakeUI({ interactive: true, confirm: false }),
    });
    expect(asked.code).toBe(130);
  });

  it('completion prints a script built from the command tree', async () => {
    const bash = await palm(sb, ['completion', 'bash']);
    expect(bash.stdout).toContain('install|add|i)');
    expect(bash.stdout).toContain('words="mcp"');
    expect(bash.stdout).not.toContain('doctor');
    const zsh = await palm(sb, ['completion', 'zsh']);
    expect(zsh.stdout).toContain('#compdef palm');
    const fish = await palm(sb, ['completion', 'fish']);
    expect(fish.stdout).toContain("complete -c palm -n '__fish_use_subcommand' -a check");
    const bad = await palm(sb, ['completion', 'tcsh']);
    expect(bad.code).toBe(2);
  });

  it('migrate --dry-run prints the new palm.yaml; migrate lists what changed', async () => {
    const report: MigrateReport = {
      manifest: 'targets: [claude]\nsources:\n  mattpocock/skills:\n    skills: [tdd]\n',
      lock: '',
      sourcesAdded: ['mattpocock/skills'],
      movedAssets: ['.palm/hooks/gh-cli → .palm/assets/trailofbits__skills/gh-cli'],
      gitignore: '.palm/ → .palm/local/',
      exec: [],
      warnings: [
        'i tdd was pinned to v1; mattpocock/skills now tracks v1.2.3; pin the source or split it',
      ],
    };
    const deps = fakeEngine({ migrateScope: async () => report });
    const dry = await palm(sb, ['migrate', '--dry-run'], { deps });
    expect(dry.stdout).toBe(`${report.manifest}`);
    expect(dry.stderr).toContain('i tdd was pinned to v1');
    const real = await palm(sb, ['migrate'], { deps });
    expect(real.stdout).toBe(
      [
        '~ palm.yaml and palm.lock.yaml now use the palm 0.2 format',
        '+ source mattpocock/skills → palm.yaml',
        '~ moved .palm/hooks/gh-cli → .palm/assets/trailofbits__skills/gh-cli',
        '~ .gitignore: .palm/ → .palm/local/',
        'Commit palm.yaml, palm.lock.yaml, .gitignore and .palm/assets/ together.',
        '',
      ].join('\n'),
    );
  });

  it('check reads its report only through the engine', async () => {
    const report: CheckReport = { scope: 'project', ok: true, checks: [] };
    const deps = fakeEngine({ checkScope: async () => report });
    expect((await palm(sb, ['check'], { deps })).stdout).toBe('no problems\n');
  });
});
