import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isPalmError } from '../../src/core/errors.js';
import { findMarketplaceFile, normalizeSource, parseMarketplace } from '../../src/index/marketplace.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const mp = (name: string) => join(FIXTURES, 'marketplaces', name);

describe('parseMarketplace (real marketplace files)', () => {
  it('APM cache skills.json: single "./" entry becomes the repo itself', async () => {
    const r = await parseMarketplace(mp('apm-cache-skills.json'), { url: 'https://github.com/mattpocock/skills', ref: 'v1.2.3' });
    expect(r.warnings).toEqual([]);
    expect(r.origins).toEqual([
      {
        alias: 'mattpocock-skills',
        type: 'git',
        url: 'https://github.com/mattpocock/skills.git',
        ref: 'v1.2.3',
        description: expect.stringContaining("Matt Pocock's agent skills"),
      },
    ]);
  });

  it('APM cache superpowers.json with a local base path', async () => {
    const r = await parseMarketplace(mp('apm-cache-superpowers.json'), { path: '/srv/superpowers' });
    expect(r.origins).toEqual([{ alias: 'superpowers', type: 'local', path: '/srv/superpowers', description: expect.any(String) }]);
  });

  it('without a base, relative entries resolve against the marketplace directory', async () => {
    const r = await parseMarketplace(mp('apm-cache-superpowers.json'), {});
    expect(r.origins[0]?.path).toBe(join(FIXTURES, 'marketplaces'));
    const inRepo = await parseMarketplace(join(FIXTURES, 'mattpocock-like/.claude-plugin/marketplace.json'), {});
    expect(inRepo.origins[0]).toMatchObject({ alias: 'mattpocock-skills', type: 'local', path: join(FIXTURES, 'mattpocock-like') });
  });

  it('claude-plugins-official: git-subdir, url+sha and relative entries', async () => {
    const r = await parseMarketplace(mp('claude-plugins-official.json'), { url: 'https://github.com/anthropics/claude-plugins-official.git', ref: 'main' });
    const byAlias = Object.fromEntries(r.origins.map((o) => [o.alias, o]));
    expect(byAlias['42crunch-api-security-testing']).toMatchObject({
      type: 'git',
      url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      ref: 'faf5305385de8afed9468904e8639be737aff39e',
      root: 'plugins/api-security-testing',
    });
    expect(byAlias['agentforce-adlc']).toMatchObject({
      type: 'git',
      url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git',
      ref: '09bf1539d41f9ff355ba3eb5d05d4a75813423bb',
    });
    expect(byAlias['agentforce-adlc']?.root).toBeUndefined();
    expect(byAlias['agent-sdk-dev']).toMatchObject({
      type: 'git',
      url: 'https://github.com/anthropics/claude-plugins-official.git',
      ref: 'main',
      root: 'plugins/agent-sdk-dev',
    });
    expect(byAlias['asana']).toMatchObject({ root: 'external_plugins/asana' });
    expect(byAlias['clangd-lsp']).toMatchObject({ root: 'plugins/clangd-lsp' });
  });

  it('cursor/plugins: bare relative sources become roots of the same repo', async () => {
    const r = await parseMarketplace(mp('cursor-plugins.json'), { url: 'https://github.com/cursor/plugins.git', ref: 'main' });
    expect(r.origins.map((o) => [o.alias, o.url, o.ref, o.root])).toEqual([
      ['teaching', 'https://github.com/cursor/plugins.git', 'main', 'teaching'],
      ['pstack', 'https://github.com/cursor/plugins.git', 'main', 'pstack'],
      ['ahrefs', 'https://github.com/cursor/plugins.git', 'main', 'third_party/ahrefs'],
    ]);
  });

  it('awesome-copilot: string sources and github sources with path/ref/sha', async () => {
    const r = await parseMarketplace(mp('awesome-copilot.json'), { url: 'https://github.com/github/awesome-copilot.git' });
    expect(r.origins.map((o) => [o.alias, o.url, o.ref, o.root])).toEqual([
      ['accessibility-kanban', 'https://github.com/github/awesome-copilot.git', undefined, 'plugins/accessibility-kanban'],
      ['acreadiness-cockpit', 'https://github.com/github/awesome-copilot.git', undefined, 'plugins/acreadiness-cockpit'],
      ['agent-council', 'https://github.com/Avyayalaya/agent-council.git', 'v0.1.3', undefined],
      ['ai-ready', 'https://github.com/johnpapa/ai-ready.git', 'v1.3.0', '.github/plugin'],
      ['anarlog', 'https://github.com/fastrepl/anarlog.git', '259b68866a7d6c331cd428aaa33a33300a700c5d', 'agent-plugins/anarlog'],
    ]);
  });

  it('anthropics/skills: several "./" subsets of one repo are imported once', async () => {
    const r = await parseMarketplace(mp('anthropics-skills.json'), { url: 'https://github.com/anthropics/skills.git' });
    expect(r.origins).toEqual([
      { alias: 'anthropic-agent-skills', type: 'git', url: 'https://github.com/anthropics/skills.git', description: 'marketplace anthropic-agent-skills' },
    ]);
    expect(r.warnings).toEqual([expect.stringMatching(/"document-skills", "example-skills".*share one source; imported once as origin "anthropic-agent-skills"/)]);
  });

  it('Codex marketplace ({source:"url", url:"./"}) resolves to the repo', async () => {
    const r = await parseMarketplace(mp('codex-superpowers.json'), { path: '/work/superpowers' });
    expect(r.origins).toEqual([{ alias: 'superpowers', type: 'local', path: '/work/superpowers' }]);
  });

  it('catalog with every source form; npm and unknown sources are warned about', async () => {
    const r = await parseMarketplace(mp('catalog.json'), { url: 'https://github.com/acme/catalog.git', ref: 'v1' });
    expect(r.origins.map((o) => ({ alias: o.alias, url: o.url, ref: o.ref, root: o.root }))).toEqual([
      { alias: 'local-skills', url: 'https://github.com/acme/catalog.git', ref: 'v1', root: undefined },
      { alias: 'superpowers', url: 'https://github.com/obra/superpowers.git', ref: undefined, root: undefined },
      { alias: 'caveman-skill', url: 'https://github.com/juliusbrussee/caveman.git', ref: undefined, root: 'skills/caveman' },
      { alias: 'pstack', url: 'https://github.com/cursor/plugins.git', ref: 'main', root: 'pstack' },
      { alias: 'pinned', url: 'https://github.com/mattpocock/skills.git', ref: '3f2a9c0ffee', root: undefined },
      { alias: 'plain-git', url: 'https://gitlab.com/acme/agent-kit.git', ref: 'v2.0.0', root: undefined },
    ]);
    expect(r.warnings).toEqual([
      expect.stringMatching(/"from-npm": npm source @acme\/claude-plugin is not supported/),
      expect.stringMatching(/"mystery": unrecognised source/),
    ]);
  });

  describe('errors', () => {
    const tmp: string[] = [];
    afterAll(async () => Promise.all(tmp.map((d) => rm(d, { recursive: true, force: true }))));

    it('rejects invalid JSON and non-marketplace JSON with E_PARSE', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'palm-mp-'));
      tmp.push(dir);
      await writeFile(join(dir, 'bad.json'), '{ nope');
      await writeFile(join(dir, 'other.json'), '{"name":"x"}');
      for (const f of ['bad.json', 'other.json']) {
        const err = await parseMarketplace(join(dir, f), {}).catch((e: unknown) => e);
        expect(isPalmError(err) && err.code).toBe('E_PARSE');
      }
      const missing = await parseMarketplace(join(dir, 'missing.json'), {}).catch((e: unknown) => e);
      expect(isPalmError(missing) && missing.code).toBe('E_IO');
    });
  });
});

