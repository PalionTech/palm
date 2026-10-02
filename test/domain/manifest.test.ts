import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectManifestFormat, Manifest, memberSelected } from '../../src/domain/manifest.js';
import { cleanupTmp, read, tmpDir, write } from '../support/sandbox.js';

afterEach(cleanupTmp);

const DESIGN_EXAMPLE = `# the team's agent setup
targets: [claude, cursor]

sources:
  mattpocock/skills:                    # GitHub shorthand
    ref: v1.2.3                         # tag, branch, sha, or a range
    skills: [tdd, handoff]
  obra/superpowers:
    ref: ^4
    plugins:
      - name: superpowers
        exclude: [skill:brainstorming, hook:session-start]
  acme-kit:
    url: https://gitlab.acme.com/platform/agent-kit.git
    root: kit
    ref: ^1
    layout: { agents: [people/*.md] }   # consumer override
    agents: [reviewer]
    instructions:
      - { name: db-conventions, targets: [claude], at: packages/database }
  ./agent-kit:
    skills: [review]
    hooks: [quality]

mcp:
  docs:
    url: https://example.com/mcp
    headers: { Authorization: "Bearer \${DOCS_TOKEN}" }
x-team-note: kept as is
`;

async function manifestFile(text: string): Promise<string> {
  const file = join(await tmpDir(), 'palm.yaml');
  await write(file, text);
  return file;
}

describe('detectManifestFormat', () => {
  it.each<[unknown, 3 | 'legacy' | 'empty']>([
    [undefined, 'empty'],
    [null, 'empty'],
    [{}, 'empty'],
    [{ targets: ['claude'] }, 3],
    [{ sources: { 'a/b': { skills: ['tdd'] } } }, 3],
    [{ origins: [] }, 'legacy'],
    [{ skills: ['tdd@matt'] }, 'legacy'],
    [{ commands: [] }, 'legacy'],
    [{ mcp: [{ name: 'x' }] }, 'legacy'],
    [{ sources: { 'a/b': { skills: ['tdd@matt'] } } }, 'legacy'],
    [{ sources: { 'a/b': { agents: [{ name: 'r#v1' }] } } }, 'legacy'],
  ])('%j → %s', (raw, format) => {
    expect(detectManifestFormat(raw)).toBe(format);
  });
});

describe('Manifest.load', () => {
  it('reads the DESIGN example, normalising entries and keeping unknown keys', async () => {
    const m = await Manifest.load(await manifestFile(DESIGN_EXAMPLE));
    expect(m.targets).toEqual(['claude', 'cursor']);
    expect(m.sourceNames()).toEqual([
      'mattpocock/skills',
      'obra/superpowers',
      'acme-kit',
      './agent-kit',
    ]);
    expect(m.entries('mattpocock/skills', 'skill')).toEqual([{ name: 'tdd' }, { name: 'handoff' }]);
    expect(m.entries('acme-kit', 'instruction')).toEqual([
      { name: 'db-conventions', targets: ['claude'], at: 'packages/database' },
    ]);
    expect(m.mcp.docs).toEqual({
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
    });
    expect((m.toJSON() as Record<string, unknown>)['x-team-note']).toBe('kept as is');
    expect(m.allEntries()).toHaveLength(7);
    const sources = m.sources('/work', 'palm.yaml');
    expect(sources.byName('./agent-kit')?.source.path).toBe('/work/agent-kit');
  });

  it('is empty when the file is missing or blank', async () => {
    expect((await Manifest.load('/nonexistent/palm.yaml')).toJSON()).toEqual({});
    expect((await Manifest.load(await manifestFile('# nothing yet\n'))).toJSON()).toEqual({});
  });

  it('sends a 0.1 file to palm migrate with E_USAGE', async () => {
    for (const text of [
      'origins:\n  - mattpocock/skills\n',
      'skills:\n  - tdd@matt\n',
      'sources:\n  a/b:\n    skills: [tdd@a]\n',
    ]) {
      await expect(Manifest.load(await manifestFile(text))).rejects.toMatchObject({
        code: 'E_USAGE',
        message: 'palm.yaml is in the 0.1 format',
        hint: 'palm migrate',
      });
    }
  });

  it('names the key of malformed content with E_PARSE', async () => {
    const cases: Array<[string, RegExp]> = [
      ['targets: [claude, vim]\n', /targets names an unknown target "vim"/],
      ['sources: [a]\n', /sources must be a mapping/],
      ['sources:\n  a/b:\n    skills: tdd\n', /sources\."a\/b"\.skills must be a list/],
      ['sources:\n  a/b:\n    skills: [{ targets: [claude] }]\n', /skills\[0\] must be a name/],
      [
        'targets: [claude]\nsources:\n  a/b:\n    skills: [{ name: t, targets: [codex] }]\n',
        /not in targets/,
      ],
      [
        'sources:\n  a/b:\n    plugins: [{ name: p, exclude: [widget:x] }]\n',
        /exclude has "widget:x"/,
      ],
      ['mcp:\n  "../x": { url: https://x }\n', /is not a valid server name/],
      ['a: [\n', /invalid YAML/],
    ];
    for (const [text, message] of cases) {
      await expect(Manifest.load(await manifestFile(text)), text).rejects.toMatchObject({
        code: 'E_PARSE',
        message: expect.stringMatching(message),
      });
    }
  });
});

