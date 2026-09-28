import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LockEntry } from '../../src/core/types.js';
import { lockId } from '../../src/domain/entity-key.js';
import { answersTo, filePaths, LOCK_COMMENT, Lock } from '../../src/domain/lock.js';
import { removeDir, tempDir } from '../support/sandbox.js';

/** Locked files with made-up but distinct hashes. */
const locked = (...paths: string[]): LockEntry['files'] =>
  paths.map((path, i) => ({ path, hash: `sha256:${i}${path.length}` }));

/** Insertion order differs from file order on purpose (the writer sorts). */
const FIXTURE_ENTRIES: LockEntry[] = [
  {
    kind: 'skill',
    name: 'wayfinder',
    origin: 'mattpocock',
    url: 'https://github.com/mattpocock/skills.git',
    ref: 'v1.2.0',
    sha: '0123456789abcdef0123456789abcdef01234567',
    path: 'skills/wayfinder',
    contentHash: 'sha256:aaaa',
    transform: 1,
    targets: ['claude', 'codex'],
    files: locked('.claude/skills/wayfinder', '.agents/skills/wayfinder'),
  },
  {
    kind: 'plugin',
    name: 'superpowers',
    origin: 'obra',
    path: 'plugins/superpowers',
    contentHash: 'sha256:bbbb',
    transform: 1,
    targets: ['claude'],
    files: [],
    deps: [
      { kind: 'skill', name: 'brainstorm' },
      { kind: 'command', name: 'plan' },
    ],
  },
  {
    via: 'plugin:superpowers',
    files: locked('.claude/skills/brainstorm'),
    targets: ['claude'],
    kind: 'skill',
    name: 'brainstorm',
    origin: 'obra',
    path: 'plugins/superpowers/skills/brainstorm',
    contentHash: 'sha256:cccc',
    transform: 1,
    merged: [],
  },
  {
    kind: 'mcp',
    name: 'context7',
    origin: 'registry',
    url: 'https://registry.modelcontextprotocol.io',
    ref: '1.0.3',
    path: 'io.github.upstash/context7',
    contentHash: 'sha256:dddd',
    transform: 1,
    targets: ['claude', 'cursor'],
    files: [],
    merged: [
      {
        file: '.mcp.json',
        pointer: '/mcpServers/context7',
        value: {
          type: 'http',
          url: 'https://mcp.context7.com/mcp',
          headers: { Authorization: 'Bearer ${CTX_TOKEN}' },
        },
      },
      {
        file: '.cursor/mcp.json',
        pointer: '/mcpServers/context7',
        value: { url: 'https://mcp.context7.com/mcp' },
      },
    ],
  },
  {
    kind: 'hook',
    name: 'fmt',
    origin: 'a',
    path: 'hooks/fmt.json',
    contentHash: 'sha256:eeee',
    transform: 1,
    targets: ['claude'],
    files: locked('.palm/hooks/fmt/run.sh'),
    merged: [
      {
        file: '.claude/settings.json',
        pointer: '/hooks/PostToolUse/-',
        value: {
          matcher: 'Edit',
          hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.palm/hooks/fmt/run.sh' }],
        },
      },
    ],
  },
  {
    kind: 'skill',
    name: 'Alpha',
    origin: 'b',
    path: 'skills/alpha',
    contentHash: 'sha256:ffff',
    transform: 1,
    targets: ['copilot'],
    files: locked('.github/skills/alpha'),
  },
  {
    kind: 'skill',
    name: 'alpha',
    origin: 'a',
    path: 'skills/alpha',
    contentHash: 'sha256:ffff',
    transform: 1,
    targets: ['copilot'],
    files: locked('.github/skills/alpha'),
  },
  {
    kind: 'agent',
    name: 'reviewer',
    origin: 'a',
    path: 'agents/reviewer.md',
    contentHash: 'sha256:1111',
    transform: 1,
    targets: ['claude', 'codex', 'copilot', 'cursor'],
    files: locked(
      '.claude/agents/reviewer.md',
      '.codex/agents/reviewer.toml',
      '.github/agents/reviewer.agent.md',
      '.cursor/agents/reviewer.md',
    ),
    deps: [{ kind: 'skill', name: 'tdd' }],
  },
  {
    kind: 'instruction',
    name: 'style',
    origin: 'd',
    path: 'rules/style.md',
    contentHash: 'sha256:2222',
    transform: 1,
    targets: ['cursor'],
    files: locked('.cursor/rules/style.mdc'),
    via: 'agent:alpha',
  },
];