describe('normalizeSource', () => {
  it.each([
    ['./', { type: 'local', path: '' }],
    ['pstack', { type: 'local', path: 'pstack' }],
    ['./plugins/x/', { type: 'local', path: 'plugins/x' }],
    ['github:obra/superpowers', { type: 'github', repo: 'obra/superpowers' }],
    ['https://github.com/a/b.git', { type: 'git', url: 'https://github.com/a/b.git' }],
    [{ source: 'local', path: './plugins/y' }, { type: 'local', path: 'plugins/y' }],
    [{ source: 'url', url: './' }, { type: 'local', path: '' }],
    [{ source: 'github', repo: 'o/r', path: './sub/', sha: 'abc' }, { type: 'github', repo: 'o/r', path: 'sub', sha: 'abc' }],
    [{ source: 'npm', package: 'p' }, { type: 'npm', package: 'p' }],
  ])('%j', (input, expected) => {
    expect(normalizeSource(input)).toEqual(expected);
  });
});

describe('findMarketplaceFile', () => {
  it.each([
    ['superpowers-like', '.claude-plugin/marketplace.json'],
    ['cursor-monorepo-like', '.cursor-plugin/marketplace.json'],
    ['awesome-copilot-like', '.github/plugin/marketplace.json'],
    ['openai-like', undefined],
  ])('%s → %s', async (fixture, rel) => {
    const found = await findMarketplaceFile(join(FIXTURES, fixture));
    expect(found).toBe(rel ? join(FIXTURES, fixture, rel) : undefined);
  });

  it('only finds Codex marketplaces when nothing else exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'palm-mp-'));
    try {
      const file = join(dir, '.agents/plugins/marketplace.json');
      await import('node:fs/promises').then((fs) => fs.mkdir(dirname(file), { recursive: true }));
      await writeFile(file, '{"plugins":[]}');
      expect(await findMarketplaceFile(dir)).toBe(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
