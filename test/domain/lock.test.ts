import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LockEntry, LockSource, Rendered } from '../../src/core/types.js';
import {
  fragmentId,
  fragmentKey,
  LOCK_VERSION,
  Lock,
  renderHashOf,
} from '../../src/domain/lock.js';
import { cleanupTmp, read, tmpDir, write } from '../support/sandbox.js';

afterEach(cleanupTmp);

const entry = (e: Partial<LockEntry> & Pick<LockEntry, 'kind' | 'name'>): LockEntry => ({
  source: 'mattpocock/skills',
  path: `skills/${e.name}`,
  content: 'sha256:c0',
  render: {},
  files: [],
  ...e,
});

const SOURCES: Record<string, LockSource> = {
  'obra/superpowers': {
    descriptor: 'plugin-manifest',
    sha: 'a1b2',
    resolved: 'v4.0.3',
    ref: '^4',
    url: 'https://github.com/obra/superpowers.git',
  },
  './agent-kit': { tree: 'sha256:1093', path: 'agent-kit', descriptor: 'convention' },
};

function sampleLock(): Lock {
  return new Lock(SOURCES, [
    entry({
      kind: 'hook',
      name: 'quality',
      source: './agent-kit',
      path: 'hooks/hooks.json',
      render: { claude: 'sha256:c4d5' },
      merged: [
        {
          key: 'sha256:3e01a9f2',
          id: 'palm:hook:quality:0',
          at: '/hooks/Stop',
          file: '.claude/settings.json',
        },
      ],
      exec: {
        hash: 'sha256:a7cc',
        commands: [
          { command: 'bash "$CLAUDE_PROJECT_DIR"/agent-kit/hooks/quality.sh', id: 'Stop//-' },
        ],
      },
      trust: ['sha256:a7cc'],
    }),
    entry({
      kind: 'skill',
      name: 'tdd',
      render: { cursor: 'sha256:9a0b', claude: 'sha256:9a0b' },
      files: ['.claude/skills/tdd/SKILL.md', '.claude/skills/tdd/b.md'],
      notes: ['cursor reads .claude/skills; no second copy'],
    }),
    entry({
      kind: 'plugin',
      name: 'superpowers',
      source: 'obra/superpowers',
      path: '.',
      deps: [
        { kind: 'hook', name: 'session-start' },
        { kind: 'skill', name: 'brainstorming' },
      ],
    }),
    entry({
      kind: 'skill',
      name: 'brainstorming',
      source: 'obra/superpowers',
      via: 'plugin:superpowers',
    }),
  ]);
}

describe('Lock save', () => {
  it('writes the DESIGN layout: version, sources by name, entries by kind and name, keys in order', async () => {
    const file = join(await tmpDir(), 'palm.lock.yaml');
    await sampleLock().save(file);
    expect(await read(file)).toBe(`# palm lockfile: written by palm, do not edit by hand.
version: 3
sources:
  ./agent-kit:
    path: agent-kit
    tree: sha256:1093
    descriptor: convention
  obra/superpowers:
    url: https://github.com/obra/superpowers.git
    ref: ^4
    resolved: v4.0.3
    sha: a1b2
    descriptor: plugin-manifest
entries:
  - kind: skill
    name: brainstorming
    source: obra/superpowers
    via: plugin:superpowers
    path: skills/brainstorming
    content: sha256:c0
    render: {}
    files: []
  - kind: skill
    name: tdd
    source: mattpocock/skills
    path: skills/tdd
    content: sha256:c0
    render: {claude: sha256:9a0b, cursor: sha256:9a0b}
    files:
      - .claude/skills/tdd/SKILL.md
      - .claude/skills/tdd/b.md
    notes:
      - cursor reads .claude/skills; no second copy
  - kind: hook
    name: quality
    source: ./agent-kit
    path: hooks/hooks.json
    content: sha256:c0
    render: {claude: sha256:c4d5}
    files: []
    merged:
      - {file: .claude/settings.json, at: /hooks/Stop, id: palm:hook:quality:0, key: sha256:3e01a9f2}
    exec:
      commands:
        - {id: Stop//-, command: bash "$CLAUDE_PROJECT_DIR"/agent-kit/hooks/quality.sh}
      hash: sha256:a7cc
    trust: [sha256:a7cc]
  - kind: plugin
    name: superpowers
    source: obra/superpowers
    path: .
    content: sha256:c0
    render: {}
    files: []
    deps:
      - {kind: skill, name: brainstorming}
      - {kind: hook, name: session-start}
`);
  });

  it('is deterministic: the same lock gives the same bytes, and hash() is their sha256', async () => {
    const dir = await tmpDir();
    const a = sampleLock();
    const b = new Lock(SOURCES, [...sampleLock().entries].reverse());
    await a.save(join(dir, 'a.yaml'));
    await b.save(join(dir, 'b.yaml'));
    expect(await read(join(dir, 'a.yaml'))).toBe(await read(join(dir, 'b.yaml')));
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).toMatch(/^sha256:[0-9a-f]{64}$/);
    const reloaded = await Lock.load(join(dir, 'a.yaml'));
    expect(reloaded.toJSON()).toEqual(a.toJSON());
    expect(reloaded.hash()).toBe(a.hash());
  });
});

