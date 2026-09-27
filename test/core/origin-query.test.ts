import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addOrigin,
  allOrigins,
  deriveAlias,
  loadConfig,
  matchOrigin,
  ORIGIN_ALIAS_RE,
  parseOriginInput,
  resolveOriginQuery,
} from '../../src/core/config.js';
import type { OriginSpec, PalmContext } from '../../src/core/types.js';
import { makeContext, removeDir, sandbox, type Sandbox } from './helpers.js';

// `~` expands with os.homedir(); nothing below touches these paths on disk.
const HOME_DIR = join(homedir(), 'palm-origin-query-test');

const superpowers: OriginSpec = { alias: 'superpowers', type: 'git', url: 'https://github.com/obra/superpowers.git' };
const pstack: OriginSpec = { alias: 'pstack', type: 'git', url: 'https://github.com/cursor/plugins.git', root: 'pstack' };
const gitlab: OriginSpec = { alias: 'tools', type: 'git', url: 'git@gitlab.example.com:team/sub/tools.git' };
const local: OriginSpec = { alias: 'mine', type: 'local', path: join(HOME_DIR, 'mine') };
const localRooted: OriginSpec = { alias: 'mono-web', type: 'local', path: join(HOME_DIR, 'mono'), root: 'packages/web' };
const bare: OriginSpec = { alias: 'bare', type: 'git', url: '/srv/git/bare.git' };

describe('matchOrigin', () => {
  it.each<[string, OriginSpec, string, boolean]>([
    ['alias', superpowers, 'superpowers', true],
    ['alias, any case', superpowers, 'SuperPowers', true],
    ['owner/repo', superpowers, 'obra/superpowers', true],
    ['owner/repo, any case', superpowers, 'Obra/SuperPowers', true],
    ['full url', superpowers, 'https://github.com/obra/superpowers.git', true],
    ['url without .git', superpowers, 'https://github.com/obra/superpowers', true],
    ['url with trailing slash', superpowers, 'https://github.com/obra/superpowers/', true],
    ['owner alone', superpowers, 'obra', false],
    ['other owner', superpowers, 'someone/superpowers', false],
    ['alias prefix', superpowers, 'super', false],
    ['empty query', superpowers, '  ', false],
    ['owner/repo/root', pstack, 'cursor/plugins/pstack', true],
    ['owner/repo of a rooted origin', pstack, 'cursor/plugins', true],
    ['other root', pstack, 'cursor/plugins/other', false],
    ['url of a rooted origin', pstack, 'https://github.com/cursor/plugins.git', true],
    ['scp url: full repo path', gitlab, 'team/sub/tools', true],
    ['scp url: last two segments', gitlab, 'sub/tools', true],
    ['scp url itself', gitlab, 'git@gitlab.example.com:team/sub/tools.git', true],
    ['local: absolute path', local, join(HOME_DIR, 'mine'), true],
    ['local: absolute path, trailing slash', local, `${join(HOME_DIR, 'mine')}/`, true],
    ['local: ~ path', local, '~/palm-origin-query-test/mine', true],
    ['local: relative path is not a match', local, 'palm-origin-query-test/mine', false],
    ['local: other path', local, join(HOME_DIR, 'other'), false],
    ['local with root: path + root', localRooted, '~/palm-origin-query-test/mono/packages/web', true],
    ['local with root: directory only', localRooted, join(HOME_DIR, 'mono'), true],
    ['bare repo: its path', bare, '/srv/git/bare.git', true],
    ['bare repo: no owner/repo form', bare, 'git/bare', false],
  ])('%s: %s ~ %j → %s', (_label, spec, query, expected) => {
    expect(matchOrigin(spec, query)).toBe(expected);
  });
});