/** What `save` writes for FIXTURE_ENTRIES (lockfile v2). */
const FIXTURE_TEXT = `${[
  '# palm lockfile — generated, do not edit by hand.',
  'version: 2',
  'entries:',
  '  - kind: skill',
  '    name: alpha',
  '    origin: a',
  '    path: skills/alpha',
  '    contentHash: sha256:ffff',
  '    transform: 1',
  '    targets:',
  '      - copilot',
  '    files:',
  '      - path: .github/skills/alpha',
  '        hash: sha256:020',
  '  - kind: skill',
  '    name: Alpha',
  '    origin: b',
  '    path: skills/alpha',
  '    contentHash: sha256:ffff',
  '    transform: 1',
  '    targets:',
  '      - copilot',
  '    files:',
  '      - path: .github/skills/alpha',
  '        hash: sha256:020',
  '  - kind: skill',
  '    name: brainstorm',
  '    origin: obra',
  '    path: plugins/superpowers/skills/brainstorm',
  '    contentHash: sha256:cccc',
  '    transform: 1',
  '    targets:',
  '      - claude',
  '    files:',
  '      - path: .claude/skills/brainstorm',
  '        hash: sha256:025',
  '    via: plugin:superpowers',
  '  - kind: skill',
  '    name: wayfinder',
  '    origin: mattpocock',
  '    url: https://github.com/mattpocock/skills.git',
  '    ref: v1.2.0',
  '    sha: 0123456789abcdef0123456789abcdef01234567',
  '    path: skills/wayfinder',
  '    contentHash: sha256:aaaa',
  '    transform: 1',
  '    targets:',
  '      - claude',
  '      - codex',
  '    files:',
  '      - path: .agents/skills/wayfinder',
  '        hash: sha256:124',
  '      - path: .claude/skills/wayfinder',
  '        hash: sha256:024',
  '  - kind: agent',
  '    name: reviewer',
  '    origin: a',
  '    path: agents/reviewer.md',
  '    contentHash: sha256:1111',
  '    transform: 1',
  '    targets:',
  '      - claude',
  '      - codex',
  '      - copilot',
  '      - cursor',
  '    files:',
  '      - path: .claude/agents/reviewer.md',
  '        hash: sha256:026',
  '      - path: .codex/agents/reviewer.toml',
  '        hash: sha256:127',
  '      - path: .cursor/agents/reviewer.md',
  '        hash: sha256:326',
  '      - path: .github/agents/reviewer.agent.md',
  '        hash: sha256:232',
  '    deps:',
  '      - kind: skill',
  '        name: tdd',
  '  - kind: instruction',
  '    name: style',
  '    origin: d',
  '    path: rules/style.md',
  '    contentHash: sha256:2222',
  '    transform: 1',
  '    targets:',
  '      - cursor',
  '    files:',
  '      - path: .cursor/rules/style.mdc',
  '        hash: sha256:023',
  '    via: agent:alpha',
  '  - kind: hook',
  '    name: fmt',
  '    origin: a',
  '    path: hooks/fmt.json',
  '    contentHash: sha256:eeee',
  '    transform: 1',
  '    targets:',
  '      - claude',
  '    files:',
  '      - path: .palm/hooks/fmt/run.sh',
  '        hash: sha256:022',
  '    merged:',
  '      - file: .claude/settings.json',
  '        pointer: /hooks/PostToolUse/-',
  '        value:',
  '          matcher: Edit',
  '          hooks:',
  '            - type: command',
  '              command: \'"$CLAUDE_PROJECT_DIR"/.palm/hooks/fmt/run.sh\'',
  '  - kind: mcp',
  '    name: context7',
  '    origin: registry',
  '    url: https://registry.modelcontextprotocol.io',
  '    ref: 1.0.3',
  '    path: io.github.upstash/context7',
  '    contentHash: sha256:dddd',
  '    transform: 1',
  '    targets:',
  '      - claude',
  '      - cursor',
  '    files: []',
  '    merged:',
  '      - file: .mcp.json',
  '        pointer: /mcpServers/context7',
  '        value:',
  '          type: http',
  '          url: https://mcp.context7.com/mcp',
  '          headers:',
  '            Authorization: Bearer ${CTX_TOKEN}',
  '      - file: .cursor/mcp.json',
  '        pointer: /mcpServers/context7',
  '        value:',
  '          url: https://mcp.context7.com/mcp',
  '  - kind: plugin',
  '    name: superpowers',
  '    origin: obra',
  '    path: plugins/superpowers',
  '    contentHash: sha256:bbbb',
  '    transform: 1',
  '    targets:',
  '      - claude',
  '    files: []',
  '    deps:',
  '      - kind: skill',
  '        name: brainstorm',
  '      - kind: command',
  '        name: plan',
].join('\n')}\n`;