describe('Lock load', () => {
  it('is empty when the file is missing or empty', async () => {
    expect((await Lock.load('/nonexistent/palm.lock.yaml')).size).toBe(0);
    const file = join(await tmpDir(), 'palm.lock.yaml');
    await write(file, '');
    expect((await Lock.load(file)).toJSON()).toEqual({
      version: LOCK_VERSION,
      sources: {},
      entries: [],
    });
  });

  it('sends a 0.1 lock to palm migrate, and loadLegacy reads it as data', async () => {
    const file = join(await tmpDir(), 'palm.lock.yaml');
    await write(
      file,
      'version: 2\ntargets: [claude]\nentries:\n  - kind: skill\n    name: tdd\n    origin: matt\n    path: skills/tdd\n',
    );
    await expect(Lock.load(file)).rejects.toMatchObject({
      code: 'E_USAGE',
      message: 'palm.lock.yaml is version 2 (palm 0.1)',
      hint: 'palm migrate',
    });
    expect(await Lock.loadLegacy(file)).toEqual({
      version: 2,
      targets: ['claude'],
      entries: [{ kind: 'skill', name: 'tdd', origin: 'matt', path: 'skills/tdd' }],
    });
    await write(file, 'entries:\n  - kind: skill\n    name: tdd\n    origin: matt\n');
    await expect(Lock.load(file)).rejects.toMatchObject({
      code: 'E_USAGE',
      message: expect.stringContaining('version 1'),
    });
    expect((await Lock.loadLegacy(file))?.version).toBe(1);
    await sampleLock().save(file);
    expect(await Lock.loadLegacy(file)).toBeUndefined();
    expect(await Lock.loadLegacy(join(file, '..', 'missing.yaml'))).toBeUndefined();
  });

  it('refuses an unknown version and entries without the required fields', async () => {
    const file = join(await tmpDir(), 'palm.lock.yaml');
    await write(file, 'version: 4\nentries: []\n');
    await expect(Lock.load(file)).rejects.toMatchObject({ code: 'E_PARSE' });
    for (const missing of ['kind', 'name', 'source', 'path', 'content', 'render']) {
      const e: Record<string, unknown> = {
        kind: 'skill',
        name: 'x',
        source: 's',
        path: 'p',
        content: 'c',
        render: {},
      };
      delete e[missing];
      await write(file, `version: 3\nentries:\n  - ${JSON.stringify(e)}\n`);
      await expect(Lock.load(file), missing).rejects.toMatchObject({
        code: 'E_PARSE',
        message: expect.stringContaining('entry 1'),
      });
    }
  });
});