describe('resolveOriginQuery', () => {
  let sb: Sandbox;
  let ctx: PalmContext;
  const cursor: OriginSpec = { alias: 'cursor', type: 'git', url: 'https://github.com/cursor/plugins.git' };
  const rules: OriginSpec = { alias: 'rules', type: 'git', url: 'https://github.com/cursor/plugins.git', root: 'rules' };
  const spNext: OriginSpec = { alias: 'sp-next', type: 'git', url: 'https://github.com/obra/superpowers.git', ref: 'next' };
  const curatedA: OriginSpec = { alias: 'curated', type: 'git', url: 'https://github.com/openai/skills.git', root: 'skills/.curated' };
  const curatedB: OriginSpec = { alias: 'experimental', type: 'git', url: 'https://github.com/openai/skills.git', root: 'skills/.experimental' };

  beforeEach(async () => {
    sb = await sandbox();
    ctx = await makeContext(sb);
    ctx.config.origins.push(superpowers, spNext, cursor, pstack, rules, local, localRooted, curatedA, curatedB);
    await writeFile(join(sb.project, 'palm.yaml'), 'origins:\n  - { alias: fork, url: https://github.com/acme/superpowers-fork.git }\n');
  });
  afterEach(async () => removeDir(sb.root));

  it.each<[string, string, string]>([
    ['alias', 'superpowers', 'superpowers'],
    ['alias beats a repository match', 'SP-NEXT', 'sp-next'],
    ['owner/repo/root', 'cursor/plugins/pstack', 'pstack'],
    ['owner/repo: the root-less origin beats rooted ones', 'cursor/plugins', 'cursor'],
    ['url: the root-less origin beats rooted ones', 'https://github.com/cursor/plugins', 'cursor'],
    ['owner/repo/root with a nested root', 'openai/skills/skills/.curated', 'curated'],
    ['absolute path', join(HOME_DIR, 'mine'), 'mine'],
    ['~ path', '~/palm-origin-query-test/mine', 'mine'],
    ['~ path + root', '~/palm-origin-query-test/mono/packages/web', 'mono-web'],
    ['project palm.yaml origin by owner/repo', 'acme/superpowers-fork', 'fork'],
  ])('%s: %j → %s', (_label, query, alias) => {
    expect(resolveOriginQuery(ctx, query).alias).toBe(alias);
  });

  it('is ambiguous when several origins match equally well', () => {
    // two aliases of one repository
    expect(() => resolveOriginQuery(ctx, 'obra/superpowers')).toThrow(expect.objectContaining({ code: 'E_AMBIGUOUS' }));
    // only rooted origins of one repository
    let err: unknown;
    try {
      resolveOriginQuery(ctx, 'openai/skills');
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'E_AMBIGUOUS', message: expect.stringMatching(/curated.*experimental/) });
    expect((err as { hint: string }).hint).toMatch(/-o curated/);
  });

  it('lists the registered aliases when nothing matches', () => {
    expect(() => resolveOriginQuery(ctx, 'nobody/nothing')).toThrow(
      expect.objectContaining({
        code: 'E_NOT_FOUND',
        message: 'No origin matches "nobody/nothing"',
        hint: expect.stringContaining('Registered origins: curated, cursor, experimental, fork, mine, mono-web, pstack, rules, sp-next, superpowers.'),
      }),
    );
  });

  it('says so when no origin is registered', async () => {
    const empty = await makeContext(sb, { cwd: sb.root });
    expect(() => resolveOriginQuery(empty, 'x')).toThrow(expect.objectContaining({ code: 'E_NOT_FOUND', hint: expect.stringMatching(/No origins are registered/) }));
  });
});