/** A lockfile v1 as palm 0.0 wrote it (timestamps, plain file paths). */
const V1_TEXT = `${[
  '# palm lockfile — generated, do not edit by hand.',
  'version: 1',
  'entries:',
  '  - kind: skill',
  '    name: alpha',
  '    origin: a',
  '    path: skills/alpha',
  '    contentHash: sha256:ffff',
  '    installedAt: 2026-09-01T10:00:06.000Z',
  '    targets:',
  '      - copilot',
  '    files:',
  '      - .github/skills/alpha',
  '  - kind: skill',
  '    name: Alpha',
  '    origin: b',
  '    path: skills/alpha',
  '    contentHash: sha256:ffff',
  '    installedAt: 2026-09-01T10:00:05.000Z',
  '    targets:',
  '      - copilot',
  '    files:',
  '      - .github/skills/alpha',
  '  - kind: skill',
  '    name: brainstorm',
  '    origin: obra',
  '    path: plugins/superpowers/skills/brainstorm',
  '    contentHash: sha256:cccc',
  '    installedAt: 2026-09-01T10:00:02.000Z',
  '    targets:',
  '      - claude',
  '    files:',
  '      - .claude/skills/brainstorm',
  '    via: plugin:superpowers',
  '  - kind: skill',
  '    name: wayfinder',
  '    origin: mattpocock',
  '    url: https://github.com/mattpocock/skills.git',
  '    ref: v1.2.0',
  '    sha: 0123456789abcdef0123456789abcdef01234567',
  '    path: skills/wayfinder',
  '    contentHash: sha256:aaaa',
  '    installedAt: 2026-09-01T10:00:00.000Z',
  '    targets:',
  '      - claude',
  '      - codex',
  '    files:',
  '      - .claude/skills/wayfinder',
  '      - .agents/skills/wayfinder',
  '  - kind: agent',
  '    name: reviewer',
  '    origin: a',
  '    path: agents/reviewer.md',
  '    contentHash: sha256:1111',
  '    installedAt: 2026-09-01T10:00:07.000Z',
  '    targets:',
  '      - claude',
  '      - codex',
  '      - copilot',
  '      - cursor',
  '    files:',
  '      - .claude/agents/reviewer.md',
  '      - .codex/agents/reviewer.toml',
  '      - .github/agents/reviewer.agent.md',
  '      - .cursor/agents/reviewer.md',
  '    deps:',
  '      - kind: skill',
  '        name: tdd',
  '  - kind: instruction',
  '    name: style',
  '    origin: d',
  '    path: rules/style.md',
  '    contentHash: sha256:2222',
  '    installedAt: 2026-09-01T10:00:08.000Z',
  '    targets:',
  '      - cursor',
  '    files:',
  '      - .cursor/rules/style.mdc',
  '    via: agent:alpha',
  '  - kind: hook',
  '    name: fmt',
  '    origin: a',
  '    path: hooks/fmt.json',
  '    contentHash: sha256:eeee',
  '    installedAt: 2026-09-01T10:00:04.000Z',
  '    targets:',
  '      - claude',
  '    files:',
  '      - .palm/hooks/fmt/run.sh',
  '    merged:',
  '      - file: .claude/settings.json',
  '        pointer: /hooks/PostToolUse/-',
  '        value:',
  '          matcher: Edit',
  '          hooks:',
  '            - type: command',
  '              command: \'"$CLAUDE_PROJECT_DIR"/.palm/hooks/fmt/run.sh\'',
  '  - kind: mcp',
  '    name: context7',
  '    origin: registry',
  '    url: https://registry.modelcontextprotocol.io',
  '    ref: 1.0.3',
  '    path: io.github.upstash/context7',
  '    contentHash: sha256:dddd',
  '    installedAt: 2026-09-01T10:00:03.000Z',
  '    targets:',
  '      - claude',
  '      - cursor',
  '    files: []',
  '    merged:',
  '      - file: .mcp.json',
  '        pointer: /mcpServers/context7',
  '        value:',
  '          type: http',
  '          url: https://mcp.context7.com/mcp',
  '          headers:',
  '            Authorization: Bearer ${CTX_TOKEN}',
  '      - file: .cursor/mcp.json',
  '        pointer: /mcpServers/context7',
  '        value:',
  '          url: https://mcp.context7.com/mcp',
  '  - kind: plugin',
  '    name: superpowers',
  '    origin: obra',
  '    path: plugins/superpowers',
  '    contentHash: sha256:bbbb',
  '    installedAt: 2026-09-01T10:00:01.000Z',
  '    targets:',
  '      - claude',
  '    files: []',
  '    deps:',
  '      - kind: skill',
  '        name: brainstorm',
  '      - kind: command',
  '        name: plan',
].join('\n')}\n`;

