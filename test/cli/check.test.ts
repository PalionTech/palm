/** `palm check` (DESIGN.md §6 "Check"): every check it ran, then the problems, then the verdict. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckReport, CheckRun } from '../../src/core/types.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { fakeEngine, palm } from './fakes.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await removeDir(sb.root);
});

const ok = (id: string, label: string): CheckRun => ({ id, label, status: 'ok', problems: [] });

const CLEAN: CheckRun[] = [
  ok('manifest-lock', 'manifest and lock agree'),
  ok('lock-disk', 'every generated file matches the lock'),
  ok('local-sources', 'in-repo sources match the lock'),
  ok('exec-trusted', 'every program is trusted'),
  ok('hook-scripts', 'every hook script exists and is executable'),
  ok('secrets', 'no secret literal in a generated file'),
  ok('git-ignored', 'skipped (not a git repository)'),
  ok('sources-declared', 'every source is declared'),
  ok('links', 'no output path leaves the project'),
  ok('hidden-unicode', 'no hidden Unicode in generated files'),
  ok('double-load', 'no harness loads an entity twice'),
  ok('block-size', 'AGENTS.md and GEMINI.md blocks are within limits'),
];

function report(checks: CheckRun[]): CheckReport {
  return { scope: 'project', checks, ok: checks.every((c) => c.status !== 'fail') };
}

describe('palm check', () => {
  it('prints one line per check and "no problems" when nothing failed or warned', async () => {
    const deps = fakeEngine({ checkScope: async () => report(CLEAN) });
    const r = await palm(sb, ['check'], { deps });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(`${[...CLEAN.map((c) => `✓ ${c.label}`), 'no problems'].join('\n')}\n`);
  });

  it('prints every check, then one line per problem with its fix, and exits 1 on a failure', async () => {
    const checks = [
      ...CLEAN.slice(0, 1),
      {
        id: 'lock-disk',
        label: '2 files differ from the lock',
        status: 'fail' as const,
        problems: [
          {
            entity: { kind: 'skill' as const, name: 'tdd', source: 'mattpocock/skills' },
            file: '.claude/skills/tdd/SKILL.md',
            message: 'changed since palm wrote it',
            fix: 'palm install mattpocock/skills tdd --force',
          },
          { file: '.cursor/rules/db.mdc', message: 'missing', fix: 'palm install' },
        ],
      },
      {
        id: 'double-load',
        label: 'cursor would load 1 entity twice',
        status: 'warn' as const,
        problems: [{ message: 'instruction db in AGENTS.md and .cursor/rules/db.mdc' }],
      },
      ...CLEAN.slice(3),
    ];
    const deps = fakeEngine({ checkScope: async () => report(checks) });
    const r = await palm(sb, ['check'], { deps });
    expect(r.code).toBe(1);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines.slice(0, checks.length)).toEqual([
      '✓ manifest and lock agree',
      'x 2 files differ from the lock',
      '! cursor would load 1 entity twice',
      ...CLEAN.slice(3).map((c) => `✓ ${c.label}`),
    ]);
    expect(lines.slice(checks.length)).toEqual([
      '',
      'x skill tdd .claude/skills/tdd/SKILL.md: changed since palm wrote it; fix: palm install mattpocock/skills tdd --force',
      'x .cursor/rules/db.mdc: missing; fix: palm install',
      '! instruction db in AGENTS.md and .cursor/rules/db.mdc',
    ]);
    expect(r.stdout).not.toContain('no problems');
  });

  it('warnings alone exit 0 but are not "no problems"', async () => {
    const checks = [{ ...ok('block-size', 'AGENTS.md block is 30 KiB'), status: 'warn' as const }];
    const r = await palm(sb, ['check'], {
      deps: fakeEngine({ checkScope: async () => report(checks) }),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('! AGENTS.md block is 30 KiB\n');
  });

  it('checks the global scope with -g', async () => {
    const deps = fakeEngine({ checkScope: async () => report(CLEAN) });
    await palm(sb, ['check', '-g'], { deps });
    expect(deps.calls.checkScope?.[0]?.[0]).toEqual({ scope: 'global' });
  });
});
