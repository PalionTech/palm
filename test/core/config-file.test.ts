import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadConfig,
  loadProjectOrigins,
  normalizeStoredOrigin,
  removeStoredOrigin,
  saveConfig,
  serializeOrigin,
  upsertStoredOrigin,
} from '../../src/core/config-file.js';
import type { OriginSpec, PalmPaths } from '../../src/core/types.js';
import { OriginAliasError } from '../../src/domain/origin.js';
import { fakeLogger } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';

let sb: Sandbox;
let paths: PalmPaths;
beforeEach(async () => {
  sb = await sandbox();
  paths = { palmHome: sb.palmHome, home: sb.home, projectRoot: sb.project, cwd: sb.project };
});
afterEach(async () => removeDir(sb.root));

const configFile = (): string => join(sb.palmHome, 'config.yaml');

describe('config.yaml', () => {
  it('round-trips, keeping comments, unknown keys and order; creates the file 0600', async () => {
    expect(await loadConfig(paths)).toEqual({ origins: [] });
    await saveConfig(paths, {
      targets: ['claude', 'codex'],
      origins: [{ alias: 'sp', type: 'git', url: 'https://github.com/obra/superpowers.git' }],
    });
    expect((await stat(configFile())).mode & 0o777).toBe(0o600);
    const fresh = await readFile(configFile(), 'utf8');
    expect(fresh).toContain('targets: [claude, codex]');

    await writeFile(
      configFile(),
      [
        '# my palm config',
        'targets: [claude] # where things go',
        'mcpRegistryUrl: https://registry.example/v0 # keep me',
        'origins:',
        '  # the good stuff',
        '  - alias: sp',
        '    url: https://github.com/obra/superpowers.git',
        '    description: Obra',
        'custom: { a: 1 }',
        '',
      ].join('\n'),
    );
    await chmod(configFile(), 0o644);
    const cfg = await loadConfig(paths);
    expect(cfg).toEqual({
      targets: ['claude'],
      mcpRegistryUrl: 'https://registry.example/v0',
      origins: [
        {
          alias: 'sp',
          type: 'git',
          url: 'https://github.com/obra/superpowers.git',
          description: 'Obra',
        },
      ],
      custom: { a: 1 },
    });
    await saveConfig(paths, {
      ...cfg,
      origins: [...cfg.origins, { alias: 'mine', type: 'local', path: '/srv/mine' }],
    });
    const text = await readFile(configFile(), 'utf8');
    for (const kept of ['# my palm config', '# where things go', '# keep me', '# the good stuff'])
      expect(text).toContain(kept);
    expect(text).toMatch(/^custom: \{ ?a: 1 ?\}$/m);
    expect((await stat(configFile())).mode & 0o777).toBe(0o600);
    expect((await loadConfig(paths)).origins.map((o) => o.alias)).toEqual(['sp', 'mine']);
  });

  it('drops unknown targets and keeps no empty targets key', async () => {
    await mkdir(sb.palmHome, { recursive: true });
    await writeFile(configFile(), 'targets: [nope]\n');
    expect(await loadConfig(paths)).toEqual({ origins: [] });
    await writeFile(configFile(), 'targets: [nope, cursor]\norigins: {}\n');
    expect(await loadConfig(paths)).toEqual({ targets: ['cursor'], origins: [] });
  });

  it('reports a non-mapping as E_PARSE, invalid YAML as E_PARSE and unreadable files as E_IO', async () => {
    await mkdir(sb.palmHome, { recursive: true });
    await writeFile(configFile(), '- a\n- b\n');
    await expect(loadConfig(paths)).rejects.toMatchObject({
      code: 'E_PARSE',
      message: `${configFile()} must be a YAML mapping`,
    });
    await writeFile(configFile(), 'a: [\n');
    await expect(loadConfig(paths)).rejects.toMatchObject({ code: 'E_PARSE' });
    await removeDir(configFile());
    await mkdir(configFile());
    await expect(loadConfig(paths)).rejects.toMatchObject({
      code: 'E_IO',
      message: expect.stringContaining(`Cannot read ${configFile()}`),
    });
  });
});

