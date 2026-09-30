/**
 * palm.yaml rulings from the 0.2 persona rerun (FINDINGS-v2.md): a source with a body survives a
 * save without entries (K1), unknown keys are E_PARSE with a did-you-mean (B4, D14), long entry
 * lists are written one per line (B14), `targets:` comes first (K24) and `secrets: literal` is a
 * known entry key (Y19).
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Manifest } from '../../src/domain/manifest.js';
import { cleanupTmp, read, tmpDir, write } from '../support/sandbox.js';

afterEach(cleanupTmp);

async function manifestFile(text: string): Promise<string> {
  const file = join(await tmpDir(), 'palm.yaml');
  await write(file, text);
  return file;
}

describe('K1 a source with a body survives a save without entries', () => {
  it('K1 keeps a hand-written source (url, layout, comment) that lists no entry yet', async () => {
    const text =
      'targets: [claude, codex]\nsources:\n  # the chaos kit, layout by hand\n  chaos:\n    url: https://example.com/chaos.git\n    ref: ^1.3\n    layout: {agents: [people/*.md]}\n';
    const file = await manifestFile(text);
    const m = await Manifest.load(file);
    m.setTargets(['claude', 'codex']);
    await m.save(file);
    expect(await read(file)).toBe(text);
  });

  it('K1 drops a source with neither entries nor a body, and removeEntry still drops the source it empties', async () => {
    const file = await manifestFile(
      'targets: [claude]\nsources:\n  a/b:\n  c/d:\n    ref: v1\n    skills: [tdd]\n',
    );
    const m = await Manifest.load(file);
    m.removeEntry('c/d', 'skill', 'tdd');
    await m.save(file);
    expect(await read(file)).toBe('targets: [claude]\n');
  });
});

describe('B4 D14 unknown keys are E_PARSE with a did-you-mean', () => {
  it.each([
    [
      'B4 target on an entry',
      'targets: [claude, codex]\nsources:\n  a/b:\n    skills: [{ name: tdd, target: [codex] }]\n',
      /sources\."a\/b"\.skills\[0\] has an unknown key "target" \(did you mean targets\?\)/,
    ],
    [
      'B4 a misspelled source key',
      'sources:\n  a/b:\n    reff: v1\n    skills: [tdd]\n',
      /sources\."a\/b" has an unknown key "reff" \(did you mean ref\?\)/,
    ],
    [
      'D14 registry on an mcp entry',
      'mcp:\n  github:\n    url: https://api.example.com/mcp\n    registry: true\n',
      /mcp\."github" has an unknown key "registry"/,
    ],
    [
      'D14 version on an mcp entry',
      'mcp:\n  github:\n    command: npx\n    version: 1.12.2\n',
      /mcp\."github" has an unknown key "version"/,
    ],
  ])('%s', async (_what, text, message) => {
    await expect(Manifest.load(await manifestFile(text))).rejects.toMatchObject({
      code: 'E_PARSE',
      message: expect.stringMatching(message),
    });
  });

  it('B4 names the fix in the hint', async () => {
    const file = await manifestFile('sources:\n  a/b:\n    skills: [{ name: tdd, target: [x] }]\n');
    await expect(Manifest.load(file)).rejects.toMatchObject({
      hint: `rename it to targets in ${file}`,
    });
  });

  it('B4 keeps unknown top-level keys (the file is the team’s)', async () => {
    const m = await Manifest.load(await manifestFile('targets: [claude]\nx-team-note: kept\n'));
    expect(m.toJSON()).toMatchObject({ 'x-team-note': 'kept' });
  });
});

describe('B14 K24 palm.yaml layout', () => {
  it('B14 writes an entry list beyond three entries one entry per line', async () => {
    const file = join(await tmpDir(), 'palm.yaml');
    const m = Manifest.of().setTargets(['claude']);
    m.addSource({ name: 'a/b', type: 'git', url: 'https://github.com/a/b.git', ref: '^1' }, '/w');
    for (const n of ['one', 'two', 'three', 'four']) m.addEntry('a/b', 'skill', n);
    m.addEntry('a/b', 'agent', 'reviewer');
    await m.save(file);
    expect(await read(file)).toBe(
      'targets: [claude]\nsources:\n  a/b:\n    ref: ^1\n    skills:\n      - one\n      - two\n      - three\n      - four\n    agents: [reviewer]\n',
    );
  });

  it('B14 turns a flow list that grows beyond three entries into block style', async () => {
    const file = await manifestFile(
      'targets: [claude]\nsources:\n  a/b:\n    skills: [one, two, three] # mine\n',
    );
    const m = await Manifest.load(file);
    m.addEntry('a/b', 'skill', 'four');
    await m.save(file);
    const text = await read(file);
    expect(text).toContain('      - four\n');
    expect(text).not.toContain('[one, two');
  });

  it('K24 puts targets first in a palm.yaml created by an install', async () => {
    const file = join(await tmpDir(), 'palm.yaml');
    const m = Manifest.of();
    m.addSource({ name: 'a/b', type: 'git', url: 'https://github.com/a/b.git', ref: '^1' }, '/w');
    m.addEntry('a/b', 'skill', 'tdd');
    m.setTargets(['claude']);
    await m.save(file);
    expect(await read(file)).toBe(
      'targets: [claude]\nsources:\n  a/b:\n    ref: ^1\n    skills: [tdd]\n',
    );
    const again = await Manifest.load(file);
    again.addEntry('a/b', 'skill', 'x');
    await again.save(file);
    expect((await read(file)).startsWith('targets: [claude]\n')).toBe(true);
  });

  it('K24 inserts targets before sources in an existing file that has none', async () => {
    const file = await manifestFile('sources:\n  a/b:\n    skills: [tdd]\n');
    const m = await Manifest.load(file);
    await m.setTargets(['codex']).save(file);
    expect(await read(file)).toBe('targets: [codex]\nsources:\n  a/b:\n    skills: [tdd]\n');
  });
});

describe('Y19 secrets: literal on an entry', () => {
  it('Y19 accepts secrets: literal on a source entry and an mcp entry', async () => {
    const m = await Manifest.load(
      await manifestFile(
        'sources:\n  a/b:\n    mcp: [{ name: docs, secrets: literal }]\nmcp:\n  x:\n    url: https://x.example.com\n    secrets: literal\n',
      ),
    );
    expect(m.entries('a/b', 'mcp')).toEqual([{ name: 'docs', secrets: 'literal' }]);
    expect(m.mcp.x).toMatchObject({ secrets: 'literal' });
  });

  it('Y19 refuses another value', async () => {
    await expect(
      Manifest.load(
        await manifestFile('mcp:\n  x:\n    url: https://x.example.com\n    secrets: env\n'),
      ),
    ).rejects.toMatchObject({ code: 'E_PARSE', message: expect.stringMatching(/must be literal/) });
  });
});
