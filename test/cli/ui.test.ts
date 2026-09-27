import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstallResult } from '../../src/core/types.js';
import { formatTable, printInstallSummary, printTable, stripAnsi, truncate } from '../../src/ui/output.js';
import { createNonInteractiveUI, matchesQuery } from '../../src/ui/prompts.js';

describe('createNonInteractiveUI', () => {
  const ui = createNonInteractiveUI();

  it('is not interactive', () => {
    expect(ui.isInteractive).toBe(false);
  });

  it.each([
    ['pick', () => ui.pick('Which one?', [{ value: 1, label: 'one' }])],
    ['pickMany', () => ui.pickMany('Which ones?', [{ value: 1, label: 'one' }])],
    ['confirm', () => ui.confirm('Sure?')],
    ['text', () => ui.text('Name?')],
    ['secret', () => ui.secret('Token?')],
  ])('%s throws E_NON_INTERACTIVE with a hint', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'E_NON_INTERACTIVE', hint: expect.any(String) });
  });

  it('has a no-op spinner', () => {
    const s = ui.spinner('working');
    expect(() => {
      s.message('still working');
      s.stop('done');
    }).not.toThrow();
  });
});

describe('matchesQuery', () => {
  it('matches every term against label and hint, case-insensitively', () => {
    const o = { value: 'x', label: 'wayfinder @mattpocock', hint: 'Plan large refactors' };
    expect(matchesQuery(o, 'WAY refactor')).toBe(true);
    expect(matchesQuery(o, 'way docker')).toBe(false);
    expect(matchesQuery(o, '')).toBe(true);
  });
});

describe('formatTable / printTable', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pads columns to the widest cell and trims trailing space', () => {
    const out = stripAnsi(
      formatTable(
        [
          ['skill', 'wayfinder', 'mattpocock'],
          ['agent', 'x', 'pstack'],
        ],
        ['kind', 'name', 'origin'],
      ),
    );
    expect(out.split('\n')).toEqual([
      'kind   name       origin',
      '─────  ─────────  ──────────',
      'skill  wayfinder  mattpocock',
      'agent  x          pstack',
    ]);
  });

  it('ignores ANSI colour codes when measuring', () => {
    const coloured = '\u001b[32mok\u001b[39m';
    const out = formatTable([
      [coloured, 'a'],
      ['longer', 'b'],
    ]);
    expect(stripAnsi(out).split('\n')).toEqual(['ok      a', 'longer  b']);
  });

  it('handles ragged rows and no header', () => {
    expect(stripAnsi(formatTable([['a', 'b', 'c'], ['dd']]))).toBe('a   b  c\ndd');
    expect(formatTable([])).toBe('');
  });

  it('printTable writes one block to stdout', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printTable([['1', '2']], ['a', 'b']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(stripAnsi(String(log.mock.calls[0]?.[0]))).toContain('1  2');
  });

  it('printTable prints nothing for no rows and no header', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    printTable([]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('truncate', () => {
  it('flattens whitespace and adds an ellipsis', () => {
    expect(truncate('a\n b', 10)).toBe('a b');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(truncate(undefined, 5)).toBe('');
  });
});

describe('printInstallSummary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prints a status table, notes and warnings', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      lines.push(stripAnsi(String(m ?? '')));
    });
    const result: InstallResult = {
      outcomes: [
        {
          status: 'installed',
          notes: ['export GITHUB_TOKEN before starting the harness'],
          entry: {
            kind: 'mcp',
            name: 'github',
            origin: 'registry',
            path: '.mcp.json',
            contentHash: 'sha256:1',
            installedAt: '2026-09-27T00:00:00Z',
            targets: ['claude', 'cursor'],
            files: [],
            merged: [{ file: '.mcp.json', pointer: '/mcpServers', value: {} }],
          },
        },
        {
          status: 'unchanged',
          notes: [],
          entry: {
            kind: 'skill',
            name: 'tdd',
            origin: 'mattpocock',
            path: 'skills/tdd',
            contentHash: 'sha256:2',
            installedAt: '2026-09-27T00:00:00Z',
            targets: ['claude'],
            files: ['.claude/skills/tdd/SKILL.md'],
            via: 'agent:reviewer',
          },
        },
      ],
      warnings: ['hooks run shell commands'],
    };
    printInstallSummary(result, { scope: 'project', targets: ['claude', 'cursor'] });
    const text = lines.join('\n');
    expect(text).toContain('project scope → claude, cursor');
    expect(text).toMatch(/status\s+kind\s+name\s+origin\s+targets\s+files/);
    expect(text).toMatch(/installed\s+mcp\s+github\s+registry\s+claude,cursor\s+0 \(\+1 merged\)/);
    expect(text).toMatch(/unchanged\s+skill\s+tdd \(agent:reviewer\)\s+mattpocock\s+claude\s+1/);
    expect(text).toContain('1 installed, 1 unchanged');
    expect(text).toContain('github: export GITHUB_TOKEN');
    expect(text).toContain('⚠ hooks run shell commands');
  });

  it('says so when there is nothing to install', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      lines.push(stripAnsi(String(m ?? '')));
    });
    printInstallSummary({ outcomes: [], warnings: [] }, { scope: 'global', targets: [] });
    expect(lines.join('\n')).toContain('Nothing to install');
  });
});