function entry(name: string, extra: Partial<LockEntry> = {}): LockEntry {
  return {
    kind: 'skill',
    name,
    origin: 'o',
    path: `skills/${name}`,
    contentHash: 'sha256:x',
    transform: 1,
    targets: ['claude'],
    files: [{ path: `.claude/skills/${name}`, hash: 'sha256:f' }],
    ...extra,
  };
}

const agent = (name: string, deps: string[], extra: Partial<LockEntry> = {}): LockEntry =>
  entry(name, {
    kind: 'agent',
    files: [{ path: `.claude/agents/${name}.md`, hash: 'sha256:f' }],
    deps: deps.map((d) => ({ kind: 'skill', name: d })),
    ...extra,
  });

const names = (entries: LockEntry[]): string[] => entries.map((e) => e.name);

describe('Lock file I/O', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => removeDir(dir));

  it('writes lockfile v2 (golden), and load → save is stable', async () => {
    const built = join(dir, 'built.yaml');
    const lock = new Lock();
    for (const e of FIXTURE_ENTRIES) lock.upsert(structuredClone(e));
    await lock.save(built);
    expect(await readFile(built, 'utf8')).toBe(FIXTURE_TEXT);

    const file = join(dir, 'palm.lock.yaml');
    await writeFile(file, FIXTURE_TEXT);
    const loaded = await Lock.load(file);
    expect(loaded.size).toBe(FIXTURE_ENTRIES.length);
    await loaded.save(file);
    expect(await readFile(file, 'utf8')).toBe(FIXTURE_TEXT);
    expect(FIXTURE_TEXT.startsWith(`# ${LOCK_COMMENT}\n`)).toBe(true);
    expect(FIXTURE_TEXT).not.toMatch(/installedAt|\r|\d{4}-\d{2}-\d{2}T/);
  });

  it('is deterministic: any insertion order, saved twice, gives identical bytes', async () => {
    const a = join(dir, 'a.yaml');
    const b = join(dir, 'b.yaml');
    const shuffled = [...FIXTURE_ENTRIES].reverse().map((e) => ({
      ...structuredClone(e),
      files: [...e.files].reverse(),
      targets: [...e.targets].reverse(),
    }));
    await new Lock(structuredClone(FIXTURE_ENTRIES)).save(a);
    await new Lock(shuffled).save(b);
    const first = await readFile(a, 'utf8');
    expect(await readFile(b, 'utf8')).toBe(first);
    await (await Lock.load(a)).save(a);
    await (await Lock.load(a)).save(a);
    expect(await readFile(a, 'utf8')).toBe(first);
  });

  it('loads a v1 lock (timestamps, plain file paths) and saves it as v2', async () => {
    const file = join(dir, 'palm.lock.yaml');
    await writeFile(file, V1_TEXT);
    const lock = await Lock.load(file);
    const wayfinder = lock.find({ kind: 'skill', name: 'wayfinder' });
    expect(wayfinder).toMatchObject({
      transform: 0,
      files: [
        { path: '.claude/skills/wayfinder', hash: '' },
        { path: '.agents/skills/wayfinder', hash: '' },
      ],
    });
    expect(wayfinder).not.toHaveProperty('installedAt');
    expect(lock.toJSON().version).toBe(2);
    await lock.save(file);
    const text = await readFile(file, 'utf8');
    expect(text).toMatch(/^version: 2$/m);
    expect(text).not.toContain('installedAt');
    expect(text).toContain('      - path: .claude/skills/wayfinder\n        hash: ""\n');
    expect(text).toContain('    transform: 0\n');
    await (await Lock.load(file)).save(file);
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('lists files changed on disk since palm wrote them (edit-safe)', async () => {
    await writeFile(join(dir, 'same.txt'), 'same');
    await writeFile(join(dir, 'edited.txt'), 'edited by hand');
    const hashes: Record<string, string> = {
      [join(dir, 'same.txt')]: 'h:same',
      [join(dir, 'edited.txt')]: 'h:edited',
    };
    const e = entry('x', {
      files: [
        { path: 'same.txt', hash: 'h:same' },
        { path: 'edited.txt', hash: 'h:original' },
        { path: 'missing.txt', hash: 'h:gone' },
        { path: 'unknown.txt', hash: '' },
      ],
    });
    const paths = { abs: (f: string) => join(dir, f) };
    const changed = await Lock.modifiedFiles(e, paths, async (abs) => hashes[abs] ?? 'h:?');
    expect(changed).toEqual(['edited.txt']);
    expect(filePaths(e)).toEqual(['same.txt', 'edited.txt', 'missing.txt', 'unknown.txt']);
  });

  it('sorts one name from several origins by origin', async () => {
    const file = join(dir, 'l.yaml');
    await new Lock([entry('x', { origin: 'o2' }), entry('x', { origin: 'o1' })]).save(file);
    expect((await Lock.load(file)).entries.map((e) => e.origin)).toEqual(['o1', 'o2']);
  });

  it('is empty when the file is missing or empty', async () => {
    expect((await Lock.load(join(dir, 'nope.yaml'))).toJSON()).toEqual({ version: 2, entries: [] });
    await writeFile(join(dir, 'empty.yaml'), '');
    expect((await Lock.load(join(dir, 'empty.yaml'))).size).toBe(0);
    await writeFile(join(dir, 'no-entries.yaml'), 'version: 1\n');
    expect((await Lock.load(join(dir, 'no-entries.yaml'))).entries).toEqual([]);
  });

  it('defaults targets and files, and keeps the first of repeated keys', async () => {
    const file = join(dir, 'l.yaml');
    await writeFile(
      file,
      [
        'entries:',
        '  - {kind: skill, name: a, origin: o, path: p, contentHash: h, installedAt: t}',
        '  - {kind: skill, name: A, origin: o, path: second, contentHash: h, installedAt: t}',
        '',
      ].join('\n'),
    );
    const lock = await Lock.load(file);
    expect(lock.entries).toEqual([
      {
        kind: 'skill',
        name: 'a',
        origin: 'o',
        path: 'p',
        contentHash: 'h',
        transform: 0,
        targets: [],
        files: [],
      },
    ]);
  });

  it('rejects malformed locks', async () => {
    const cases: Array<[string, RegExp]> = [
      ['- a\n', /must be a YAML mapping/],
      ['version: 3\nentries: []\n', /unsupported lockfile version 3/],
      [
        'entries:\n  - {kind: skill, name: a, origin: o, files: [{hash: x}]}\n',
        /malformed `files`/,
      ],
      ['entries:\n  - {kind: skill, name: a}\n', /entry 1 needs a kind, name and origin/],
      ['entries:\n  - just-a-string\n', /entry 1 needs/],
      ['entries: [a\n', /./],
    ];
    for (const [text, message] of cases) {
      const file = join(dir, 'bad.yaml');
      await writeFile(file, text);
      await expect(Lock.load(file)).rejects.toMatchObject({ code: 'E_PARSE', message });
    }
    await mkdir(join(dir, 'a-dir'));
    await expect(Lock.load(join(dir, 'a-dir'))).rejects.toMatchObject({ code: 'E_IO' });
  });
});

