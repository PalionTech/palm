/** Domain rulings from the second persona rerun (FINDINGS-v3.md), one test per ruling id. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Manifest } from '../../src/domain/manifest.js';
import { localUrlPath, lockedUrl, urlOfLocked } from '../../src/domain/source-url.js';

const MEMBERS = [
  'brainstorming',
  'dispatching-parallel-agents',
  'executing-plans',
  'finishing-a-development-branch',
  'receiving-code-review',
];

describe('M7 block style for nested lists beyond three', () => {
  it('M7 a plugin exclude list of five is one member per line', () => {
    const m = Manifest.of({ sources: { sp: { url: 'https://example.com/sp.git' } } });
    m.addEntry('sp', 'plugin', 'superpowers');
    for (const name of MEMBERS) m.excludeMember('sp', 'superpowers', { kind: 'skill', name });
    const text = m.text();
    expect(text).toContain(
      '      - name: superpowers\n        exclude:\n          - skill:brainstorming\n',
    );
    for (const line of text.split('\n')) expect(line.length).toBeLessThan(80);
  });

  it('M7 a short nested list stays on one line', () => {
    const m = Manifest.of({ sources: { sp: { url: 'https://example.com/sp.git' } } });
    m.addEntry('sp', 'plugin', 'superpowers');
    m.excludeMember('sp', 'superpowers', { kind: 'skill', name: 'brainstorming' });
    expect(m.text()).toContain('      - {name: superpowers, exclude: [skill:brainstorming]}\n');
  });
});

describe('S4 local URLs in the lock', () => {
  const root = '/work/app';

  it('S4 a file:// URL or an absolute path is recorded relative to the root', () => {
    expect(lockedUrl('file:///work/remotes/kit.git', root)).toBe('file:../remotes/kit.git');
    expect(lockedUrl('/work/app/vendor/kit.git', root)).toBe('file:vendor/kit.git');
    expect(lockedUrl('https://example.com/kit.git', root)).toBe('https://example.com/kit.git');
  });

  it('S4 the relative record reads back as the file:// URL', () => {
    expect(urlOfLocked('file:../remotes/kit.git', root)).toBe('file:///work/remotes/kit.git');
    expect(urlOfLocked('https://example.com/kit.git', root)).toBe('https://example.com/kit.git');
    expect(localUrlPath('file:///work/remotes/kit.git')).toBe('/work/remotes/kit.git');
    expect(localUrlPath('ssh://host.example/o/r.git')).toBeUndefined();
  });
});

describe("O19 J13' the ignore: list", () => {
  it("O19 J13' ignore: keys read back; anything but a list of check keys is E_PARSE", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'palm-ignore-'));
    try {
      const file = join(dir, 'palm.yaml');
      await writeFile(file, 'targets: [claude]\nignore: [hidden-unicode:kit/skills/x/SKILL.md]\n');
      expect((await Manifest.load(file)).ignore).toEqual(['hidden-unicode:kit/skills/x/SKILL.md']);
      expect(Manifest.of({}).ignore).toEqual([]);
      await writeFile(file, 'targets: [claude]\nignore: hidden-unicode\n');
      await expect(Manifest.load(file)).rejects.toMatchObject({ code: 'E_PARSE' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