describe('Manifest.save', () => {
  it('round-trips: every comment, the key order and the data survive a save', async () => {
    const file = await manifestFile(DESIGN_EXAMPLE);
    const before = await Manifest.load(file);
    await before.save(file);
    const text = await read(file);
    const comments = (t: string) => [...t.matchAll(/#[^\n]*/g)].map((m) => m[0].trim());
    expect(comments(text)).toEqual(comments(DESIGN_EXAMPLE));
    const keys = (t: string) => [...t.matchAll(/^\s*([\w./-]+):/gm)].map((m) => m[1]);
    expect(keys(text)).toEqual(keys(DESIGN_EXAMPLE));
    expect(text).toContain('targets: [claude, cursor]\n');
    expect((await Manifest.load(file)).toJSON()).toEqual(before.toJSON());
    await (await Manifest.load(file)).save(file);
    expect(await read(file)).toBe(text);
  });

  it('patches edits in place: comments and key order survive, new entries go last', async () => {
    const file = await manifestFile(DESIGN_EXAMPLE);
    const m = await Manifest.load(file);
    m.addEntry('mattpocock/skills', 'skill', 'grill-me');
    m.addEntry('acme-kit', 'agent', { name: 'writer', targets: ['claude'] });
    m.removeEntry('./agent-kit', 'hook', 'quality');
    m.setMcp('xcodebuild', { command: 'npx', args: ['-y', 'xcodebuildmcp@latest'] });
    await m.save(file);
    const text = await read(file);
    expect(text).toContain("# the team's agent setup\ntargets: [claude, cursor]\n");
    expect(text).toContain(
      '    ref: v1.2.3 # tag, branch, sha, or a range\n    skills: [tdd, handoff, grill-me]\n',
    );
    expect(text).toContain('    agents: [reviewer, {name: writer, targets: [claude]}]\n');
    expect(text).toContain('  ./agent-kit:\n    skills: [review]\n\nmcp:');
    expect(text).toContain(
      '  xcodebuild:\n    command: npx\n    args: [-y, xcodebuildmcp@latest]\n',
    );
    expect(text.indexOf('mattpocock/skills')).toBeLessThan(text.indexOf('obra/superpowers'));
    expect((await Manifest.load(file)).toJSON()).toEqual(m.toJSON());
  });

  it('drops emptied sections and sources left without entries', async () => {
    const file = await manifestFile(
      'targets: [claude]\nsources:\n  a/b:\n    ref: v1\n    skills: [tdd]\n',
    );
    const m = await Manifest.load(file);
    m.removeEntry('a/b', 'skill', 'TDD');
    expect(m.hasSource('a/b')).toBe(false);
    await m.save(file);
    expect(await read(file)).toBe('targets: [claude]\n');
  });

  it('writes a fresh file with flow targets, flow name lists and flow entry objects', async () => {
    const file = join(await tmpDir(), 'palm.yaml');
    const m = Manifest.of()
      .setTargets(['claude'])
      .addSource({ name: 'acme', type: 'git', url: 'https://h/acme.git', ref: '^1' }, '/w')
      .addEntry('acme', 'skill', 'tdd')
      .addEntry('acme', 'plugin', { name: 'kit', exclude: ['skill:x'] });
    await m.save(file);
    expect(await read(file)).toBe(
      'targets: [claude]\nsources:\n  acme:\n    url: https://h/acme.git\n    ref: ^1\n    skills: [tdd]\n    plugins:\n      - {name: kit, exclude: [skill:x]}\n',
    );
  });
});

describe('Manifest mutators', () => {
  it('addSource updates the location and keeps the entries; addEntry replaces by name', () => {
    const m = Manifest.of({
      sources: {
        acme: { url: 'https://h/old.git', skills: ['a', { name: 'b', targets: ['claude'] }] },
      },
    });
    m.addSource({ name: 'acme', type: 'git', url: 'https://h/new.git', ref: 'main' }, '/w');
    expect(m.toJSON().sources?.acme).toEqual({
      url: 'https://h/new.git',
      ref: 'main',
      skills: ['a', { name: 'b', targets: ['claude'] }],
    });
    m.addEntry('acme', 'skill', { name: 'B' });
    expect(m.entries('acme', 'skill')).toEqual([{ name: 'a' }, { name: 'B' }]);
    expect(m.toJSON().sources?.acme?.skills).toEqual(['a', 'B']);
    expect(m.hasEntry('ACME', 'skill', 'b')).toBe(true);
    expect(m.hasEntry('acme', 'agent', 'b')).toBe(false);
  });

  it('excludeMember adds kind:name once to the plugin entry', () => {
    const m = Manifest.of({ sources: { 'obra/superpowers': { plugins: ['superpowers'] } } });
    m.excludeMember('obra/superpowers', 'superpowers', { kind: 'skill', name: 'brainstorming' });
    m.excludeMember('obra/superpowers', 'superpowers', { kind: 'skill', name: 'brainstorming' });
    expect(m.entries('obra/superpowers', 'plugin')).toEqual([
      { name: 'superpowers', exclude: ['skill:brainstorming'] },
    ]);
  });

  it('manages hand-declared MCP servers and never changes the input data', () => {
    const data = { targets: ['claude' as const], mcp: { docs: { url: 'https://x' } } };
    const m = Manifest.of(data).removeMcp('docs').setMcp('fs', { command: 'npx', env: undefined });
    expect(m.mcp).toEqual({ fs: { command: 'npx' } });
    expect(data.mcp.docs).toEqual({ url: 'https://x' });
  });
});

describe('memberSelected', () => {
  it('applies only and exclude over kind:name, names in any case', () => {
    const e = { name: 'kit', only: ['skill:tdd', 'hook:fmt'], exclude: ['hook:FMT'] };
    expect(memberSelected(e, { kind: 'skill', name: 'TDD' })).toBe(true);
    expect(memberSelected(e, { kind: 'hook', name: 'fmt' })).toBe(false);
    expect(memberSelected(e, { kind: 'agent', name: 'tdd' })).toBe(false);
    expect(
      memberSelected({ name: 'kit', exclude: ['review'] }, { kind: 'agent', name: 'review' }),
    ).toBe(false);
    expect(memberSelected({ name: 'kit' }, { kind: 'agent', name: 'x' })).toBe(true);
  });
});