describe('Lock lookups and edits', () => {
  it('finds by entity (any case) and by origin', () => {
    const lock = new Lock([entry('a'), entry('A', { origin: 'p' }), entry('b')]);
    expect(lock.find({ kind: 'skill', name: 'A' })?.origin).toBe('o');
    expect(lock.find({ kind: 'skill', name: 'a' }, 'p')?.name).toBe('A');
    expect(lock.find({ kind: 'skill', name: 'a' }, 'q')).toBeUndefined();
    expect(lock.find({ kind: 'agent', name: 'a' })).toBeUndefined();
    expect(lock.findAll({ kind: 'skill', name: 'a' }).map((e) => e.origin)).toEqual(['o', 'p']);
    expect(lock.findAll({ kind: 'skill', name: 'zz' })).toEqual([]);
  });

  it('upserts in place, appends new keys, removes by origin or entity', () => {
    const lock = new Lock([entry('a'), entry('b')]);
    lock.upsert(entry('A', { contentHash: 'sha256:y' }));
    expect(names(lock.entries)).toEqual(['A', 'b']);
    expect(lock.find({ kind: 'skill', name: 'a' })?.contentHash).toBe('sha256:y');
    lock.upsert(entry('a', { origin: 'p' })).upsert(entry('c'));
    expect(lock.entries.map(lockId)).toEqual(['skill:a@o', 'skill:b@o', 'skill:a@p', 'skill:c@o']);
    lock.remove({ kind: 'skill', name: 'a', origin: 'p' });
    expect(lock.findAll({ kind: 'skill', name: 'a' })).toHaveLength(1);
    lock.upsert(entry('a', { origin: 'p' })).remove({ kind: 'skill', name: 'A' });
    expect(names(lock.entries)).toEqual(['b', 'c']);
    lock
      .remove({ kind: 'skill', name: 'missing', origin: 'o' })
      .remove({ kind: 'skill', name: 'gone' });
    expect(lock.size).toBe(2);
  });

  it('selects by kind, name or registry name, and origin', () => {
    const weather = entry('weather', {
      kind: 'mcp',
      origin: 'registry',
      path: 'io.github.acme/weather',
    });
    const lock = new Lock([entry('a'), entry('a', { kind: 'agent' }), weather]);
    expect(lock.select({ name: 'A' })).toHaveLength(2);
    expect(lock.select({ kind: 'agent', name: 'a' })).toHaveLength(1);
    expect(lock.select({ name: 'a', origin: 'x' })).toEqual([]);
    expect(lock.select({ name: 'io.github.acme/WEATHER' })).toEqual([weather]);
    expect(answersTo(weather, 'Weather')).toBe(true);
    expect(
      answersTo(entry('x', { path: 'io.github.acme/weather' }), 'io.github.acme/weather'),
    ).toBe(false);
  });

  it('serialises through toJSON (change detection by JSON.stringify)', () => {
    const lock = new Lock([entry('a')]);
    const before = JSON.stringify(lock);
    expect(JSON.parse(before)).toEqual({ version: 2, entries: [entry('a')] });
    lock.upsert(entry('a'));
    expect(JSON.stringify(lock)).toBe(before);
    lock.upsert(entry('a', { contentHash: 'sha256:z' }));
    expect(JSON.stringify(lock)).not.toBe(before);
    expect(Lock.from({ version: 2, entries: [entry('q')] }).entries).toEqual([entry('q')]);
  });
});