describe('stored origin entries', () => {
  const where = '/p/palm.yaml';

  it('normalizes git and local entries (relative and ~ paths, optional fields)', () => {
    expect(
      normalizeStoredOrigin(
        {
          alias: 'sp',
          url: 'https://github.com/obra/superpowers.git',
          ref: 'v1',
          root: '/skills/',
          layout: { skills: 'x/*' },
          description: 'd',
          extra: 'ignored',
        },
        '/base',
        where,
      ),
    ).toEqual({
      alias: 'sp',
      type: 'git',
      url: 'https://github.com/obra/superpowers.git',
      ref: 'v1',
      root: 'skills',
      layout: { skills: 'x/*' },
      description: 'd',
    });
    expect(normalizeStoredOrigin({ alias: 7, path: 'rel/dir' }, '/base', where)).toEqual({
      alias: '7',
      type: 'local',
      path: '/base/rel/dir',
    });
    expect(normalizeStoredOrigin({ alias: 'h', type: 'local', path: '~/x' }, '/b', where)).toEqual({
      alias: 'h',
      type: 'local',
      path: join(homedir(), 'x'),
    });
    // `ref: ""`, a non-mapping layout and a path next to a url are ignored
    expect(
      normalizeStoredOrigin(
        { alias: 'g', url: '/srv/r.git', path: 'x', ref: '', layout: 3 },
        '/b',
        where,
      ),
    ).toEqual({ alias: 'g', type: 'git', url: '/srv/r.git' });
  });

  it.each<[string, unknown, string, RegExp]>([
    ['not a mapping', 42, 'E_PARSE', /invalid origin entry 42/],
    ['git without url', { alias: 'x', type: 'git' }, 'E_PARSE', /git origin "x" has no url/],
    [
      'local without path',
      { alias: 'x', type: 'local' },
      'E_PARSE',
      /local origin "x" has no path/,
    ],
    ['refused url', { alias: 'x', url: '-oops' }, 'E_ORIGIN', /Refusing .*origin "x" URL/],
    ['refused url, no alias', { url: '-oops' }, 'E_ORIGIN', /origin "-oops" URL/],
  ])('rejects %s', (_label, raw, code, message) => {
    let err: unknown;
    try {
      normalizeStoredOrigin(raw, '/b', where);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code, message: expect.stringMatching(message) });
    expect(err).not.toBeInstanceOf(OriginAliasError);
  });

  it('alias problems are OriginAliasErrors (never skipped)', () => {
    for (const raw of [
      'obra/superpowers',
      { url: 'https://github.com/obra/superpowers.git' },
      { alias: ' ', path: '/srv/x' },
      { alias: 'Bad Alias', path: '/srv/x' },
    ]) {
      expect(() => normalizeStoredOrigin(raw, '/b', where), JSON.stringify(raw)).toThrow(
        OriginAliasError,
      );
    }
  });

  it('serializes known fields in a fixed order', () => {
    const spec = {
      description: 'd',
      root: 'r',
      url: 'u',
      type: 'git',
      alias: 'a',
      extra: 1,
    } as OriginSpec;
    expect(Object.keys(serializeOrigin(spec))).toEqual([
      'alias',
      'type',
      'url',
      'root',
      'description',
    ]);
  });

  it('upserts and removes by alias, keeping entries that do not parse', () => {
    const entries: Array<string | OriginSpec> = [
      'broken/string-entry',
      { alias: 'sp', type: 'git', url: 'https://github.com/obra/superpowers.git' },
    ];
    const pinned: OriginSpec = { ...(entries[1] as OriginSpec), alias: 'SP', ref: 'v2' };
    const replaced = upsertStoredOrigin(entries, pinned, '/b', where);
    expect(replaced).toEqual([entries[0], serializeOrigin(pinned)]);
    const tools: OriginSpec = { alias: 'tools', type: 'local', path: '/srv/tools' };
    expect(upsertStoredOrigin(entries, tools, '/b', where)).toEqual([...entries, tools]);
    expect(removeStoredOrigin(entries, 'SP', '/b', where)).toEqual([entries[0]]);
    expect(removeStoredOrigin(entries, 'nope', '/b', where)).toEqual(entries);
  });
});

describe('project origins (palm.yaml)', () => {
  const manifest = (): string => join(sb.project, 'palm.yaml');

  it('are empty without palm.yaml or an origins list', async () => {
    const log = fakeLogger();
    expect(loadProjectOrigins(paths, log)).toEqual([]);
    await writeFile(manifest(), 'skills: [a]\n');
    expect(loadProjectOrigins(paths, log)).toEqual([]);
    await writeFile(manifest(), '- just a list\n');
    expect(loadProjectOrigins(paths, log)).toEqual([]);
    expect(log.messages).toEqual([]);
  });

  it('ignore invalid YAML and skip refused entries with a warning', async () => {
    const log = fakeLogger();
    await writeFile(manifest(), 'origins: [\n');
    expect(loadProjectOrigins(paths, log)).toEqual([]);
    expect(log.messages[0]?.msg).toMatch(/^Ignoring origins in .*palm\.yaml/);
    await writeFile(
      manifest(),
      'origins:\n  - { alias: evil, url: "--upload-pack=x" }\n  - { alias: ok, path: ./local }\n',
    );
    expect(loadProjectOrigins(paths, log)).toEqual([
      { alias: 'ok', type: 'local', path: join(sb.project, 'local') },
    ]);
    expect(log.messages.at(-1)?.msg).toMatch(/Refusing/);
  });

  it('fail on alias problems and duplicates', async () => {
    const log = fakeLogger();
    await writeFile(manifest(), 'origins:\n  - { url: https://github.com/a/b.git }\n');
    expect(() => loadProjectOrigins(paths, log)).toThrow(OriginAliasError);
    await writeFile(
      manifest(),
      'origins:\n  - { alias: a, path: /x }\n  - { alias: a, url: https://github.com/a/b.git, root: sub }\n',
    );
    expect(() => loadProjectOrigins(paths, log)).toThrow(
      expect.objectContaining({
        code: 'E_PARSE',
        message: `${manifest()}: origin alias "a" is used twice (/x and https://github.com/a/b.git (sub))`,
        hint: 'Give each origin its own alias.',
      }),
    );
  });
});
