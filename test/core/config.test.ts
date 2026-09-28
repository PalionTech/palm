import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addOrigin,
  allOrigins,
  deriveAlias,
  ensureMineOrigin,
  findOrigin,
  loadConfig,
  originId,
  parseOriginInput,
  removeOrigin,
} from '../../src/core/config.js';
import { loadManifest } from '../../src/core/manifest.js';
import type { OriginSpec } from '../../src/core/types.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox, tempDir } from '../support/sandbox.js';

describe('parseOriginInput', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
    await mkdir(join(dir, 'my-skills'), { recursive: true });
  });
  afterEach(async () => removeDir(dir));

  it.each<[string, Partial<OriginSpec>]>([
    // A generic repository name (skills, plugins, agents, …) aliases to the owner.
    [
      'mattpocock/skills',
      { type: 'git', url: 'https://github.com/mattpocock/skills.git', alias: 'mattpocock' },
    ],
    [
      'mattpocock/skills#v1.2.3',
      { url: 'https://github.com/mattpocock/skills.git', ref: 'v1.2.3', alias: 'mattpocock' },
    ],
    ['anthropics/skills', { url: 'https://github.com/anthropics/skills.git', alias: 'anthropics' }],
    [
      'cursor/plugins/pstack',
      { url: 'https://github.com/cursor/plugins.git', root: 'pstack', alias: 'pstack' },
    ],
    [
      'cursor/plugins/a/b#main',
      { url: 'https://github.com/cursor/plugins.git', root: 'a/b', ref: 'main', alias: 'b' },
    ],
    [
      'github:obra/superpowers',
      { url: 'https://github.com/obra/superpowers.git', alias: 'superpowers' },
    ],
    [
      'https://github.com/obra/superpowers',
      { url: 'https://github.com/obra/superpowers.git', alias: 'superpowers' },
    ],
    [
      'https://github.com/obra/superpowers.git#v2',
      { url: 'https://github.com/obra/superpowers.git', ref: 'v2' },
    ],
    [
      'https://github.com/openai/skills/tree/main/skills/.curated',
      {
        url: 'https://github.com/openai/skills.git',
        ref: 'main',
        root: 'skills/.curated',
        alias: '.curated'.replace(/^\./, ''),
      },
    ],
    [
      'git@github.com:obra/superpowers.git#v1',
      { url: 'git@github.com:obra/superpowers.git', ref: 'v1', alias: 'superpowers' },
    ],
    ['git@github.com:obra/superpowers', { url: 'git@github.com:obra/superpowers.git' }],
    [
      'https://gitlab.com/group/sub/repo',
      { url: 'https://gitlab.com/group/sub/repo.git', alias: 'repo' },
    ],
    [
      'https://gitlab.com/group/repo/-/tree/dev/skills',
      { url: 'https://gitlab.com/group/repo.git', ref: 'dev', root: 'skills' },
    ],
    [
      'ssh://git@example.com/team/tools.git',
      { url: 'ssh://git@example.com/team/tools.git', alias: 'tools' },
    ],
  ])('%s', (input, expected) => {
    expect(parseOriginInput(input, { cwd: dir })).toMatchObject(expected);
  });

  it('accepts local paths (absolute, relative, bare existing dir)', () => {
    expect(parseOriginInput(join(dir, 'my-skills'))).toMatchObject({
      type: 'local',
      path: join(dir, 'my-skills'),
      alias: 'my-skills',
    });
    expect(parseOriginInput('./my-skills', { cwd: dir })).toMatchObject({
      type: 'local',
      path: join(dir, 'my-skills'),
    });
    expect(parseOriginInput('my-skills', { cwd: dir })).toMatchObject({
      type: 'local',
      path: join(dir, 'my-skills'),
    });
  });

  it('applies alias/ref/root overrides', () => {
    expect(parseOriginInput('a/b', { alias: 'x', ref: 'v1', root: 'sub/' })).toMatchObject({
      alias: 'x',
      ref: 'v1',
      root: 'sub',
    });
  });

  it('rejects missing local paths and garbage', () => {
    expect(() => parseOriginInput('./nope', { cwd: dir })).toThrow(/does not exist/);
    expect(() => parseOriginInput('not a spec', { cwd: dir })).toThrow(/Unrecognised origin/);
  });
});

