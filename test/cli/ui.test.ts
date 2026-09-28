import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstallResult } from '../../src/core/types.js';
import {
  createOutput,
  failureCount,
  formatTable,
  jsonEnvelope,
  type Output,
  outputOf,
  printInstallSummary,
  stripAnsi,
  truncate,
} from '../../src/ui/output.js';

/** A writer over two string buffers. */
function captured(opts: { json?: boolean; verbose?: boolean } = {}): {
  out: Output;
  stdout: () => string;
  stderr: () => string;
} {
  let so = '';
  let se = '';
  const out = createOutput({
    ...opts,
    stdout: { write: (s: string) => (so += s) },
    stderr: { write: (s: string) => (se += s) },
  });
  return { out, stdout: () => stripAnsi(so), stderr: () => stripAnsi(se) };
}

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
    await expect(call()).rejects.toMatchObject({
      code: 'E_NON_INTERACTIVE',
      hint: expect.any(String),
    });
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
});

describe('output writer', () => {
  it('writes data and status lines with symbols to stdout, errors to stderr', () => {
    const c = captured();
    c.out.table([['1', '2']], ['a', 'b']);
    c.out.added('origin x');
    c.out.removed('skill y');
    c.out.updated('agent z');
    c.out.unchanged('mcp w');
    c.out.info('note');
    c.out.error('broken', 'palm doctor');
    expect(c.stdout()).toBe(
      [
        'a  b',
        '─  ─',
        '1  2',
        '+ origin x',
        '- skill y',
        '~ agent z',
        '= mcp w',
        'i note',
        '',
      ].join('\n'),
    );
    expect(c.stderr()).toBe('x broken\n  palm doctor\n');
  });

  it('collects warnings (deduplicated) and prints them once, at the end, under a heading', () => {
    const c = captured();
    c.out.warn('first');
    c.out.out('data');
    c.out.warn('second');
    c.out.warn('first');
    expect(c.stderr()).toBe('');
    c.out.finish();
    expect(c.stdout()).toBe('data\n');
    expect(c.stderr()).toBe('\nWarnings\n  ! first\n  ! second\n');
    c.out.finish(); // reset: nothing twice
    expect(c.stderr()).toBe('\nWarnings\n  ! first\n  ! second\n');
  });

  it('--json: stdout holds only the JSON document, with the warnings; every line goes to stderr', () => {
    const c = captured({ json: true });
    c.out.out('a table line');
    c.out.added('origin x');
    c.out.warn('careful');
    c.out.json([{ name: 'tdd' }]);
    expect(c.stdout()).toBe('');
    c.out.finish();
    expect(JSON.parse(c.stdout())).toEqual({ items: [{ name: 'tdd' }], warnings: ['careful'] });
    expect(c.stderr()).toContain('a table line');
    expect(c.stderr()).toContain('+ origin x');
  });

  it('jsonEnvelope merges own and collected warnings; arrays become items', () => {
    expect(jsonEnvelope({ outcomes: [], warnings: ['a'] }, ['a', 'b'])).toEqual({
      outcomes: [],
      warnings: ['a', 'b'],
    });
    expect(jsonEnvelope([1], [])).toEqual({ items: [1], warnings: [] });
    expect(jsonEnvelope(undefined, ['w'])).toEqual({ warnings: ['w'] });
  });

  it('debug lines only with --verbose', () => {
    const quiet = captured();
    quiet.out.debug('hidden');
    expect(quiet.stderr()).toBe('');
    const loud = captured({ verbose: true });
    loud.out.debug('shown');
    expect(loud.stderr()).toContain('shown');
  });

  it('outputOf adapts a plain logger', () => {
    const seen: string[] = [];
    const push = (l: string) => (m: string) => void seen.push(`${l}:${m}`);
    const out = outputOf({
      info: push('info'),
      warn: push('warn'),
      debug: push('debug'),
      success: push('ok'),
    });
    out.added('x');
    out.warn('w');
    expect(seen).toEqual(['info:+ x', 'warn:w']);
  });

  it('failureCount reads a failures array or failed outcomes', () => {
    expect(failureCount({ outcomes: [] })).toBe(0);
    expect(failureCount({ outcomes: [{ status: 'installed' }, { status: 'failed' }] })).toBe(1);
    expect(failureCount({ outcomes: [], failures: [{}, {}] })).toBe(2);
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
    const c = captured();
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
            transform: 1,
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
            transform: 1,
            targets: ['claude'],
            files: [{ path: '.claude/skills/tdd/SKILL.md', hash: '' }],
            via: 'agent:reviewer',
          },
        },
      ],
      warnings: ['hooks run shell commands'],
      failures: [],
    };
    printInstallSummary(c.out, result, { scope: 'project', targets: ['claude', 'cursor'] });
    c.out.finish();
    const text = c.stdout() + c.stderr();
    expect(text).toContain('project scope → claude, cursor');
    expect(text).toMatch(/status\s+kind\s+name\s+origin\s+targets\s+files/);
    expect(text).toMatch(
      /\+ installed\s+mcp\s+github\s+registry\s+claude,cursor\s+0 \(\+1 merged\)/,
    );
    expect(text).toMatch(/= unchanged\s+skill\s+tdd \(agent:reviewer\)\s+mattpocock\s+claude\s+1/);
    expect(text).toContain('1 installed, 1 unchanged');
    expect(text).toContain('github: export GITHUB_TOKEN');
    expect(text).toContain('Warnings\n  ! hooks run shell commands');
  });

  it('says so when there is nothing to install', () => {
    const c = captured();
    printInstallSummary(
      c.out,
      { outcomes: [], warnings: [], failures: [] },
      { scope: 'global', targets: [] },
    );
    expect(c.stdout()).toContain('Nothing to install');
  });
});
