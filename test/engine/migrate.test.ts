import './fakes.js';

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashPath } from '../../src/core/hash.js';
import type { LegacyLockEntry, MigrateReport, TargetId } from '../../src/core/types.js';
import { ScopePaths } from '../../src/domain/scope-paths.js';
import { migrateScope } from '../../src/engine/migrate.js';
import { convertLegacy } from '../../src/engine/migrate-legacy.js';
import { onThisMachine } from '../../src/engine/migrate-lock.js';
import { withLegacyComments } from '../../src/engine/migrate-text.js';
import { makeWorld, type World, writeTree } from './world.js';

const MP = 'https://github.com/mattpocock/skills.git';

const REMOTE = {
  'skills/tdd/SKILL.md': 'Test first.\n',
  'skills/brainstorming/SKILL.md': 'Think first.\n',
  'skills/extra/SKILL.md': 'Extra.\n',
  'hooks/guard/hooks.json': JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/guard/run.sh' }] }],
    },
  }),
  'hooks/guard/run.sh': { text: 'echo guard\n', mode: 0o755 },
  'plugins/superpowers.json': JSON.stringify({ members: ['skill:brainstorming', 'skill:extra'] }),
};

const LEGACY_MANIFEST = `targets: [claude]
origins:
  - { alias: kit, type: local, path: ./agent-kit }
skills:
  - tdd@mattpocock#v1.0.0
  - review@kit
hooks:
  - guard@mattpocock
plugins:
  - superpowers@mattpocock
mcp:
  - { name: docs, transport: http, url: https://docs.example/mcp }
`;

type Entry = Partial<LegacyLockEntry> & { kind: string; name: string };

async function legacyLock(w: World, entries: Entry[]): Promise<void> {
  await w.write('palm.lock.yaml', JSON.stringify({ version: 2, targets: ['claude'], entries }));
}

async function legacyWorld(
  opts: { interactive?: boolean; failFor?: TargetId[] } = {},
): Promise<World> {
  const w = await makeWorld({
    interactive: opts.interactive ?? true,
    consent: 'yes',
    ...(opts.failFor ? { failFor: opts.failFor } : {}),
  });
  await w.remote('skills', { 'v1.0.0': REMOTE }, MP);
  await w.local('agent-kit', { 'skills/review/SKILL.md': 'Review.\n' });
  await writeTree(w.palmHome, {
    'config.yaml': `origins:\n  - { alias: mattpocock, type: git, url: '${MP}' }\n`,
  });
  // What 0.1 left on disk: skills, the hook's script under .palm/hooks, and an ignore line.
  await w.write('.claude/skills/tdd/SKILL.md', 'Test first (0.1 render).\n');
  await w.write('.claude/skills/review/SKILL.md', 'Review.\n');
  await w.write('.claude/skills/brainstorming/SKILL.md', 'Think first.\n');
  await writeTree(w.project, { '.palm/hooks/guard/run.sh': { text: 'echo guard\n', mode: 0o755 } });
  await w.write('.gitignore', 'node_modules/\n.palm/\n');
  await w.write('palm.yaml', LEGACY_MANIFEST);
  const file = async (rel: string) => ({ path: rel, hash: await hashPath(w.path(rel)) });
  const sha = (await import('./fakes.js')).remotes.get(MP)?.refs['v1.0.0'];
  const git = { origin: 'mattpocock', url: MP, ref: 'v1.0.0', sha, transform: 1 };
  const targets: TargetId[] = ['claude'];
  await legacyLock(w, [
    {
      ...git,
      kind: 'skill',
      name: 'tdd',
      path: 'skills/tdd',
      contentHash: 'sha256:1',
      targets,
      files: [await file('.claude/skills/tdd/SKILL.md')],
    },
    {
      kind: 'skill',
      name: 'review',
      origin: 'kit',
      path: 'skills/review',
      contentHash: 'sha256:2',
      targets,
      files: [await file('.claude/skills/review/SKILL.md')],
    },
    {
      ...git,
      kind: 'hook',
      name: 'guard',
      path: 'hooks/guard/hooks.json',
      contentHash: 'sha256:3',
      targets,
      files: [await file('.palm/hooks/guard/run.sh')],
    },
    {
      ...git,
      kind: 'plugin',
      name: 'superpowers',
      path: 'plugins/superpowers.json',
      contentHash: 'sha256:4',
      targets,
      files: [],
      deps: [
        { kind: 'skill', name: 'brainstorming' },
        { kind: 'skill', name: 'extra' },
      ],
    },
    {
      ...git,
      kind: 'skill',
      name: 'brainstorming',
      path: 'skills/brainstorming',
      via: 'plugin:superpowers',
      contentHash: 'sha256:5',
      targets,
      files: [await file('.claude/skills/brainstorming/SKILL.md')],
    },
    {
      kind: 'mcp',
      name: 'docs',
      origin: 'adhoc',
      path: 'docs',
      contentHash: 'sha256:6',
      targets,
      files: [],
    },
  ]);
  return w;
}

