/**
 * Migrate rulings from the second persona rerun (FINDINGS-v3.md), one test per ruling id: per-skill
 * pins become sources (T4), the overlap hint names the 0.1 origin (T6), the 0.1 source order is
 * kept (T5' R5'), every deletion and persisted note is reported (X8 B7 J5' Y4'), a dry run lists
 * the files (N15 M11), a changed 0.1 fragment is asked about (V5'), and an entry that cannot be
 * placed fails the migration (S11).
 */
import './fakes.js';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashPath } from '../../src/core/hash.js';
import type { LegacyLockEntry, MigrateReport, TargetId } from '../../src/core/types.js';
import { Manifest } from '../../src/domain/manifest.js';
import { migrateScope } from '../../src/engine/migrate.js';
import { convertLegacy } from '../../src/engine/migrate-legacy.js';
import { withLegacyComments } from '../../src/engine/migrate-text.js';
import { git, Machine, writeFiles } from '../cli/world.js';
import { remotes } from './fakes.js';
import { makeWorld, type World, type WorldOptions } from './world.js';

const KIT = 'https://github.com/acme/kit.git';
const SKILLS = {
  'skills/a/SKILL.md': 'A.\n',
  'skills/b/SKILL.md': 'B.\n',
  'skills/c/SKILL.md': 'C.\n',
};

type Entry = Partial<LegacyLockEntry> & { kind: string; name: string };

async function legacyLock(w: World, entries: Entry[], targets: TargetId[] = ['claude']) {
  await w.write('palm.lock.yaml', JSON.stringify({ version: 2, targets, entries }));
}

function shaOf(url: string, ref: string): string {
  return remotes.get(url)?.refs[ref] as string;
}

/** A 0.1 project whose kit skills a and b follow v1.0.0 while c was pinned to v0.9.0. */
async function pinnedWorld(opts: WorldOptions = {}): Promise<World> {
  const w = await makeWorld({ interactive: true, ...opts });
  await w.remote('kit', { 'v1.0.0': SKILLS, 'v0.9.0': SKILLS }, KIT);
  await w.write(
    'palm.yaml',
    `targets: [claude]\norigins:\n  - { alias: kit, type: git, url: '${KIT}' }\nskills:\n  - a@kit\n  - b@kit\n  - c@kit#v0.9.0\n`,
  );
  const at = (ref: string) => ({ origin: 'kit', url: KIT, ref, sha: shaOf(KIT, ref) });
  await legacyLock(w, [
    { ...at('v1.0.0'), kind: 'skill', name: 'a', path: 'skills/a', files: [] },
    { ...at('v1.0.0'), kind: 'skill', name: 'b', path: 'skills/b', files: [] },
    { ...at('v0.9.0'), kind: 'skill', name: 'c', path: 'skills/c', files: [] },
  ]);
  return w;
}