describe('Lock as a collection', () => {
  it('finds, selects, upserts and removes by kind + name (any case) + source', () => {
    const lock = sampleLock();
    lock.upsert(entry({ kind: 'skill', name: 'TDD', source: 'other' }));
    expect(lock.find({ kind: 'skill', name: 'tdd' }, 'mattpocock/skills')?.source).toBe(
      'mattpocock/skills',
    );
    expect(lock.findAll({ kind: 'skill', name: 'Tdd' })).toHaveLength(2);
    expect(lock.select({ name: 'TDD', source: 'OTHER' })).toHaveLength(1);
    expect(lock.select({ kind: 'agent', name: 'tdd' })).toEqual([]);
    lock.upsert({ ...entry({ kind: 'skill', name: 'tdd' }), content: 'sha256:new' });
    expect(lock.find({ kind: 'skill', name: 'tdd' }, 'mattpocock/skills')?.content).toBe(
      'sha256:new',
    );
    lock.remove({ kind: 'skill', name: 'tdd' });
    expect(lock.findAll({ kind: 'skill', name: 'tdd' })).toEqual([]);
    expect(lock.entriesOf('obra/superpowers').map((e) => e.name)).toEqual([
      'superpowers',
      'brainstorming',
    ]);
  });

  it('keeps source records', () => {
    const lock = new Lock().setSource('a/b', { url: 'u', sha: 's' });
    expect(lock.source('a/b')).toEqual({ url: 'u', sha: 's' });
    expect(Object.keys(lock.removeSource('a/b').sources)).toEqual([]);
  });

  it('links plugins and members through via and deps, per source', () => {
    const lock = sampleLock();
    lock.upsert(
      entry({
        kind: 'skill',
        name: 'brainstorming',
        source: 'elsewhere',
        via: 'plugin:superpowers',
      }),
    );
    const plugin = lock.find({ kind: 'plugin', name: 'superpowers' }) as LockEntry;
    expect(lock.childrenOf(plugin).map((e) => e.source)).toEqual(['obra/superpowers']);
    expect(lock.childrenOf({ kind: 'plugin', name: 'superpowers' })).toHaveLength(2);
    const member = lock.find(
      { kind: 'skill', name: 'brainstorming' },
      'obra/superpowers',
    ) as LockEntry;
    expect(lock.parentOf(member)?.name).toBe('superpowers');
    expect(
      lock.usersOf({ kind: 'skill', name: 'brainstorming', source: 'obra/superpowers' }),
    ).toEqual([plugin]);
    expect(lock.usersOf({ kind: 'skill', name: 'brainstorming', source: 'elsewhere' })).toEqual([]);
  });

  it('ownedPaths lists files and fragments; trust is recorded once and checked', () => {
    const lock = sampleLock();
    expect([...lock.ownedPaths()].sort()).toEqual([
      '.claude/settings.json#/hooks/Stop#sha256:3e01a9f2',
      '.claude/skills/tdd/SKILL.md',
      '.claude/skills/tdd/b.md',
    ]);
    const hook = lock.find({ kind: 'hook', name: 'quality' }) as LockEntry;
    expect(lock.trusted(hook)).toBe(true);
    const changed = {
      ...hook,
      exec: { ...(hook.exec as NonNullable<LockEntry['exec']>), hash: 'sha256:b2d4' },
    };
    lock.upsert(changed);
    expect(lock.trusted(changed)).toBe(false);
    lock.trust(changed, 'sha256:b2d4').trust(changed, 'sha256:b2d4');
    const now = lock.find({ kind: 'hook', name: 'quality' }) as LockEntry;
    expect(now.trust).toEqual(['sha256:a7cc', 'sha256:b2d4']);
    expect(lock.trusted(now)).toBe(true);
    expect(lock.trusted(entry({ kind: 'skill', name: 'x' }))).toBe(true);
  });
});

describe('Lock.planRemoval', () => {
  function plugins(): Lock {
    const src = 'obra/superpowers';
    return new Lock({}, [
      entry({
        kind: 'plugin',
        name: 'a',
        source: src,
        deps: [
          { kind: 'skill', name: 'x' },
          { kind: 'skill', name: 'y' },
        ],
      }),
      entry({ kind: 'plugin', name: 'b', source: src, deps: [{ kind: 'skill', name: 'y' }] }),
      entry({ kind: 'skill', name: 'x', source: src, via: 'plugin:a' }),
      entry({ kind: 'skill', name: 'y', source: src, via: 'plugin:a' }),
      entry({ kind: 'skill', name: 'z', source: src, via: 'plugin:a' }),
    ]);
  }

  it('takes the members of a removed plugin unless another plugin still declares them', () => {
    const lock = plugins();
    const a = lock.find({ kind: 'plugin', name: 'a' }) as LockEntry;
    const plan = lock.planRemoval([a]);
    expect(plan.removed.map((e) => e.name)).toEqual(['a', 'x', 'z']);
    expect(plan.kept).toEqual([
      { entry: lock.find({ kind: 'skill', name: 'y' }), via: 'plugin:b' },
    ]);
    lock.reparent(plan.kept);
    expect(lock.find({ kind: 'skill', name: 'y' })?.via).toBe('plugin:b');
  });

  it('keeps a member palm.yaml lists directly, without via; removing both plugins takes the rest', () => {
    const lock = plugins();
    const [a, b] = ['a', 'b'].map((n) => lock.find({ kind: 'plugin', name: n }) as LockEntry);
    const plan = lock.planRemoval([a as LockEntry, b as LockEntry], {
      listed: (e) => e.name === 'z',
    });
    expect(plan.removed.map((e) => e.name)).toEqual(['a', 'b', 'x', 'y']);
    expect(plan.kept.map((k) => [k.entry.name, k.via])).toEqual([['z', undefined]]);
    lock.reparent(plan.kept);
    expect(lock.find({ kind: 'skill', name: 'z' })).not.toHaveProperty('via');
  });

  it('removes a non-plugin root alone', () => {
    const lock = plugins();
    const x = lock.find({ kind: 'skill', name: 'x' }) as LockEntry;
    expect(lock.planRemoval([x])).toEqual({ removed: [x], kept: [] });
  });
});