/** Every file below the project with its bytes' hash: "nothing written" means this is unchanged. */
async function snapshot(w: World): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const found = await readdir(w.project, { recursive: true, withFileTypes: true });
  for (const d of found.filter((f) => f.isFile())) {
    const abs = join(d.parentPath, d.name);
    out[abs.slice(w.project.length + 1)] = await hashPath(abs);
  }
  return out;
}

describe('migrateScope', () => {
  it('prints the new palm.yaml on --dry-run and writes nothing', async () => {
    const w = await legacyWorld();
    const before = await snapshot(w);
    const r = await migrateScope(w.ctx, { scope: 'project', dryRun: true }, w.deps);
    expect(r.manifest).toContain('mattpocock/skills:');
    expect(r.manifest).toContain('./agent-kit:');
    expect(r.exec.map((u) => u.key)).toEqual(['hook:guard@mattpocock/skills']);
    expect(await snapshot(w)).toEqual(before);
  });

  it('converts a 0.1 manifest and lock into 0.2 and moves hook scripts into .palm/assets', async () => {
    const w = await legacyWorld();
    const r = await migrateScope(w.ctx, { scope: 'project', dryRun: false }, w.deps);
    expect(r.warnings).toEqual([]);
    expect(await w.manifest()).toEqual({
      targets: ['claude'],
      sources: {
        'mattpocock/skills': {
          ref: 'v1.0.0',
          alias: 'mattpocock',
          skills: ['tdd'],
          hooks: ['guard'],
          plugins: [{ name: 'superpowers', exclude: ['skill:extra'] }],
        },
        './agent-kit': { alias: 'kit', skills: ['review'] },
      },
      mcp: { docs: { url: 'https://docs.example/mcp' } },
    });
    const lock = await w.lock();
    expect(lock.version).toBe(3);
    expect(lock.sources['mattpocock/skills']).toMatchObject({ url: MP, ref: 'v1.0.0' });
    expect(lock.entries.map((e) => `${e.kind}:${e.name}`).sort()).toEqual(
      [
        'hook:guard',
        'mcp:docs',
        'plugin:superpowers',
        'skill:brainstorming',
        'skill:review',
        'skill:tdd',
      ].sort(),
    );
    expect(lock.entries.every((e) => Object.keys(e.render).length > 0 || e.kind === 'plugin')).toBe(
      true,
    );
    expect(await w.read('.claude/skills/tdd/SKILL.md')).toBe('Test first.\n');
    expect(w.exists('.palm/hooks')).toBe(false);
    expect(w.exists('.palm/assets/mattpocock__skills/guard/hooks/guard/run.sh')).toBe(true);
    expect(r.movedAssets).toEqual(['.palm/hooks/guard → .palm/assets/mattpocock__skills/guard']);
    expect(r.exec.map((u) => u.key)).toEqual(['hook:guard@mattpocock/skills']);
    expect(r.sourcesAdded).toEqual(['mattpocock/skills']);
    expect(await w.read('.gitignore')).toBe('node_modules/\n.palm/local/\npalm.local.yaml\n');
    expect(existsSync(join(w.palmHome, 'config.yaml'))).toBe(true);
  });

  it('E3 R4 K6 V1 without a terminal nothing is written, and the printed --allow-exec line migrates', async () => {
    const w = await legacyWorld({ interactive: false });
    const before = await snapshot(w);
    await expect(
      migrateScope(w.ctx, { scope: 'project', dryRun: false }, w.deps),
    ).rejects.toMatchObject({ code: 'E_UNTRUSTED_EXEC' });
    expect(await snapshot(w)).toEqual(before);
    const [unit] = w.exec.requests[0]?.units ?? [];
    const allowExec = [{ key: unit?.key as string, hash: unit?.hash as string }];
    const again = await migrateScope(
      w.context({ allowExec }),
      { scope: 'project', dryRun: false },
      w.deps,
    );
    expect(again.failures).toEqual([]);
    expect((await w.lock()).version).toBe(3);
    expect((await w.entry('hook', 'guard'))?.trust).toEqual([unit?.hash]);
  });

  it('E3 a declined program cancels the migration and writes nothing', async () => {
    const w = await legacyWorld();
    w.exec.script.answer = 'no';
    const before = await snapshot(w);
    await expect(
      migrateScope(w.ctx, { scope: 'project', dryRun: false }, w.deps),
    ).rejects.toMatchObject({ code: 'E_CANCELLED' });
    expect(await snapshot(w)).toEqual(before);
  });

  it('E3 .palm/hooks goes after the move; a copy the person changed stays, named in a warning', async () => {
    const w = await legacyWorld();
    await writeTree(w.project, { '.palm/hooks/guard/notes.txt': 'mine\n' });
    const r = await migrateScope(w.ctx, { scope: 'project', dryRun: false }, w.deps);
    expect(w.exists('.palm/hooks/guard/run.sh')).toBe(false);
    expect(await w.read('.palm/hooks/guard/notes.txt')).toBe('mine\n');
    expect(r.warnings).toContain(
      'kept .palm/hooks/guard/notes.txt: you changed it after palm 0.1 copied it',
    );
  });

  it('E3 a hook that did not migrate keeps its .palm/hooks copy, still ignored by git', async () => {
    const w = await legacyWorld({ failFor: ['claude'] });
    const r = await migrateScope(w.ctx, { scope: 'project', dryRun: false }, w.deps);
    expect(r.failures.length).toBeGreaterThan(0);
    expect(w.exists('.palm/hooks/guard/run.sh')).toBe(true);
    expect(await w.read('.gitignore')).toBe(
      'node_modules/\n.palm/local/\npalm.local.yaml\n.palm/hooks/\n',
    );
    expect(r.warnings).toContain(
      'kept .palm/hooks/guard, still ignored by git: hook guard did not migrate',
    );
  });

  it('Z3 a source overlapping an output directory refuses before any write; the dry run reports it', async () => {
    const w = await legacyWorld();
    await w.write('palm.yaml', LEGACY_MANIFEST.replace('./agent-kit', './.claude/kit'));
    await w.local('.claude/kit', { 'skills/review/SKILL.md': 'Review.\n' });
    const before = await snapshot(w);
    await expect(
      migrateScope(w.ctx, { scope: 'project', dryRun: false }, w.deps),
    ).rejects.toMatchObject({ code: 'E_SOURCE' });
    expect(await snapshot(w)).toEqual(before);
    const dry = await migrateScope(w.ctx, { scope: 'project', dryRun: true }, w.deps);
    expect(dry.manifest).toContain('./.claude/kit:');
    expect(dry.failures).toEqual([
      expect.objectContaining({ code: 'E_SOURCE', message: expect.stringContaining('overlaps') }),
    ]);
  });

  it('R2 a local origin with path and root becomes one ./<path>/<root> source', () => {
    const m = convertLegacy({
      manifest: { origins: [{ alias: 'emanote', type: 'local', path: '.', root: '.apm' }] },
      lock: {
        version: 2,
        entries: [{ kind: 'skill', name: 'dpella', origin: 'emanote', path: 'skills/dpella' }],
      },
      scope: 'project',
      root: '/work/em',
    });
    expect(m.sources.map((s) => s.source)).toEqual([
      { name: './.apm', type: 'local', path: '/work/em/.apm', alias: 'emanote' },
    ]);
  });

  it('R3 the 0.1 comments are kept: on top, on targets, above the source that holds an entry, and at the end', () => {
    const old = `# agent setup
targets: [claude] # the harnesses
origins:
  # the team kit
  - { alias: kit, type: git, url: 'https://example.com/kit.git' }
skills:
  - tdd@kit # transitive (kolu)
  # nobody knows
  - lost@nowhere
# end note
`;
    const m = convertLegacy({
      manifest: {
        targets: ['claude'],
        origins: [{ alias: 'kit', type: 'git', url: 'https://example.com/kit.git' }],
      },
      lock: {
        version: 2,
        entries: [
          {
            kind: 'skill',
            name: 'tdd',
            origin: 'kit',
            url: 'https://example.com/kit.git',
            path: 'skills/tdd',
          },
        ],
      },
      scope: 'project',
      root: '/p',
    });
    const fresh =
      'targets: [claude]\nsources:\n  kit:\n    url: https://example.com/kit.git\n    skills: [tdd]\n';
    expect(withLegacyComments(fresh, old, m)).toBe(`# agent setup
targets: [claude] # the harnesses
sources:
  # the team kit
  # transitive (kolu)
  kit:
    url: https://example.com/kit.git
    skills: [tdd]

# end note
# from palm 0.1:
# nobody knows
`);
  });

  it('C7 a 0.1 hook named after the alias is matched by its path and installed under its 0.2 name', async () => {
    const w = await legacyWorld();
    await w.local('agent-kit', {
      'skills/review/SKILL.md': 'Review.\n',
      'hooks/agent-kit/hooks.json': JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo in-repo' }] }] },
      }),
    });
    await w.write('palm.yaml', LEGACY_MANIFEST.replace('  - guard@mattpocock', '  - kit@kit'));
    const lock = JSON.parse((await w.lockText()) as string) as { entries: Entry[] };
    lock.entries = lock.entries.filter((e) => e.kind !== 'hook');
    lock.entries.push({
      kind: 'hook',
      name: 'kit',
      origin: 'kit',
      path: 'hooks/agent-kit/hooks.json',
      files: [],
    });
    await legacyLock(w, lock.entries);
    const r = await migrateScope(w.ctx, { scope: 'project', dryRun: false }, w.deps);
    expect(r.failures).toEqual([]);
    expect(
      ((await w.manifest()).sources as Record<string, { hooks?: string[] }>)['./agent-kit']?.hooks,
    ).toEqual(['agent-kit']);
    expect(await w.entry('hook', 'agent-kit')).toMatchObject({ source: './agent-kit' });
    expect(r.exec.map((u) => u.key)).toEqual(['hook:agent-kit@./agent-kit']);
    expect(w.ctx.log.text()).toContain('hook kit from ./agent-kit is hook agent-kit in palm 0.2');
  });

  it('K19 C17 the config.yaml line follows the migration guide: keep it for other projects, delete it only under -g', async () => {
    const w = await legacyWorld();
    await migrateScope(w.ctx, { scope: 'project', dryRun: false }, w.deps);
    expect(w.ctx.log.text()).toContain(
      'keep ~/.palm/config.yaml until every project is migrated; palm migrate reads it',
    );
    expect(w.ctx.log.text()).not.toContain('delete it');
  });

  it('J17 the advice for a ~/.palm/mine entry names the kit of the scope', () => {
    const lock = {
      version: 2 as const,
      entries: [{ kind: 'agent', name: 'scribe', origin: 'mine', path: 'agents/scribe.md' }],
    };
    const project = convertLegacy({ manifest: {}, lock, scope: 'project', root: '/p' });
    expect(project.warnings).toEqual([
      'agent scribe came from ~/.palm/mine, which palm 0.2 no longer reads; copy ~/.palm/mine/agents/scribe.md to ./agent-kit/agents/scribe.md, then run: palm install ./agent-kit scribe',
    ]);
    const global = convertLegacy({
      manifest: {},
      lock,
      scope: 'global',
      root: '/h/.palm',
      palmHome: '~/.palm',
    });
    expect(global.warnings).toEqual([
      'agent scribe came from ~/.palm/mine, which palm 0.2 no longer reads; copy ~/.palm/mine/agents/scribe.md to ~/.palm/kit/agents/scribe.md, then run: palm install ~/.palm/kit scribe -g',
    ]);
  });

  it('L1 a registry server is copied from the Claude file first, and ${env:VAR} becomes ${VAR}', () => {
    const merged = [
      {
        file: '.codex/config.toml',
        pointer: '/mcp_servers/c7',
        value: { url: 'https://c7', bearer_token_env_var: 'K' },
      },
      {
        file: '.cursor/mcp.json',
        pointer: '/mcpServers/c7',
        value: { url: 'https://c7', headers: { Authorization: '${env:C7_KEY}' } },
      },
    ];
    const m = convertLegacy({
      manifest: {},
      lock: {
        version: 2,
        entries: [{ kind: 'mcp', name: 'c7', origin: 'registry', path: 'c7', merged }],
      },
      scope: 'project',
      root: '/p',
    });
    expect(m.mcp).toEqual([
      { name: 'c7', entry: { url: 'https://c7', headers: { Authorization: '${C7_KEY}' } } },
    ]);
  });

  it('D16 a global lock path written under another home maps onto this machine', () => {
    const paths = new ScopePaths('global', '/new/home', '/new/home/.palm', { HOME: '/new/home' });
    expect(onThisMachine(paths, '/old/home/.claude/skills/tdd/SKILL.md')).toBe(
      '/new/home/.claude/skills/tdd/SKILL.md',
    );
    expect(onThisMachine(paths, '/old/home/.claude.json')).toBe('/new/home/.claude.json');
    expect(onThisMachine(paths, '/old/home/.config/opencode/opencode.json')).toBe(
      '/new/home/.config/opencode/opencode.json',
    );
    expect(onThisMachine(paths, '/old/home/.palm/hooks/guard/run.sh')).toBe(
      '/new/home/.palm/hooks/guard/run.sh',
    );
    expect(onThisMachine(paths, '/new/home/.agents/skills/x/SKILL.md')).toBe(
      '/new/home/.agents/skills/x/SKILL.md',
    );
  });

  it('migrate ends by running the check: a failing check is a failure of the migration', async () => {
    const w = await legacyWorld();
    await w.write(
      'palm.yaml',
      LEGACY_MANIFEST.replace('  - review@kit', '  - review@kit\n  - gone@mattpocock'),
    );
    const lock = JSON.parse((await w.lockText()) as string) as { entries: Entry[] };
    lock.entries.push({
      kind: 'skill',
      name: 'gone',
      origin: 'mattpocock',
      url: MP,
      ref: 'v1.0.0',
      path: 'skills/gone',
      files: [],
    });
    await legacyLock(w, lock.entries);
    const r: MigrateReport = await migrateScope(w.ctx, { scope: 'project', dryRun: false }, w.deps);
    expect(r.check?.ok).toBe(false);
    expect(r.failures.map((f) => f.code)).toContain('E_NOT_FOUND');
    expect(r.failures.some((f) => f.code === 'E_CHECK')).toBe(true);
  });
});