describe('T4 migrate splits per-skill pins into sources', () => {
  it('T4 one source per distinct ref, named <name>-<short sha> as --as would, and says so', async () => {
    const w = await pinnedWorld();
    const r = await migrateScope(w.ctx, { scope: 'project', dryRun: false }, w.deps);
    const short = shaOf(KIT, 'v0.9.0').slice(0, 7);
    expect(r.failures).toEqual([]);
    expect(await w.manifest()).toEqual({
      targets: ['claude'],
      sources: {
        'acme/kit': { ref: 'v1.0.0', alias: 'kit', skills: ['a', 'b'] },
        [`kit-${short}`]: { url: KIT, ref: 'v0.9.0', skills: ['c'] },
      },
    });
    const lock = await w.lock();
    expect(lock.sources[`kit-${short}`]).toMatchObject({
      ref: 'v0.9.0',
      sha: shaOf(KIT, 'v0.9.0'),
    });
    expect(lock.sources['acme/kit']).toMatchObject({ sha: shaOf(KIT, 'v1.0.0') });
    expect(r.warnings).toContain(
      `skill c was pinned to v0.9.0; palm.yaml declares source kit-${short} for it at that ref (acme/kit tracks v1.0.0), as --as kit-${short} would`,
    );
    expect(await w.read('.claude/skills/c/SKILL.md')).toBe('C.\n');
  });

  it('T4 a plugin member follows its plugin, and a local origin never splits', () => {
    const lock = {
      version: 2 as const,
      entries: [
        {
          kind: 'plugin',
          name: 'p',
          origin: 'kit',
          url: KIT,
          ref: 'v2',
          sha: 'b'.repeat(40),
          path: '.',
        },
        {
          kind: 'skill',
          name: 'm',
          origin: 'kit',
          url: KIT,
          ref: 'v1',
          path: 's/m',
          via: 'plugin:p',
        },
        {
          kind: 'skill',
          name: 'x',
          origin: 'kit',
          url: KIT,
          ref: 'v1',
          sha: 'a'.repeat(40),
          path: 's/x',
        },
        {
          kind: 'skill',
          name: 'y',
          origin: 'kit',
          url: KIT,
          ref: 'v1',
          sha: 'a'.repeat(40),
          path: 's/y',
        },
        {
          kind: 'skill',
          name: 'z',
          origin: 'kit',
          url: KIT,
          ref: 'v1',
          sha: 'a'.repeat(40),
          path: 's/z',
        },
        { kind: 'skill', name: 'l', origin: 'mine2', ref: 'v1', path: 's/l' },
        { kind: 'skill', name: 'k', origin: 'mine2', ref: 'v2', path: 's/k' },
      ],
    };
    const manifest = { origins: [{ alias: 'mine2', type: 'local' as const, path: './kit2' }] };
    const m = convertLegacy({ manifest, lock, scope: 'project', root: '/p' });
    expect(m.sources.map((s) => s.source.name)).toEqual(['./kit2', 'acme/kit', 'kit-bbbbbbb']);
    const pinned = m.legacy.filter((i) => i.source === 'kit-bbbbbbb').map((i) => i.entry.name);
    expect(pinned).toEqual(['p', 'm']);
  });
});

describe('T6 the overlap hint names the 0.1 origin', () => {
  async function overlapWorld(origin: string): Promise<World> {
    const w = await makeWorld({ interactive: true });
    await w.local('.claude/kit', { 'rules/style.md': 'Style.\n' });
    await w.write(
      'palm.yaml',
      `targets: [claude]\norigins:\n  - ${origin}\ninstructions:\n  - style@kitcn-rules\n`,
    );
    await legacyLock(w, [
      {
        kind: 'instruction',
        name: 'style',
        origin: 'kitcn-rules',
        path: 'rules/style.md',
        files: [],
      },
    ]);
    return w;
  }

  it('T6 a layout under one folder: set root: on the origin, globs relative to it', async () => {
    const w = await overlapWorld(
      "{ alias: kitcn-rules, type: local, path: ./.claude/kit, layout: { instructions: ['rules/*.md'] } }",
    );
    await expect(
      migrateScope(w.ctx, { scope: 'project', dryRun: false }, w.deps),
    ).rejects.toMatchObject({
      code: 'E_SOURCE',
      hint: 'in palm.yaml, set root: rules on origin kitcn-rules; globs relative to it (rules/ dropped), then run: palm migrate',
    });
  });

  it('T6 no common folder: point the origin at a directory of its own', async () => {
    const w = await overlapWorld('{ alias: kitcn-rules, type: local, path: ./.claude/kit }');
    const dry = await migrateScope(w.ctx, { scope: 'project', dryRun: true }, w.deps);
    expect(dry.failures).toEqual([
      expect.objectContaining({
        code: 'E_SOURCE',
        hint: 'in palm.yaml, point origin kitcn-rules at a directory of its own (for example path: ./agent-kit), then run: palm migrate',
      }),
    ]);
  });
});

