/**
 * Marketplace files are a scan rule only (DESIGN §5 rule 3): read and normalized here, scanned as
 * plugins by rules/marketplace.ts (scan.test.ts), never expanded into sources.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isPalmError } from '../../src/core/errors.js';
import {
  describeEntrySource,
  findMarketplaceFile,
  installInput,
  normalizeEntrySource,
  readMarketplace,
} from '../../src/index/marketplace.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const mp = (name: string) => join(FIXTURES, 'marketplaces', name);

describe('readMarketplace (real marketplace files)', () => {
  it('APM cache skills.json: a single "./" entry is the repository itself', async () => {
    const m = await readMarketplace(mp('apm-cache-skills.json'));
    expect(m.warnings).toEqual([]);
    expect(m.rootDir).toBe(join(FIXTURES, 'marketplaces'));
    expect(m.entries.map((e) => [e.name, e.source, e.strict])).toEqual([
      ['mattpocock-skills', { type: 'local', path: '' }, true],
    ]);
  });

  it('claude-plugins-official: git-subdir, url+sha and relative entries', async () => {
    const m = await readMarketplace(mp('claude-plugins-official.json'));
    const byName = Object.fromEntries(m.entries.map((e) => [e.name, e.source]));
    expect(byName['42crunch-api-security-testing']).toEqual({
      type: 'git-subdir',
      url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      path: 'plugins/api-security-testing',
      ref: 'v1.5.5',
      sha: 'faf5305385de8afed9468904e8639be737aff39e',
    });
    expect(byName['agentforce-adlc']).toEqual({
      type: 'url',
      url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git',
      sha: '09bf1539d41f9ff355ba3eb5d05d4a75813423bb',
    });
    expect(byName['agent-sdk-dev']).toEqual({ type: 'local', path: 'plugins/agent-sdk-dev' });
  });

  it('cursor/plugins: bare relative sources are directories of the same repository', async () => {
    const m = await readMarketplace(mp('cursor-plugins.json'));
    expect(m.entries.map((e) => [e.name, describeEntrySource(e.source)])).toEqual([
      ['teaching', 'teaching'],
      ['pstack', 'pstack'],
      ['ahrefs', 'third_party/ahrefs'],
    ]);
  });

  it('Codex marketplace ({source:"url", url:"./"}) points at the repository', async () => {
    const m = await readMarketplace(mp('codex-superpowers.json'));
    expect(m.entries[0]?.source).toEqual({ type: 'local', path: '' });
  });

  it('catalog with every source form; strict and declared skills are kept', async () => {
    const m = await readMarketplace(mp('catalog.json'));
    expect(m.entries.map((e) => describeEntrySource(e.source))).toEqual([
      './',
      'github:obra/superpowers',
      'github:juliusbrussee/caveman/skills/caveman',
      'github:cursor/plugins/pstack#main',
      'github:mattpocock/skills@3f2a9c0ffee',
      'https://gitlab.com/acme/agent-kit.git#v2.0.0',
      'npm:@acme/claude-plugin',
      '{"source":"s3","bucket":"x"}',
    ]);
    expect(m.entries[1]?.components.skills).toEqual(['brainstorming', 'writing-plans']);
  });

  describe('errors', () => {
    const tmp: string[] = [];
    afterAll(async () => Promise.all(tmp.map((d) => rm(d, { recursive: true, force: true }))));

    it('rejects invalid JSON and non-marketplace JSON with E_PARSE, a missing file with E_IO', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'palm-mp-'));
      tmp.push(dir);
      await writeFile(join(dir, 'bad.json'), '{ nope');
      await writeFile(join(dir, 'other.json'), '{"name":"x"}');
      await writeFile(join(dir, 'odd.json'), '{"plugins":[42,{"source":"./"}]}');
      for (const f of ['bad.json', 'other.json']) {
        const err = await readMarketplace(join(dir, f)).catch((e: unknown) => e);
        expect(isPalmError(err) && err.code).toBe('E_PARSE');
      }
      const missing = await readMarketplace(join(dir, 'missing.json')).catch((e: unknown) => e);
      expect(isPalmError(missing) && missing.code).toBe('E_IO');
      const odd = await readMarketplace(join(dir, 'odd.json'));
      expect(odd.entries).toEqual([]);
      expect(odd.warnings).toEqual([
        'marketplace entry #1 is not an object; skipped',
        'marketplace entry #2 has no name; skipped',
      ]);
    });
  });
});

describe('normalizeEntrySource', () => {
  it.each([
    ['./', { type: 'local', path: '' }],
    ['pstack', { type: 'local', path: 'pstack' }],
    ['./plugins/x/', { type: 'local', path: 'plugins/x' }],
    ['github:obra/superpowers', { type: 'github', repo: 'obra/superpowers' }],
    ['https://github.com/a/b.git', { type: 'git', url: 'https://github.com/a/b.git' }],
    [
      { source: 'local', path: './plugins/y' },
      { type: 'local', path: 'plugins/y' },
    ],
    [
      { source: 'url', url: './' },
      { type: 'local', path: '' },
    ],
    [
      { source: 'github', repo: 'o/r', path: './sub/', sha: 'abc' },
      { type: 'github', repo: 'o/r', path: 'sub', sha: 'abc' },
    ],
    [
      { source: 'npm', package: 'p' },
      { type: 'npm', package: 'p' },
    ],
  ])('%j', (input, expected) => {
    expect(normalizeEntrySource(input)).toEqual(expected);
  });
});

describe('installInput (the palm install line for a remote entry)', () => {
  it.each([
    [{ type: 'github', repo: 'acme/far-away', ref: 'v1.0.0' }, { input: 'acme/far-away#v1.0.0' }],
    [{ type: 'github', repo: 'o/r', path: 'sub', sha: 'abc', ref: 'v1' }, { input: 'o/r/sub#abc' }],
    [{ type: 'url', url: 'https://github.com/o/r.git' }, { input: 'o/r' }],
    [{ type: 'git', url: 'git@github.com:o/r.git', ref: 'main' }, { input: 'o/r#main' }],
    [
      { type: 'git-subdir', url: 'https://github.com/o/r.git', path: 'plugins/p', ref: 'v2' },
      { input: 'o/r/plugins/p#v2' },
    ],
    [
      { type: 'git-subdir', url: 'https://gitlab.com/g/r.git', path: 'kit', ref: 'v2' },
      { input: 'https://gitlab.com/g/r.git#v2', root: 'kit' },
    ],
    [{ type: 'git', url: 'https://gitlab.com/g/r.git' }, { input: 'https://gitlab.com/g/r.git' }],
  ] as const)('%j', (source, expected) => {
    expect(installInput(source)).toEqual(expected);
  });

  it('is undefined for local, npm and unknown entries', () => {
    expect(installInput({ type: 'local', path: 'x' })).toBeUndefined();
    expect(installInput({ type: 'npm', package: 'p' })).toBeUndefined();
    expect(installInput({ type: 'unknown', raw: 1 })).toBeUndefined();
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
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '{"plugins":[]}');
      expect(await findMarketplaceFile(dir)).toBe(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