describe('Lock via graph', () => {
  const plugin = entry('Bundle', {
    kind: 'plugin',
    files: [],
    deps: [{ kind: 'skill', name: 'm' }],
  });
  const member = entry('m', { via: 'plugin:bundle' });
  const nested = entry('n', { via: 'agent:helper' });
  const helper = agent('helper', ['n'], { via: 'plugin:Bundle' });

  it('links children and parents case-insensitively', () => {
    const lock = new Lock([plugin, member, helper, nested, entry('direct')]);
    expect(names(lock.childrenOf(plugin))).toEqual(['m', 'helper']);
    expect(lock.childrenOf(entry('m'))).toEqual([]); // skills install nothing
    expect(lock.parentOf(member)).toBe(plugin);
    expect(lock.parentOf(entry('direct'))).toBeUndefined();
    expect(lock.parentOf(entry('x', { via: 'garbage' }))).toBeUndefined();
    expect(lock.rootOf(nested)).toBe(plugin);
    expect(lock.rootOf(plugin)).toBe(plugin);
  });

  it('stops at a via cycle instead of looping', () => {
    const a = agent('a', [], { via: 'agent:b' });
    const b = agent('b', [], { via: 'agent:a' });
    const self = agent('self', [], { via: 'agent:self' });
    const lock = new Lock([a, b, self]);
    expect(lock.rootOf(a)).toBe(b);
    expect(lock.rootOf(self)).toBe(self);
    expect(names(lock.dependentsOf([a]))).toEqual(['a', 'b']);
  });

  it('collects dependents breadth first, not descending into stopAt', () => {
    const lock = new Lock([plugin, member, helper, nested]);
    expect(names(lock.dependentsOf([plugin]))).toEqual(['Bundle', 'm', 'helper', 'n']);
    expect(names(lock.dependentsOf([plugin], new Set([lockId(helper)])))).toEqual(['Bundle', 'm']);
    expect(names(lock.dependentsOf([member]))).toEqual(['m']);
  });

  it('diamond (A → S, B → S): only the via parent reaches S, both use it', () => {
    const a = agent('A', ['s']);
    const b = agent('B', ['S']);
    const s = entry('s', { via: 'agent:A' });
    const lock = new Lock([a, b, s]);
    expect(names(lock.dependentsOf([a]))).toEqual(['A', 's']);
    expect(names(lock.dependentsOf([b]))).toEqual(['B']);
    expect(names(lock.usersOf(s))).toEqual(['A', 'B']);
    expect(names(lock.usersOf(s, new Set([lockId(a)])))).toEqual(['B']);
    // only plugins and agents install dependencies
    const odd = entry('odd', { deps: [{ kind: 'skill', name: 's' }] });
    expect(names(new Lock([odd, s]).usersOf(s))).toEqual([]);
  });
});

