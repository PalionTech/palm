import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { InstallOutcome, InstallResult } from '../../src/core/types.js';
import { displayLockPath, formatBytes, listJoin, truncate } from '../../src/ui/format.js';
import {
  createOutput,
  failureCount,
  formatTable,
  jsonEnvelope,
  type Output,
  outputOf,
  printInstallSummary,
} from '../../src/ui/output.js';
import { consentKey, createClackUI, createNonInteractiveUI } from '../../src/ui/prompts.js';
import { lockEntry, outcome } from './fakes.js';

function captured(opts: { json?: boolean; isTTY?: boolean } = {}): {
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
  return { out, stdout: () => so, stderr: () => se };
}

describe('output writer', () => {
  it('marks status lines, keeps data on stdout and errors with their hint on stderr', () => {
    const c = captured();
    c.out.mark('+', 'skill tdd');
    c.out.mark('↺', 'skill tdd');
    c.out.status('modified', 'skill tdd');
    c.out.status('unchanged', 'skill tdd');
    c.out.info('note');
    c.out.error('broken', 'palm check\nor palm install');
    expect(c.stdout()).toBe(
      '+ skill tdd\n↺ skill tdd\n! modified (kept)  skill tdd\n= unchanged  skill tdd\ni note\n',
    );
    expect(c.stderr()).toBe('x broken\n  palm check\n  or palm install\n');
  });

  it('collects warnings, deduplicated, and prints them once under a heading', () => {
    const c = captured();
    c.out.warn('a');
    c.out.warn('b');
    c.out.warn('a');
    expect(c.out.warnings()).toEqual(['a', 'b']);
    c.out.finish();
    c.out.finish();
    expect(c.stderr()).toBe('\nWarnings\n  ! a\n  ! b\n');
  });

  it('under --json writes one document with the warnings; data lines go to stderr', () => {
    const c = captured({ json: true });
    c.out.out('a data line');
    c.out.warn('careful');
    c.out.json([{ name: 'tdd' }]);
    c.out.finish();
    expect(JSON.parse(c.stdout())).toEqual({ items: [{ name: 'tdd' }], warnings: ['careful'] });
    expect(c.stderr()).toBe('a data line\n');
  });

  it('colours only on a terminal', () => {
    const plain = captured();
    plain.out.mark('+', 'x');
    expect(plain.stdout()).toBe('+ x\n');
    const tty = createOutput({ isTTY: true, stdout: { write: () => 0 } });
    expect(tty.colors.isColorSupported).toBe(true);
    const noColor = createOutput({ isTTY: true, noColor: true, stdout: { write: () => 0 } });
    expect(noColor.colors.isColorSupported).toBe(false);
  });

  it('pages as plain lines without a terminal', async () => {
    const c = captured();
    await c.out.page('line 1\nline 2\n');
    expect(c.stdout()).toBe('line 1\nline 2\n');
  });

  it('wraps a plain logger', () => {
    const seen: string[] = [];
    const log = {
      info: (m: string) => seen.push(`info ${m}`),
      warn: (m: string) => seen.push(`warn ${m}`),
      debug: (m: string) => seen.push(`debug ${m}`),
      success: (m: string) => seen.push(`success ${m}`),
    };
    const out = outputOf(log);
    out.out('data');
    out.warn('w');
    out.error('e');
    expect(seen).toEqual(['info data', 'warn w', 'debug x e']);
    expect(outputOf(out)).toBe(out);
  });
});