describe("T5' R5' migrate keeps the 0.1 source order", () => {
  it("R5' the sources follow the 0.1 palm.yaml and their comments stay above them", () => {
    const text = [
      'origins:',
      '  # the notes kit comes first',
      "  - { alias: notes, type: git, url: 'https://github.com/acme/notes.git' }",
      '  # then the tools',
      "  - { alias: tools, type: git, url: 'https://github.com/acme/tools.git' }",
      'skills:',
      '  - hammer@tools',
      '  - memo@notes',
      '',
    ].join('\n');
    const manifest = {
      origins: [
        { alias: 'notes', type: 'git' as const, url: 'https://github.com/acme/notes.git' },
        { alias: 'tools', type: 'git' as const, url: 'https://github.com/acme/tools.git' },
      ],
      skills: ['hammer@tools', 'memo@notes'],
    };
    const lock = {
      version: 2 as const,
      entries: [
        { kind: 'skill', name: 'hammer', origin: 'tools', path: 'skills/hammer' },
        { kind: 'skill', name: 'memo', origin: 'notes', path: 'skills/memo' },
      ],
    };
    const m = convertLegacy({ manifest, lock, scope: 'project', root: '/p' });
    expect(m.sources.map((s) => s.source.name)).toEqual(['acme/notes', 'acme/tools']);
    const fresh = Manifest.of({});
    for (const s of m.sources) fresh.addSource(s.source, '/p');
    for (const e of m.entries) fresh.addEntry(e.source, e.kind, e.entry);
    const out = withLegacyComments(fresh.text(), text, m);
    expect(out.indexOf('# the notes kit comes first')).toBeLessThan(out.indexOf('acme/notes:'));
    expect(out.indexOf('acme/notes:')).toBeLessThan(out.indexOf('# then the tools'));
    expect(out.indexOf('# then the tools')).toBeLessThan(out.indexOf('acme/tools:'));
  });
});

describe('S11 an entry the migration cannot place fails it', () => {
  it('S11 every entry of an alias without a url is named, and a server without config', () => {
    const lock = {
      version: 2 as const,
      entries: [
        { kind: 'skill', name: 'one', origin: 'lost', path: 'skills/one' },
        { kind: 'skill', name: 'two', origin: 'lost', path: 'skills/two' },
        { kind: 'mcp', name: 'docs', origin: 'registry', path: 'docs' },
      ],
    };
    const m = convertLegacy({ manifest: {}, lock, scope: 'project', root: '/p' });
    expect(m.sources).toEqual([]);
    expect(m.dropped.map((d) => `${d.kind}:${d.name}`)).toEqual([
      'mcp:docs',
      'skill:one',
      'skill:two',
    ]);
    expect(m.dropped[1]).toMatchObject({
      code: 'E_SOURCE',
      message:
        'skill one: the 0.1 alias lost has no url in palm.lock.yaml or ~/.palm/config.yaml; not migrated',
      hint: 'palm install <owner/repo> one',
    });
  });

  it('S11 the migration reports them as failures (the CLI exits 1)', async () => {
    const w = await makeWorld({ interactive: true });
    await w.write('palm.yaml', 'targets: [claude]\nskills:\n  - one@lost\n');
    await legacyLock(w, [{ kind: 'skill', name: 'one', origin: 'lost', path: 'skills/one' }]);
    const r = await migrateScope(w.ctx, { scope: 'project', dryRun: false }, w.deps);
    expect(r.failures.map((f) => f.name)).toEqual(['one']);
  });
});

// ---------------------------------------------------------------------------
// V5': a fragment 0.1 wrote that someone changed since
// ---------------------------------------------------------------------------

const DOCS = { type: 'http', url: 'https://docs.example/mcp' };

async function changedWorld(opts: WorldOptions): Promise<World> {
  const w = await makeWorld(opts);
  await w.write(
    'palm.yaml',
    'targets: [claude]\nmcp:\n  - { name: docs, url: https://docs.example/mcp }\n',
  );
  await w.write(
    '.mcp.json',
    JSON.stringify({ mcpServers: { docs: { ...DOCS, url: 'https://docs.example/v2/mcp' } } }),
  );
  await legacyLock(w, [
    {
      kind: 'mcp',
      name: 'docs',
      origin: 'adhoc',
      path: 'docs',
      files: [],
      merged: [{ file: '.mcp.json', pointer: '/mcpServers/docs', value: DOCS }],
    },
  ]);
  return w;
}

const CHANGED = {
  kind: 'mcp',
  name: 'docs',
  file: '.mcp.json',
  at: '/mcpServers/docs',
};