describe('origin aliases are mandatory', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await sandbox();
    await mkdir(sb.palmHome, { recursive: true });
  });
  afterEach(async () => removeDir(sb.root));

  const paths = (): Parameters<typeof loadConfig>[0] => ({ palmHome: sb.palmHome, home: sb.home, projectRoot: sb.project, cwd: sb.project });
  const writeConfig = (yaml: string): Promise<void> => writeFile(join(sb.palmHome, 'config.yaml'), yaml);
  const writeProject = (yaml: string): Promise<void> => writeFile(join(sb.project, 'palm.yaml'), yaml);

  it('config.yaml: a git origin without alias is E_PARSE naming the file, the url and the derived alias', async () => {
    await writeConfig('origins:\n  - type: git\n    url: https://github.com/obra/superpowers.git\n');
    const file = join(sb.palmHome, 'config.yaml');
    await expect(loadConfig(paths())).rejects.toMatchObject({
      code: 'E_PARSE',
      message: `${file}: origin https://github.com/obra/superpowers.git has no alias`,
      hint: 'add `alias: superpowers` (palm derives that name with `palm origin add`)',
    });
  });

  it('config.yaml: a local origin without alias, and an empty alias, are E_PARSE', async () => {
    await writeConfig('origins:\n  - type: local\n    path: ~/code/my-skills\n');
    await expect(loadConfig(paths())).rejects.toMatchObject({ code: 'E_PARSE', message: expect.stringMatching(/origin ~\/code\/my-skills has no alias$/), hint: expect.stringContaining('alias: my-skills') });
    await writeConfig('origins:\n  - alias: ""\n    url: https://github.com/obra/superpowers.git\n');
    await expect(loadConfig(paths())).rejects.toMatchObject({ code: 'E_PARSE', message: expect.stringMatching(/has no alias$/) });
  });

  it('palm.yaml: a mapping without alias is E_PARSE (not skipped)', async () => {
    await writeProject('origins:\n  - url: https://github.com/acme/tools.git\n');
    const ctx = await makeContext(sb);
    const file = join(sb.project, 'palm.yaml');
    expect(() => allOrigins(ctx)).toThrow(
      expect.objectContaining({ code: 'E_PARSE', message: `${file}: origin https://github.com/acme/tools.git has no alias`, hint: expect.stringContaining('alias: tools') }),
    );
  });

  it('palm.yaml: a string entry has no alias either', async () => {
    await writeProject('origins:\n  - acme/superpowers-fork\n');
    const ctx = await makeContext(sb);
    expect(() => allOrigins(ctx)).toThrow(
      expect.objectContaining({
        code: 'E_PARSE',
        message: expect.stringMatching(/palm\.yaml: origin acme\/superpowers-fork has no alias$/),
        hint: expect.stringContaining('{ alias: superpowers-fork, type: git, url: https://github.com/acme/superpowers-fork.git }'),
      }),
    );
  });

  it.each(['My-Origin', 'UPPER', '-lead', '.hidden', '_under', 'with space', 'emoji✓', 'a/b'])('rejects the alias %j in config.yaml, palm.yaml and on add', async (alias) => {
    await writeConfig(`origins:\n  - alias: ${JSON.stringify(alias)}\n    url: https://github.com/obra/superpowers.git\n`);
    await expect(loadConfig(paths())).rejects.toMatchObject({ code: 'E_PARSE', message: expect.stringContaining(`invalid origin alias "${alias}"`), hint: expect.stringMatching(/lowercase/) });

    await writeConfig('origins: []\n');
    await writeProject(`origins:\n  - alias: ${JSON.stringify(alias)}\n    url: https://github.com/obra/superpowers.git\n`);
    const ctx = await makeContext(sb);
    expect(() => allOrigins(ctx)).toThrow(expect.objectContaining({ code: 'E_PARSE' }));

    expect(() => parseOriginInput('obra/superpowers', { alias })).toThrow(expect.objectContaining({ code: 'E_USAGE' }));
    await writeProject('origins: []\n');
    await expect(addOrigin(ctx, { alias, type: 'git', url: 'https://github.com/obra/superpowers.git' })).rejects.toMatchObject({ code: 'E_USAGE' });
  });

  it('suggests a valid spelling for an invalid alias', async () => {
    await writeConfig('origins:\n  - alias: My Origin\n    url: https://github.com/obra/superpowers.git\n');
    await expect(loadConfig(paths())).rejects.toMatchObject({ hint: expect.stringContaining('`my-origin`') });
  });

  it.each(['a', '0x', 'my.origin_2-b', 'superpowers'])('accepts the alias %j', async (alias) => {
    expect(ORIGIN_ALIAS_RE.test(alias)).toBe(true);
    await writeConfig(`origins:\n  - alias: ${alias}\n    url: https://github.com/obra/superpowers.git\n`);
    expect((await loadConfig(paths())).origins.map((o) => o.alias)).toEqual([alias]);
  });

  it('derived aliases always pass the format check', () => {
    for (const input of ['owner/_private', 'Obra/SuperPowers', 'openai/skills/skills/.curated', 'x/-dash', 'git@host.example:a/B.C.git']) {
      expect(deriveAlias(parseOriginInput(input, { cwd: '/' }), []), input).toMatch(ORIGIN_ALIAS_RE);
    }
  });

  it('rejects duplicate aliases: E_CONFLICT on add, E_PARSE within one file', async () => {
    const ctx = await makeContext(sb);
    await addOrigin(ctx, parseOriginInput('obra/superpowers', { alias: 'sp' }));
    await expect(addOrigin(ctx, parseOriginInput('acme/other', { alias: 'sp' }))).rejects.toMatchObject({
      code: 'E_CONFLICT',
      message: expect.stringContaining('"sp" is already used by https://github.com/obra/superpowers.git'),
    });
    await expect(addOrigin(ctx, parseOriginInput('acme/other', { alias: 'sp' }), { scope: 'project' })).rejects.toMatchObject({ code: 'E_CONFLICT' });

    await writeConfig('origins:\n  - { alias: sp, url: https://github.com/obra/superpowers.git }\n  - { alias: sp, url: https://github.com/acme/other.git }\n');
    await expect(loadConfig(paths())).rejects.toMatchObject({ code: 'E_PARSE', message: expect.stringContaining('origin alias "sp" is used twice') });

    await writeConfig('origins: []\n');
    await writeProject('origins:\n  - { alias: sp, url: https://github.com/obra/superpowers.git }\n  - { alias: sp, url: https://github.com/acme/other.git }\n');
    const proj = await makeContext(sb);
    expect(() => allOrigins(proj)).toThrow(expect.objectContaining({ code: 'E_PARSE', message: expect.stringContaining('is used twice') }));
  });

  it('palm origin add always stores the alias it derived', async () => {
    const ctx = await makeContext(sb);
    await addOrigin(ctx, parseOriginInput('obra/superpowers'));
    await addOrigin(ctx, parseOriginInput('someone/superpowers'), { scope: 'project' });
    expect((await loadConfig(paths())).origins.map((o) => o.alias)).toEqual(['superpowers']);
    const reloaded = await makeContext(sb);
    expect(allOrigins(reloaded).map((o) => o.alias)).toEqual(['superpowers', 'someone-superpowers']);
  });
});