describe('aliases and ids', () => {
  const gh = (s: string): OriginSpec => parseOriginInput(s, { cwd: '/' });
  const taken = (...aliases: string[]): OriginSpec[] =>
    aliases.map((alias) => ({ alias, type: 'git', url: 'x' }));

  it('derives aliases with collision fallbacks', () => {
    expect(deriveAlias(gh('obra/superpowers'), [])).toBe('superpowers');
    expect(deriveAlias(gh('obra/superpowers'), taken('superpowers'))).toBe('obra-superpowers');
    expect(deriveAlias(gh('obra/superpowers'), taken('superpowers', 'obra-superpowers'))).toBe(
      'obra-superpowers-2',
    );
    expect(
      deriveAlias(
        gh('obra/superpowers'),
        taken('superpowers', 'obra-superpowers', 'obra-superpowers-2'),
      ),
    ).toBe('obra-superpowers-3');
    expect(deriveAlias(gh('cursor/plugins/pstack'), [])).toBe('pstack');
    expect(deriveAlias(gh('cursor/plugins/pstack'), taken('pstack'))).toBe('cursor-pstack'); // `plugins` is generic → owner
    expect(deriveAlias(gh('Obra/SuperPowers'), [])).toBe('superpowers');
  });

  it('builds cache ids', () => {
    expect(originId(gh('mattpocock/skills'))).toBe('github.com__mattpocock__skills');
    expect(originId(gh('cursor/plugins/pstack'))).toBe('github.com__cursor__plugins__pstack');
    expect(originId(gh('git@github.com:Obra/superpowers.git'))).toBe(
      'github.com__obra__superpowers',
    );
    expect(originId({ alias: 'm', type: 'local', path: '/Users/Max/My Skills' })).toMatch(
      /^local__users__max__my-skills-[0-9a-f]{8}$/,
    );
    // Paths that sanitize to the same segments still get distinct ids.
    const a = originId({ alias: 'a', type: 'local', path: '/x/a/b' });
    const b = originId({ alias: 'b', type: 'local', path: '/x/a-b' });
    const c = originId({ alias: 'c', type: 'local', path: '/x/a b' });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('origin registry', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await sandbox();
  });
  afterEach(async () => removeDir(sb.root));

  it('loads defaults without writing anything', async () => {
    const ctx = await makeContext(sb);
    expect(ctx.config).toEqual({ origins: [] });
    expect(existsSync(sb.palmHome)).toBe(false);
    expect(await loadConfig(ctx.paths)).toEqual({ origins: [] });
  });

  it('adds global and project origins; project wins on alias clash', async () => {
    const ctx = await makeContext(sb);
    await addOrigin(ctx, parseOriginInput('mattpocock/skills'));
    await addOrigin(ctx, parseOriginInput('obra/superpowers'));
    const cfgText = await readFile(join(sb.palmHome, 'config.yaml'), 'utf8');
    expect(cfgText).toContain('https://github.com/mattpocock/skills.git');

    const reloaded = await makeContext(sb);
    expect(reloaded.config.origins.map((o) => o.alias)).toEqual(['mattpocock', 'superpowers']);

    // same default alias, different repo → auto-renamed
    const other = await addOrigin(reloaded, parseOriginInput('someone/superpowers'));
    expect(other.alias).toBe('someone-superpowers');

    // explicit alias clash → error
    await expect(
      addOrigin(reloaded, parseOriginInput('x/y', { alias: 'superpowers' })),
    ).rejects.toMatchObject({ code: 'E_CONFLICT' });

    // project scope writes palm.yaml origins
    await writeFile(
      join(sb.project, 'palm.yaml'),
      'origins:\n  - { alias: superpowers-fork, url: https://github.com/acme/superpowers-fork.git }\n',
    );
    const proj = await makeContext(sb);
    await addOrigin(
      proj,
      {
        alias: 'mattpocock',
        type: 'git',
        url: 'https://github.com/mattpocock/skills.git',
        ref: 'v2',
      },
      { scope: 'project' },
    );
    const m = await loadManifest(join(sb.project, 'palm.yaml'));
    expect(m.origins).toHaveLength(2);
    expect(findOrigin(proj, 'mattpocock')?.ref).toBe('v2'); // project wins
    expect(findOrigin(proj, 'superpowers-fork')?.url).toBe(
      'https://github.com/acme/superpowers-fork.git',
    );
    expect(
      allOrigins(proj)
        .map((o) => o.alias)
        .sort(),
    ).toEqual(['mattpocock', 'someone-superpowers', 'superpowers', 'superpowers-fork']);

    await removeOrigin(proj, 'superpowers-fork');
    expect(findOrigin(proj, 'superpowers-fork')).toBeUndefined();
    await removeOrigin(proj, 'superpowers');
    expect((await loadConfig(proj.paths)).origins.map((o) => o.alias)).toEqual([
      'mattpocock',
      'someone-superpowers',
    ]);
    await expect(removeOrigin(proj, 'nope')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('ensureMineOrigin creates and registers the mine origin once', async () => {
    const ctx = await makeContext(sb);
    const spec = await ensureMineOrigin(ctx);
    expect(spec).toMatchObject({ alias: 'mine', type: 'local', path: join(sb.palmHome, 'mine') });
    for (const sub of ['skills', 'agents', 'instructions', 'commands', 'README.md']) {
      expect(existsSync(join(sb.palmHome, 'mine', sub))).toBe(true);
    }
    await ensureMineOrigin(ctx);
    const cfg = await loadConfig(ctx.paths);
    expect(cfg.origins.filter((o) => o.alias === 'mine')).toHaveLength(1);
  });
});