describe('formatting', () => {
  it('pads table columns by display width and rules the header', () => {
    expect(
      formatTable(
        [
          ['skill', 'tdd'],
          ['agent', 'reviewer'],
        ],
        ['kind', 'name'],
      ).split('\n'),
    ).toEqual(['kind   name', '─────  ────────', 'skill  tdd', 'agent  reviewer']);
    expect(
      formatTable([
        ['日本語', 'a'],
        ['abcdef', 'b'],
      ]),
    ).toBe('日本語  a\nabcdef  b');
    expect(formatTable([])).toBe('');
  });

  it('builds the JSON envelope', () => {
    expect(jsonEnvelope([1], ['w'])).toEqual({ items: [1], warnings: ['w'] });
    expect(jsonEnvelope({ ok: true, warnings: ['a'] }, ['a', 'b'])).toEqual({
      ok: true,
      warnings: ['a', 'b'],
    });
    expect(jsonEnvelope(undefined, [])).toEqual({ warnings: [] });
  });

  it('joins lists, truncates, shows sizes and global lock paths', () => {
    expect(listJoin(['a'])).toBe('a');
    expect(listJoin(['a', 'b', 'c'])).toBe('a, b and c');
    expect(truncate('a  long\ndescription', 8)).toBe('a long…');
    expect(formatBytes(612)).toBe('612 B');
    expect(formatBytes(21 * 1024)).toBe('21 KB');
    expect(displayLockPath('<claude>/skills/tdd/SKILL.md')).toBe('~/.claude/skills/tdd/SKILL.md');
    expect(displayLockPath('<opencode>/opencode.json')).toBe('~/.config/opencode/opencode.json');
    expect(displayLockPath('.claude/skills/tdd')).toBe('.claude/skills/tdd');
  });
});

describe('failureCount', () => {
  it('counts failures and failed, partial or modified outcomes', () => {
    const e = lockEntry({ kind: 'skill', name: 'x', source: 's' });
    const failure = { kind: 'skill' as const, name: 'x', source: 's', code: 'E_IO', message: 'm' };
    expect(failureCount({ outcomes: [outcome(e)], failures: [] })).toBe(0);
    expect(failureCount({ outcomes: [], failures: [failure] })).toBe(1);
    for (const status of ['failed', 'partial', 'modified'] as const)
      expect(failureCount({ outcomes: [outcome(e, status)], failures: [] })).toBe(1);
  });
});

describe('printInstallSummary', () => {
  const skill = (name: string, files = [`.claude/skills/${name}/SKILL.md`]) =>
    lockEntry({ kind: 'skill', name, source: 'obra/superpowers', files });
  const result = (outcomes: InstallOutcome[]): InstallResult => ({
    outcomes,
    failures: [],
    warnings: [],
  });

  it('adds the status word when statuses mix, and prints = unchanged per entry', () => {
    const c = captured();
    printInstallSummary(
      c.out,
      result([
        outcome(skill('a')),
        outcome(skill('bb'), 'unchanged'),
        outcome(skill('c'), 'restored'),
      ]),
      { scope: 'project', targets: ['claude'] },
    );
    expect(c.stdout()).toBe(
      [
        '+ installed  skill  a    .claude/skills/a/   1 file',
        '↺ restored   skill  c    .claude/skills/c/   1 file',
        '= unchanged  skill  bb   .claude/skills/bb/   1 file',
        '1 installed, 1 restored, 1 unchanged.',
        '',
      ].join('\n'),
    );
  });

  it('says what a dry run would do and writes no commit line', () => {
    const c = captured();
    printInstallSummary(c.out, result([outcome(skill('a'))]), {
      scope: 'project',
      targets: ['claude'],
      dryRun: true,
      first: true,
    });
    expect(c.stdout()).toBe(
      '+ would install  skill  a   .claude/skills/a/   1 file\ndry run: 1 would install; nothing written.\n',
    );
  });

  it('collapses more than five installs of one kind, and not other statuses', () => {
    const c = captured();
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => outcome(skill(n)));
    printInstallSummary(c.out, result(many), { scope: 'global', targets: ['claude'] });
    expect(c.stdout()).toBe(
      '+ skill  a   .claude/skills/a/   1 file\n  ... 5 more\n6 installed.\n',
    );
    const d = captured();
    const same = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => outcome(skill(n), 'unchanged'));
    printInstallSummary(d.out, result(same), { scope: 'project', targets: ['claude'] });
    expect(d.stdout().split('\n')).toHaveLength(8);
  });

  it('shows global lock paths as home paths, merged files and several places', () => {
    const c = captured();
    const hook = lockEntry({
      kind: 'hook',
      name: 'gh-cli',
      source: 'trailofbits/skills',
      files: [
        '.palm/assets/trailofbits__skills/gh-cli/hooks/a.sh',
        '.palm/assets/trailofbits__skills/gh-cli/hooks/b.sh',
      ],
      merged: [
        {
          file: '.claude/settings.json',
          at: '/hooks/SessionStart',
          id: 'palm:hook:gh-cli:0',
          key: 'k',
        },
        {
          file: '.cursor/hooks.json',
          at: '/hooks/sessionStart',
          id: 'palm:hook:gh-cli:1',
          key: 'k',
        },
      ],
    });
    const global = lockEntry({
      kind: 'agent',
      name: 'r',
      source: 's',
      files: ['<claude>/agents/r.md'],
    });
    printInstallSummary(c.out, result([outcome(hook), outcome(global)]), {
      scope: 'project',
      targets: [],
    });
    expect(c.stdout()).toBe(
      [
        '+ agent  r        ~/.claude/agents/r.md   1 file',
        '+ hook   gh-cli   .palm/assets/trailofbits__skills/gh-cli/, .claude/settings.json +1   2 files',
        '2 installed.',
        '',
      ].join('\n'),
    );
  });
});