describe('Lock.planRemoval', () => {
  it('diamond: removing A keeps S (re-parented to B); removing A and B removes S', () => {
    const a = agent('A', ['s']);
    const b = agent('B', ['s']);
    const s = entry('s', { via: 'agent:A' });
    const lock = new Lock([a, b, s]);

    const plan = lock.planRemoval([a]);
    expect(names(plan.removed)).toEqual(['A']);
    expect(plan.kept).toEqual([{ entry: s, via: 'agent:B' }]);
    lock.reparent(plan.kept);
    expect(lock.find(s)?.via).toBe('agent:B');

    const both = new Lock([a, b, s]).planRemoval([a, b]);
    expect(names(both.removed)).toEqual(['A', 'B', 's']);
    expect(both.kept).toEqual([]);
  });

  it('keeps what the manifest lists (now direct) and follows kept entries no further', () => {
    const p = entry('p', { kind: 'plugin', files: [], deps: [{ kind: 'agent', name: 'h' }] });
    const h = agent('h', ['x'], { via: 'plugin:p' });
    const x = entry('x', { via: 'agent:h' });
    const lock = new Lock([p, h, x]);
    const plan = lock.planRemoval([p], { listed: (e) => e.name === 'h' });
    expect(names(plan.removed)).toEqual(['p']);
    expect(plan.kept).toEqual([{ entry: h }]);
    lock.reparent(plan.kept);
    expect(lock.find(h)?.via).toBeUndefined();
    expect(lock.find(x)?.via).toBe('agent:h');
  });

  it('checks roots only with checkRoots (orphaned dependencies)', () => {
    const a = agent('A', []);
    const b = agent('B', ['s']);
    const s = entry('s', { via: 'agent:A' });
    const lock = new Lock([a, b, s]);
    expect(names(lock.planRemoval([s]).removed)).toEqual(['s']);
    const orphan = lock.planRemoval([s], { checkRoots: true });
    expect(orphan.removed).toEqual([]);
    expect(orphan.kept).toEqual([{ entry: s, via: 'agent:B' }]);
    const direct = entry('d');
    expect(names(new Lock([direct]).planRemoval([direct], { checkRoots: true }).removed)).toEqual([
      'd',
    ]);
  });
});

