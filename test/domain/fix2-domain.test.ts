/** Domain rulings from the second persona rerun (FINDINGS-v3.md), one test per ruling id. */
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