describe('prompts', () => {
  it('reads the consent keys: y, n or Enter, v, d; Esc and Ctrl-C cancel', () => {
    expect(consentKey('y', false)).toBe('yes');
    expect(consentKey('Y', false)).toBe('yes');
    expect(consentKey('n', false)).toBe('no');
    expect(consentKey('\r', false)).toBe('no');
    expect(consentKey('v', false)).toBe('view');
    expect(consentKey('d', true)).toBe('diff');
    expect(consentKey('d', false)).toBeUndefined();
    expect(consentKey('x', true)).toBeUndefined();
    expect(consentKey('\u0003', false)).toBe('cancel');
    expect(consentKey('\u001b', false)).toBe('cancel');
  });

  it('consent prints the text, ignores other keys and reads one answer', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (d) => (shown += d.toString()));
    const ui = createClackUI({ input, output });
    const answer = ui.consent('Allow these 2 programs to run?  [y/N/v=view scripts]', {
      canDiff: false,
    });
    input.write('x');
    setTimeout(() => input.write('v'), 5);
    expect(await answer).toBe('view');
    expect(shown).toBe('Allow these 2 programs to run?  [y/N/v=view scripts] v\n');
    const enter = ui.consent('Allow?', { canDiff: true });
    input.write('\r');
    expect(await enter).toBe('no');
    const cancel = ui.consent('Allow?', { canDiff: true });
    input.write('\u0003');
    await expect(cancel).rejects.toMatchObject({ code: 'E_CANCELLED' });
  });

  it('without a terminal every prompt, consent included, is E_NON_INTERACTIVE', async () => {
    const ui = createNonInteractiveUI();
    expect(ui.isInteractive).toBe(false);
    for (const ask of [
      () => ui.pick('Which?', [{ value: 1, label: 'one' }]),
      () => ui.pickMany('Which?', [{ value: 1, label: 'one' }]),
      () => ui.confirm('Sure?'),
      () => ui.text('Name?'),
      () => ui.secret('Token?'),
      () => ui.consent('Allow?', { canDiff: false }),
    ])
      await expect(ask()).rejects.toMatchObject({
        code: 'E_NON_INTERACTIVE',
        hint: expect.any(String),
      });
    expect(() => ui.spinner('x').stop()).not.toThrow();
  });
});