describe('Lock files on disk', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => removeDir(dir));

  const paths = (root: string) => ({ abs: (f: string) => (f.startsWith('/') ? f : join(root, f)) });

  it('protects merge targets and the files of entries that stay', () => {
    const a = entry('a', { merged: [{ file: '.mcp.json', pointer: '/x', value: 1 }] });
    const b = entry('b', { files: [{ path: '/abs/b', hash: '' }] });
    const lock = new Lock([a, b]);
    const p = paths('/root');
    expect([...lock.protectedFiles(p, [a])].sort()).toEqual(['/abs/b', '/root/.mcp.json']);
    expect([...lock.protectedFiles(p, [])].sort()).toEqual([
      '/abs/b',
      '/root/.claude/skills/a',
      '/root/.mcp.json',
    ]);
  });

  it('knows whether an entry and its dependents are intact', async () => {
    const p = entry('p', { kind: 'plugin', files: [] });
    const m = entry('m', { via: 'plugin:p' });
    const lock = new Lock([p, m]);
    const at = paths(dir);
    expect(Lock.filesPresent(p, at)).toBe(true);
    expect(Lock.filesPresent(m, at)).toBe(false);
    expect(await lock.intact(p, at)).toBe(false);
    await mkdir(join(dir, '.claude/skills/m'), { recursive: true });
    expect(await lock.intact(p, at)).toBe(true);
  });

  it('merged records count too: mergedDrift names each one its file no longer holds (H3)', async () => {
    const merged = [
      { file: '.mcp.json', pointer: '/mcpServers/a', value: { url: 'u' } },
      { file: 'AGENTS.md', pointer: 'block:instruction:a', value: 'text' },
    ];
    const e = entry('a', { files: [], merged });
    const lock = new Lock([e]);
    const at = paths(dir);
    const states: Record<string, 'held' | 'missing' | 'changed'> = {
      [join(dir, '.mcp.json')]: 'held',
      [join(dir, 'AGENTS.md')]: 'changed',
    };
    const check = async (rec: { file: string }) => states[rec.file] ?? 'missing';
    expect(await Lock.mergedDrift(e, at, check)).toEqual([{ record: merged[1], state: 'changed' }]);
    expect(await lock.intact(e, at, check)).toBe(false);
    expect(await lock.intact(e, at)).toBe(true); // without a check only files count
    states[join(dir, 'AGENTS.md')] = 'held';
    expect(await Lock.inPlace(e, at, check)).toBe(true);
    const failing = async () => {
      throw new Error('unreadable');
    };
    expect(await Lock.mergedDrift(e, at, failing)).toHaveLength(2); // an error counts as changed
  });

  it('records the persisted targets and the dirs palm created, sorted and deduplicated', async () => {
    const file = join(dir, 'palm.lock.yaml');
    const lock = new Lock([entry('a')]);
    lock.targets = ['codex', 'claude'];
    lock.noteCreatedDirs(['.codex', '.claude']).noteCreatedDirs(['.codex']);
    await lock.save(file);
    const text = await readFile(file, 'utf8');
    expect(text).toContain('targets: [claude, codex]\ncreatedDirs:\n  - .claude\n  - .codex\n');
    const back = await Lock.load(file);
    expect(back.targets).toEqual(['claude', 'codex']);
    expect(back.createdDirs).toEqual(['.claude', '.codex']);
  });
});
