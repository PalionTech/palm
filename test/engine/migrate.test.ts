import './fakes.js';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashPath } from '../../src/core/hash.js';
import { migrateScope } from '../../src/engine/migrate.js';
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

async function legacyWorld(): Promise<World> {
  const w = await makeWorld({ interactive: true, consent: 'yes' });
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
  const lock = {
    version: 2,
    targets: ['claude'],
    entries: [
      {
        kind: 'skill',
        name: 'tdd',
        origin: 'mattpocock',
        url: MP,
        ref: 'v1.0.0',
        sha,
        path: 'skills/tdd',
        contentHash: 'sha256:1',
        transform: 1,
        targets: ['claude'],
        files: [await file('.claude/skills/tdd/SKILL.md')],
      },
      {
        kind: 'skill',
        name: 'review',
        origin: 'kit',
        path: 'skills/review',
        contentHash: 'sha256:2',
        transform: 1,
        targets: ['claude'],
        files: [await file('.claude/skills/review/SKILL.md')],
      },
      {
        kind: 'hook',
        name: 'guard',
        origin: 'mattpocock',
        url: MP,
        ref: 'v1.0.0',
        sha,
        path: 'hooks/guard/hooks.json',
        contentHash: 'sha256:3',
        transform: 1,
        targets: ['claude'],
        files: [await file('.palm/hooks/guard/run.sh')],
      },
      {
        kind: 'plugin',
        name: 'superpowers',
        origin: 'mattpocock',
        url: MP,
        ref: 'v1.0.0',
        sha,
        path: 'plugins/superpowers.json',
        contentHash: 'sha256:4',
        transform: 1,
        targets: ['claude'],
        files: [],
        deps: [
          { kind: 'skill', name: 'brainstorming' },
          { kind: 'skill', name: 'extra' },
        ],
      },
      {
        kind: 'skill',
        name: 'brainstorming',
        origin: 'mattpocock',
        url: MP,
        ref: 'v1.0.0',
        sha,
        path: 'skills/brainstorming',
        via: 'plugin:superpowers',
        contentHash: 'sha256:5',
        transform: 1,
        targets: ['claude'],
        files: [await file('.claude/skills/brainstorming/SKILL.md')],
      },
      {
        kind: 'mcp',
        name: 'docs',
        origin: 'adhoc',
        path: 'docs',
        contentHash: 'sha256:6',
        transform: 1,
        targets: ['claude'],
        files: [],
      },
    ],
  };
  await w.write('palm.lock.yaml', JSON.stringify(lock));
  return w;
}

describe('migrateScope', () => {
  it('prints the new palm.yaml on --dry-run and writes nothing', async () => {
    const w = await legacyWorld();
    const r = await migrateScope(w.ctx, { scope: 'project', dryRun: true }, w.deps);
    expect(r.manifest).toContain('mattpocock/skills:');
    expect(r.manifest).toContain('./agent-kit:');
    expect(await w.manifestText()).toBe(LEGACY_MANIFEST);
    expect(w.exists('.palm/hooks/guard/run.sh')).toBe(true);
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
    expect(w.ctx.log.text()).toContain('~/.palm/config.yaml is no longer read; delete it');
    expect(existsSync(join(w.palmHome, 'config.yaml'))).toBe(true);
  });
});
