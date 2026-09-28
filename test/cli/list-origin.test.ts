import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { availableGroups, filterInstalled, installedOriginAlias } from '../../src/commands/get.js';
import { PalmError } from '../../src/core/errors.js';
import type { Entity, Kind, LockEntry, OriginIndex, OriginSpec } from '../../src/core/types.js';
import { runPalm } from '../support/cli.js';

const entry = (kind: Kind, name: string, origin: string): LockEntry => ({
  kind,
  name,
  origin,
  path: name,
  contentHash: 'sha256:0',
  installedAt: '2026-01-01T00:00:00.000Z',
  targets: ['claude'],
  files: [],
});

const entity = (kind: Kind, name: string, origin: string): Entity =>
  ({ kind, name, origin, path: name, description: `${name} from ${origin}` }) as unknown as Entity;

const index = (origin: string, entities: Entity[], warnings: string[] = []): OriginIndex => ({
  origin,
  originId: origin,
  root: `/tmp/${origin}`,
  entities,
  warnings,
  detected: 'convention',
  scannedAt: '2026-01-01T00:00:00.000Z',
});

const INSTALLED: LockEntry[] = [
  entry('skill', 'tdd', 'superpowers'),
  entry('agent', 'reviewer', 'superpowers'),
  entry('skill', 'brainstorm', 'superpowers'),
  entry('mcp', 'io.github.acme/weather', 'registry'),
  entry('mcp', 'docs', 'adhoc'),
  entry('skill', 'my-skill', 'mine'),
  entry('skill', 'old', 'Legacy'),
];

describe('palm list: installed view filtering', () => {
  it.each<[string, { kind?: Kind; origin?: string }, string[]]>([
    [
      'no filter: everything, sorted by kind and name',
      {},
      [
        'agent reviewer',
        'mcp docs',
        'mcp io.github.acme/weather',
        'skill brainstorm',
        'skill my-skill',
        'skill old',
        'skill tdd',
      ],
    ],
    ['one origin', { origin: 'superpowers' }, ['agent reviewer', 'skill brainstorm', 'skill tdd']],
    [
      'origin and kind',
      { origin: 'superpowers', kind: 'skill' },
      ['skill brainstorm', 'skill tdd'],
    ],
    ['pseudo-origin registry', { origin: 'registry' }, ['mcp io.github.acme/weather']],
    ['pseudo-origin adhoc', { origin: 'adhoc' }, ['mcp docs']],
    ['pseudo-origin mine', { origin: 'mine' }, ['skill my-skill']],
    ['alias compared case-insensitively', { origin: 'legacy' }, ['skill old']],
    ['an origin with nothing installed', { origin: 'pstack' }, []],
  ])('%s', (_label, opts, expected) => {
    expect(filterInstalled(INSTALLED, opts).map((e) => `${e.kind} ${e.name}`)).toEqual(expected);
  });

  const registered: OriginSpec[] = [
    { alias: 'superpowers', type: 'git', url: 'https://github.com/obra/superpowers.git' },
    { alias: 'pstack', type: 'git', url: 'https://github.com/cursor/plugins.git', root: 'pstack' },
  ];
  const resolveFake = (q: string): OriginSpec => {
    const hit = registered.find(
      (o) => o.alias === q.toLowerCase() || o.url === `https://github.com/${q}.git`,
    );
    if (!hit) throw new PalmError('E_NOT_FOUND', `No origin matches "${q}"`);
    return hit;
  };
  const neverCalled = (): OriginSpec => {
    throw new Error('resolver must not run for pseudo-origins');
  };

  it('resolves -o through the origin registry', () => {
    expect(installedOriginAlias('obra/superpowers', INSTALLED, resolveFake)).toBe('superpowers');
    expect(installedOriginAlias('pstack', INSTALLED, resolveFake)).toBe('pstack');
  });

  it.each(['mine', 'registry', 'adhoc', 'Registry'])('takes the pseudo-origin %j as is', (q) => {
    expect(installedOriginAlias(q, INSTALLED, neverCalled)).toBe(q.toLowerCase());
  });

  it('still finds entries of an origin removed after installing', () => {
    expect(installedOriginAlias('legacy', INSTALLED, resolveFake)).toBe('legacy');
    expect(
      filterInstalled(INSTALLED, {
        origin: installedOriginAlias('legacy', INSTALLED, resolveFake),
      }),
    ).toHaveLength(1);
  });

  it('passes E_NOT_FOUND and E_AMBIGUOUS through', () => {
    expect(() => installedOriginAlias('nobody', INSTALLED, resolveFake)).toThrow(
      expect.objectContaining({ code: 'E_NOT_FOUND' }),
    );
    const ambiguous = (): OriginSpec => {
      throw new PalmError('E_AMBIGUOUS', 'several');
    };
    expect(() => installedOriginAlias('superpowers', INSTALLED, ambiguous)).toThrow(
      expect.objectContaining({ code: 'E_AMBIGUOUS' }),
    );
  });
});