describe("V5' a 0.1 fragment someone changed", () => {
  it("V5' without a terminal palm refuses before anything is written", async () => {
    const w = await changedWorld({ interactive: false });
    const before = await w.lockText();
    await expect(
      migrateScope(w.ctx, { scope: 'project', dryRun: false }, w.deps),
    ).rejects.toMatchObject({
      code: 'E_CONFLICT',
      message:
        'mcp docs in .mcp.json (/mcpServers/docs) changed since palm 0.1 wrote it; nothing was migrated',
      hint: "palm migrate --force replaces it with palm 0.2's render; to keep your change, run palm migrate in a terminal and answer no",
    });
    expect(await w.lockText()).toBe(before);
  });

  it("V5' a dry run reports it and asks nothing", async () => {
    const w = await changedWorld({ interactive: false });
    const r = await migrateScope(w.ctx, { scope: 'project', dryRun: true }, w.deps);
    expect(r.changed).toEqual([{ ...CHANGED, action: 'ask' }]);
  });

  it("V5' on a terminal, no keeps the change; --force replaces it", async () => {
    const kept = await changedWorld({ interactive: true, confirm: false });
    const r = await migrateScope(kept.ctx, { scope: 'project', dryRun: false }, kept.deps);
    expect(r.changed).toEqual([{ ...CHANGED, action: 'kept' }]);
    expect((await kept.entry('mcp', 'docs'))?.merged ?? []).not.toContainEqual(
      expect.objectContaining({ file: '.mcp.json' }),
    );
    const forced = await changedWorld({ interactive: false, flags: { force: true } });
    const f = await migrateScope(forced.ctx, { scope: 'project', dryRun: false }, forced.deps);
    expect(f.changed).toEqual([{ ...CHANGED, action: 'replaced' }]);
  });

  it("V5' a hook item that still runs palm 0.1's copy is found in its event array", async () => {
    const w = await makeWorld({ interactive: false });
    const cmd = (s: string) => `"$CLAUDE_PROJECT_DIR"/.palm/hooks/guard/run.sh ${s}`;
    const item = (s: string) => ({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: cmd(s) }],
    });
    await w.write('palm.yaml', 'targets: [claude]\nhooks:\n  - guard@kit\n');
    await w.write('.claude/settings.json', JSON.stringify({ hooks: { Stop: [item('--edited')] } }));
    await legacyLock(w, [
      {
        kind: 'hook',
        name: 'guard',
        origin: 'kit',
        url: KIT,
        path: 'hooks/guard/hooks.json',
        files: [],
        merged: [{ file: '.claude/settings.json', pointer: '/hooks/Stop', value: item('') }],
      },
    ]);
    const r = await migrateScope(w.ctx, { scope: 'project', dryRun: true }, w.deps);
    expect(r.changed).toEqual([
      {
        kind: 'hook',
        name: 'guard',
        file: '.claude/settings.json',
        at: '/hooks/Stop',
        action: 'ask',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// X8 B7 J5' Y4' N15 M11: through the built CLI and the real targets
// ---------------------------------------------------------------------------

describe("X8 B7 J5' Y4' N15 M11 migrate lists what it deletes, writes and notes", () => {
  let m: Machine;

  afterEach(async () => {
    await m.dispose();
  });

  const TDD = '---\nname: tdd\ndescription: Test first\n---\n\nTest first.\n';
  const DEPLOY = '---\ndescription: Deploy it\n---\n\nDeploy $ARGUMENTS now.\n';

  /** A 0.1 project: a skill with 0.1's stray openai.yaml copy, and a command 0.1 wrote as a command file. */
  async function legacyProject(): Promise<string> {
    m = await Machine.create();
    const files = {
      'skills/tdd/SKILL.md': TDD,
      'skills/tdd/agents/openai.yaml': 'interface: {}\n',
      'commands/deploy.md': DEPLOY,
    };
    const url = await m.source('kit', { 'v1.0.0': files });
    const sha = await git(join(m.root, 'src', 'kit'), 'rev-parse', 'HEAD');
    const p = await m.project('app', ['.claude', '.codex']);
    await writeFiles(p, {
      'palm.yaml': `targets: [claude, codex]\norigins:\n  - { alias: kit, type: git, url: '${url}' }\nskills:\n  - tdd@kit\ncommands:\n  - deploy@kit\n`,
      '.claude/skills/tdd/SKILL.md': TDD,
      '.claude/skills/tdd/agents/openai.yaml': 'interface: {}\n',
      '.claude/commands/deploy.md': DEPLOY,
    });
    const rec = async (rel: string) => ({ path: rel, hash: await hashPath(join(p, rel)) });
    const at = { origin: 'kit', url, ref: 'v1.0.0', sha, targets: ['claude', 'codex'] };
    const entries = [
      {
        ...at,
        kind: 'skill',
        name: 'tdd',
        path: 'skills/tdd',
        files: [await rec('.claude/skills/tdd/SKILL.md')],
      },
      {
        ...at,
        kind: 'command',
        name: 'deploy',
        path: 'commands/deploy.md',
        files: [await rec('.claude/commands/deploy.md')],
      },
    ];
    await writeFiles(p, { 'palm.lock.yaml': JSON.stringify({ version: 2, entries }) });
    return p;
  }

  const REMOVED = [
    {
      file: '.claude/commands/deploy.md',
      reason: 'palm 0.1 wrote it for command deploy; palm 0.2 installs deploy as a skill',
    },
    {
      file: '.claude/skills/tdd/agents/openai.yaml',
      reason: 'palm 0.1 copied it; palm 0.2 writes agents/openai.yaml only into .agents/skills',
    },
  ];
  const NOTE =
    'skill deploy: skill deploy (from a command): Codex does not expand $ARGUMENTS in skills; the text stays as written';

  it("X8 B7 J5' Y4' every deleted file and every persisted note is in the report", async () => {
    const p = await legacyProject();
    const run = await m.palm(p, 'migrate', '--json');
    expect(run.code, run.all).toBe(0);
    const report = JSON.parse(run.stdout) as MigrateReport;
    expect(report.removed).toEqual(REMOVED);
    expect(report.notes).toContain(NOTE);
    expect(existsSync(join(p, '.claude/commands/deploy.md'))).toBe(false);
    expect(existsSync(join(p, '.claude/skills/tdd/agents/openai.yaml'))).toBe(false);
  });

  it('N15 M11 a dry run lists the files it would write and delete, and writes nothing', async () => {
    const p = await legacyProject();
    const run = await m.palm(p, 'migrate', '--dry-run', '--json');
    expect(run.code, run.all).toBe(0);
    const report = JSON.parse(run.stdout) as MigrateReport;
    expect(report.removed).toEqual(REMOVED);
    expect(report.written).toEqual(
      expect.arrayContaining(['.agents/skills/deploy/SKILL.md', '.claude/skills/deploy/SKILL.md']),
    );
    expect(report.written).not.toContain('.claude/skills/tdd/SKILL.md');
    expect(report.notes).toContain(NOTE);
    expect(existsSync(join(p, '.claude/commands/deploy.md'))).toBe(true);
  });

  it("V5' without a terminal nothing is written; --force puts palm 0.2's render in its place", async () => {
    m = await Machine.create();
    const p = await m.project('app');
    const changed = { mcpServers: { docs: { ...DOCS, url: 'https://docs.example/v2/mcp' } } };
    const docs = {
      kind: 'mcp',
      name: 'docs',
      origin: 'adhoc',
      path: 'docs',
      targets: ['claude'],
      files: [],
      merged: [{ file: '.mcp.json', pointer: '/mcpServers/docs', value: DOCS }],
    };
    await writeFiles(p, {
      'palm.yaml': 'targets: [claude]\nmcp:\n  - { name: docs, url: https://docs.example/mcp }\n',
      '.mcp.json': JSON.stringify(changed),
      'palm.lock.yaml': JSON.stringify({ version: 2, entries: [docs] }),
    });
    const refused = await m.palm(p, 'migrate');
    expect(refused.code, refused.all).toBe(1);
    expect(refused.all).toContain('changed since palm 0.1 wrote it; nothing was migrated');
    expect(await m.read(join(p, 'palm.lock.yaml'))).toContain('"version":2');
    const forced = await m.palm(p, 'migrate', '--force');
    expect(forced.code, forced.all).toBe(0);
    const mcp = JSON.parse(await m.read(join(p, '.mcp.json')));
    expect(mcp.mcpServers.docs.url).toBe('https://docs.example/mcp');
  });
});
