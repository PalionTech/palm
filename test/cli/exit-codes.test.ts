import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExitSignal } from '../../src/commands/grammar.js';
import { BUG_HINT, EXIT, exitCodeFor, runCli } from '../../src/commands/main.js';
import { PalmError } from '../../src/core/errors.js';
import type { InstallResult } from '../../src/core/types.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { fakeEngine, fakeScope, fakeUI, lockEntry, outcome, palm } from './fakes.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await removeDir(sb.root);
});

const tdd = lockEntry({
  kind: 'skill',
  name: 'tdd',
  source: 'mattpocock/skills',
  files: ['.claude/skills/tdd/SKILL.md'],
});

function installing(result: InstallResult) {
  const scope = fakeScope({ root: sb.project, manifestTargets: ['claude'], entries: [tdd] });
  return fakeEngine({ scopes: [scope], installFromSource: async () => result });
}

describe('exitCodeFor (DESIGN.md §6 "Exit codes")', () => {
  it('maps every outcome to 0, 1, 2 or 130', () => {
    expect(EXIT).toEqual({ ok: 0, failure: 1, usage: 2, cancelled: 130 });
    expect(exitCodeFor(new PalmError('E_USAGE', 'x'))).toBe(2);
    expect(exitCodeFor(new PalmError('E_CANCELLED', 'cancelled'))).toBe(130);
    for (const code of ['E_NOT_FOUND', 'E_SOURCE', 'E_UNTRUSTED_EXEC', 'E_INTERNAL'] as const)
      expect(exitCodeFor(new PalmError(code as 'E_NOT_FOUND', 'x'))).toBe(1);
    expect(exitCodeFor(new ExitSignal(1))).toBe(1);
    expect(exitCodeFor(new ExitSignal(130))).toBe(130);
    expect(exitCodeFor(new TypeError('boom'))).toBe(1);
  });
});