describe('palm list --available: grouping and filtering', () => {
  const indexes = [
    index(
      'superpowers',
      [
        entity('skill', 'tdd', 'superpowers'),
        entity('agent', 'reviewer', 'superpowers'),
        entity('skill', 'brainstorm', 'superpowers'),
      ],
      ['duplicate skill "tdd" in plugins a and b'],
    ),
    index('pstack', [entity('agent', 'comment-sicko', 'pstack')]),
  ];

  it('groups by origin, sorted within each group', () => {
    const groups = availableGroups(indexes);
    expect(groups.map((g) => [g.origin, g.entities.map((e) => `${e.kind} ${e.name}`)])).toEqual([
      ['superpowers', ['agent reviewer', 'skill brainstorm', 'skill tdd']],
      ['pstack', ['agent comment-sicko']],
    ]);
  });

  it('keeps only the selected origin (by alias, any case)', () => {
    expect(availableGroups(indexes, { origin: 'pstack' }).map((g) => g.origin)).toEqual(['pstack']);
    expect(availableGroups(indexes, { origin: 'SuperPowers' }).map((g) => g.origin)).toEqual([
      'superpowers',
    ]);
    expect(availableGroups(indexes, { origin: 'nope' })).toEqual([]);
  });

  it('applies the kind filter per group and reports duplicate warnings through the callback', () => {
    const groups = availableGroups(indexes, {
      kind: 'skill',
      origin: 'superpowers',
      duplicates: (ix, kind) =>
        ix.warnings.filter((w) => !kind || w.startsWith(`duplicate ${kind}`)),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entities.map((e) => e.name)).toEqual(['brainstorm', 'tdd']);
    expect(groups[0]!.duplicates).toEqual(['duplicate skill "tdd" in plugins a and b']);
    expect(availableGroups(indexes, { kind: 'mcp' }).every((g) => g.entities.length === 0)).toBe(
      true,
    );
  });
});

describe('palm list -o (CLI)', () => {
  const repo = resolve(import.meta.dirname, '../..');
  let home: string;

  const palm = (...args: string[]) =>
    runPalm(args, {
      cwd: join(home, 'project'),
      env: {
        HOME: home,
        PALM_HOME: join(home, '.palm'),
        NO_COLOR: '1',
        CI: '1',
        PATH: process.env.PATH,
      },
    });

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'palm-list-origin-'));
    await mkdir(join(home, 'project', '.git'), { recursive: true });
    await mkdir(join(home, '.palm'), { recursive: true });
    const fixtures = join(repo, 'test', 'fixtures');
    await writeFile(
      join(home, '.palm', 'config.yaml'),
      [
        'origins:',
        `  - { alias: anthropics, type: local, path: ${join(fixtures, 'anthropics-skills-like')} }`,
        `  - { alias: mattpocock, type: local, path: ${join(fixtures, 'mattpocock-like')} }`,
        '',
      ].join('\n'),
    );
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('documents -o on get, search and describe (and their old names)', async () => {
    for (const cmd of ['get', 'search', 'describe', 'list', 'info']) {
      const r = await palm(cmd, '--help');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('-o, --origin <name-or-alias>');
    }
  });

  it('--available shows one header per origin, and -o narrows it to one origin (by alias or path)', async () => {
    const all = await palm('list', '--available');
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toMatch(/^anthropics \(\d+\)$/m);
    expect(all.stdout).toMatch(/^mattpocock \(\d+\)$/m);

    const one = await palm('list', '--available', '-o', 'mattpocock', '--json');
    expect(one.exitCode).toBe(0);
    const groups = (
      JSON.parse(one.stdout) as { items: Array<{ origin: string; entities: unknown[] }> }
    ).items;
    expect(groups.map((g) => g.origin)).toEqual(['mattpocock']);
    expect(groups[0]!.entities.length).toBeGreaterThan(0);

    const byPath = await palm(
      'list',
      '--available',
      '--origin',
      join(repo, 'test', 'fixtures', 'anthropics-skills-like'),
      '--json',
    );
    expect(
      (JSON.parse(byPath.stdout) as { items: Array<{ origin: string }> }).items.map(
        (g) => g.origin,
      ),
    ).toEqual(['anthropics']);
  });

  it('an unknown origin is E_NOT_FOUND listing the registered aliases; pseudo-origins filter the installed view', async () => {
    const r = await palm('list', '-o', 'nobody', '--json');
    expect(r.exitCode).toBe(1);
    const err = (JSON.parse(r.stdout) as { error: { code: string; hint: string } }).error;
    expect(err.code).toBe('E_NOT_FOUND');
    expect(err.hint).toContain('Registered origins: anthropics, mattpocock.');

    const reg = await palm('get', '-o', 'registry', '--json');
    expect(reg.exitCode).toBe(0);
    expect(JSON.parse(reg.stdout)).toEqual({ items: [], warnings: [] });
  });
});
