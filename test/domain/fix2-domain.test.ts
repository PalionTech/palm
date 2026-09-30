/** Domain rulings from the second persona rerun (FINDINGS-v3.md), one test per ruling id. */
import { describe, expect, it } from 'vitest';
import { Manifest } from '../../src/domain/manifest.js';

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