describe('exit codes through runCli', () => {
  it('E_USAGE from palm and from commander exits 2 with the fix', async () => {
    const r = await palm(sb, ['get', '--bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("x unknown option '--bogus'\n  see: palm get --help\n");
    const u = await palm(sb, ['frobnicate']);
    expect(u.code).toBe(2);
    expect(u.stderr).toContain("x unknown command 'frobnicate'");
    expect(u.stderr).toContain('see: palm --help');
  });

  it('a hidden palm 0.1 command names its replacement and exits 2', async () => {
    const r = await palm(sb, ['doctor']);
    expect(r).toEqual({ code: 2, stdout: '', stderr: 'x palm doctor is now: palm check\n' });
  });

  it('E_CANCELLED exits 130 and prints nothing more', async () => {
    const deps = fakeEngine({
      scopes: [fakeScope({ root: sb.project })],
      installFromSource: async () => {
        throw new PalmError('E_CANCELLED', 'cancelled');
      },
    });
    const r = await palm(sb, ['install', 'mattpocock/skills', 'tdd'], { deps });
    expect(r).toEqual({ code: 130, stdout: '', stderr: '' });
  });

  it('a failed outcome exits 1 and prints the failure once, on stderr', async () => {
    const failed = outcome(tdd, 'failed');
    const failure = {
      kind: 'skill' as const,
      name: 'tdd',
      source: 'mattpocock/skills',
      target: 'cursor' as const,
      code: 'E_CONFLICT',
      message: '.cursor/rules/tdd.mdc exists and palm did not write it',
      hint: 'palm install mattpocock/skills tdd --force',
    };
    const deps = installing({ outcomes: [failed], failures: [failure], warnings: [] });
    const r = await palm(sb, ['install', 'mattpocock/skills', 'tdd'], { deps });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('x skill  tdd\n1 failed.\n');
    expect(r.stderr).toBe(
      [
        'x skill tdd from mattpocock/skills → cursor: .cursor/rules/tdd.mdc exists and palm did not write it',
        '  palm install mattpocock/skills tdd --force',
        '',
      ].join('\n'),
    );
  });

  it('a partial outcome exits 1', async () => {
    const partial = {
      ...outcome(tdd, 'partial'),
      perTarget: { claude: 'installed', cursor: 'failed' },
    } as const;
    const deps = installing({ outcomes: [partial], failures: [], warnings: [] });
    const r = await palm(sb, ['install', 'mattpocock/skills', 'tdd'], { deps });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('! skill  tdd   .claude/skills/tdd/   1 file');
    expect(r.stdout).toContain('(claude: installed; cursor: failed)');
  });

  it('a kept modified file exits 1', async () => {
    const deps = installing({ outcomes: [outcome(tdd, 'modified')], failures: [], warnings: [] });
    const r = await palm(sb, ['install', 'mattpocock/skills', 'tdd'], { deps });
    expect(r.code).toBe(1);
  });

  it('an error palm did not expect exits 1 with the palm bug line', async () => {
    const boom = async () => {
      throw new TypeError('boom');
    };
    const r = await palm(sb, ['get'], { dispatch: boom });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`x boom\n  ${BUG_HINT}\n`);
    const j = await palm(sb, ['get', '--json'], { dispatch: boom });
    expect(j.code).toBe(1);
    expect(JSON.parse(j.stdout)).toEqual({
      error: { code: 'E_INTERNAL', message: 'boom', hint: BUG_HINT },
      warnings: [],
    });
  });

  it('E_NOT_FOUND exits 1 with its hint', async () => {
    const deps = fakeEngine({
      listInstalled: async () => {
        throw new PalmError('E_NOT_FOUND', 'nothing named tdd is installed', 'palm get');
      },
    });
    const r = await palm(sb, ['describe', 'tdd'], { deps });
    expect(r).toEqual({
      code: 1,
      stdout: '',
      stderr: 'x nothing named tdd is installed\n  palm get\n',
    });
  });

  it('an error fixed by a flag repeats the command line with it', async () => {
    const plan = {
      scope: 'project' as const,
      sources: [{ name: 'mattpocock/skills', ref: '^1', from: 'v1.2.0', to: 'v1.2.3' }],
      items: [
        {
          mark: 'updated' as const,
          kind: 'skill' as const,
          name: 'tdd',
          source: 'mattpocock/skills',
          atRisk: [],
        },
      ],
      failures: [],
      warnings: [],
    };
    const deps = fakeEngine({ planUpdate: async () => plan, planChanges: () => 1 });
    const r = await palm(sb, ['update', 'mattpocock/skills'], { deps });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      'x palm update would apply 1 change and there is no terminal to ask',
    );
    expect(r.stderr).toContain(
      '  review it with --dry-run, then apply it: palm update mattpocock/skills --yes',
    );
  });

  it('a declined update changes nothing and exits 0', async () => {
    const plan = {
      scope: 'project' as const,
      sources: [],
      items: [
        {
          mark: 'updated' as const,
          kind: 'skill' as const,
          name: 'tdd',
          source: 'm/s',
          atRisk: [],
        },
      ],
      failures: [],
      warnings: [],
    };
    const deps = fakeEngine({ planUpdate: async () => plan, planChanges: () => 1 });
    const ui = fakeUI({ interactive: true, confirm: false });
    const r = await palm(sb, ['update'], { deps, ui });
    expect(r.code).toBe(0);
    expect(ui.asked).toEqual(['Apply 1 change?']);
    expect(r.stdout).toContain('Nothing changed.');
    expect(deps.calls.applyUpdate).toBeUndefined();
  });

  it('--local is palm 0.3', async () => {
    const r = await palm(sb, ['install', 'mattpocock/skills', 'tdd', '--local']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('x palm.local.yaml arrives in palm 0.3');
    expect(r.stderr).toContain('run it without --local: palm install mattpocock/skills tdd');
  });

  it('the first Ctrl-C during an install stops after the current entity and exits 130', async () => {
    const stops: string[] = [];
    const exits: number[] = [];
    const deps = fakeEngine({
      scopes: [fakeScope({ root: sb.project, manifestTargets: ['claude'], entries: [tdd] })],
      requestInstallStop: () => void stops.push('stop'),
      installFromSource: async () => {
        process.emit('SIGINT');
        await new Promise((r) => setTimeout(r, 5));
        return { outcomes: [outcome(tdd)], failures: [], warnings: [] };
      },
    });
    const r = await palm(sb, ['install', 'mattpocock/skills', 'tdd'], {
      deps,
      exit: (c) => void exits.push(c),
    });
    expect(stops).toEqual(['stop']);
    expect(exits).toEqual([]);
    expect(r.code).toBe(130);
    expect(r.stdout).toContain('stopping after the current entity; press Ctrl-C again to quit now');
    expect(r.stdout).toContain('+ skill  tdd');
    expect(process.listenerCount('SIGINT')).toBe(0);
  });

  it('Ctrl-C outside an install ends palm at once', async () => {
    const exits: number[] = [];
    const dispatch = async () => {
      process.emit('SIGINT');
    };
    await palm(sb, ['get'], { dispatch, exit: (c) => void exits.push(c) });
    expect(exits).toEqual([130]);
  });

  it('bare palm prints help and exits 0', async () => {
    let out = '';
    const code = await runCli([], { stdout: { write: (s: string) => (out += s) }, env: {} });
    expect(code).toBe(0);
    expect(out).toContain('Verbs:');
  });
});