describe('renderHashOf, fragmentKey, fragmentId', () => {
  const rendered: Pick<Rendered, 'files' | 'fragments'> = {
    files: [
      { path: '.claude/skills/tdd/SKILL.md', data: new TextEncoder().encode('# tdd\n') },
      { path: '.palm/assets/k/h/run.sh', data: new TextEncoder().encode('echo\n'), mode: 0o755 },
    ],
    fragments: [
      {
        file: '.claude/settings.json',
        at: '/hooks/Stop',
        id: 'palm:hook:h:0',
        key: 'sha256:1',
        value: { hooks: [{ type: 'command', command: 'x' }] },
      },
    ],
  };

  it('changes when a file byte, a mode or a fragment value changes, never with order', () => {
    const base = renderHashOf(rendered);
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    const [f0, f1] = rendered.files as [Rendered['files'][0], Rendered['files'][0]];
    const g0 = rendered.fragments[0] as Rendered['fragments'][0];
    expect(renderHashOf({ files: [f1, f0], fragments: [g0] })).toBe(base);
    expect(
      renderHashOf({
        ...rendered,
        files: [f0, { ...f1, data: new TextEncoder().encode('echo!\n') }],
      }),
    ).not.toBe(base);
    expect(renderHashOf({ ...rendered, files: [f0, { ...f1, mode: 0o644 }] })).not.toBe(base);
    expect(renderHashOf({ ...rendered, fragments: [{ ...g0, value: { hooks: [] } }] })).not.toBe(
      base,
    );
    expect(
      renderHashOf({ ...rendered, fragments: [{ ...g0, value: { ...(g0.value as object) } }] }),
    ).toBe(base);
    expect(renderHashOf({ ...rendered, fragments: [{ ...g0, id: 'palm:hook:h:9' }] })).toBe(base);
  });

  it('fragmentKey: block id, object key or table name, else a short hash of the identity fields', () => {
    expect(fragmentKey('block:instruction:db', 'text')).toBe('instruction:db');
    expect(fragmentKey('/mcpServers/docs', { url: 'x' })).toBe('docs');
    expect(fragmentKey('/mcp_servers/docs', { url: 'x' })).toBe('docs');
    expect(fragmentKey('/instructions', '.opencode/instructions/a.md')).toMatch(
      /^sha256:[0-9a-f]{8}$/,
    );
    const hook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'a.sh', timeout: 5 }] };
    const key = fragmentKey('/hooks/PreToolUse', hook);
    expect(key).toMatch(/^sha256:[0-9a-f]{8}$/);
    expect(
      fragmentKey('/hooks/PreToolUse', {
        hooks: [{ timeout: 9, command: 'a.sh', type: 'command' }],
        matcher: 'Bash',
      }),
    ).toBe(key);
    expect(fragmentKey('/hooks/PreToolUse', { ...hook, matcher: 'Edit' })).not.toBe(key);
    expect(() => fragmentKey('', {})).toThrowError(expect.objectContaining({ code: 'E_INTERNAL' }));
    expect(fragmentId({ kind: 'hook', name: 'quality' }, 0)).toBe('palm:hook:quality:0');
  });
});
