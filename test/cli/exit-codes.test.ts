import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitSignal } from '../../src/commands/grammar.js';
import { EXIT, exitCodeFor } from '../../src/commands/main.js';
import { PalmError } from '../../src/core/errors.js';
import type { UI } from '../../src/core/types.js';
import { fakeUI } from '../support/fakes.js';
import { removeDir } from '../support/sandbox.js';
import { type CliSandbox, cliSandbox, runInProcess } from './helpers.js';

/** An interactive UI whose every prompt is cancelled (Esc / Ctrl-C). */
function cancellingUI(): UI {
  const cancel = async (): Promise<never> => {
    throw new PalmError('E_CANCELLED', 'cancelled');
  };
  return {
    ...fakeUI(),
    pick: cancel,
    pickMany: cancel,
    confirm: cancel,
    text: cancel,
    secret: cancel,
  };
}

describe('exit codes', () => {
  let sb: CliSandbox | undefined;
  afterEach(async () => {
    if (sb) await removeDir(sb.root);
    sb = undefined;
  });

  it('maps errors to codes', () => {
    expect(exitCodeFor(new PalmError('E_USAGE', 'x'))).toBe(EXIT.usage);
    expect(exitCodeFor(new PalmError('E_NOT_FOUND', 'x'))).toBe(EXIT.failure);
    expect(exitCodeFor(new PalmError('E_CANCELLED', 'cancelled'))).toBe(EXIT.cancelled);
    expect(exitCodeFor(new ExitSignal(1))).toBe(1);
    expect(exitCodeFor(new TypeError('boom'))).toBe(EXIT.internal);
    expect(EXIT).toEqual({ ok: 0, failure: 1, usage: 2, internal: 70, cancelled: 130 });
  });

  it('usage → 2 (palm grammar and commander)', async () => {
    const a = await runInProcess(['install', 'skill']);
    expect(a.code).toBe(2);
    expect(a.stderr).toContain('x name the skill to install');
    const b = await runInProcess(['get', '--bogus']);
    expect(b.code).toBe(2);
    expect(b.stderr).toContain("unknown option '--bogus'");
    const c = await runInProcess(['describe', 'target']);
    expect(c.code).toBe(2);
  });

  it('not found → 1 (dist)', async () => {
    sb = await cliSandbox();
    const r = await sb.palm('describe', 'skill', 'nope', '--offline');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('x no skill named "nope"');
    expect(r.stderr).toContain('palm search skill nope');
  });

  it('cancelled → 130, quietly, nothing written', async () => {
    sb = await cliSandbox();
    const r = await runInProcess(['init'], { ui: cancellingUI(), cwd: sb.project, env: sb.env });
    expect(r.code).toBe(130);
    expect(r.stderr).not.toContain('x ');
    expect(r.stdout).toBe('');
    expect(existsSync(join(sb.project, 'palm.yaml'))).toBe(false);
  });

  it('unexpected → 70, the stack only with --verbose', async () => {
    const boom = async () => {
      throw new TypeError('boom');
    };
    const quiet = await runInProcess(['get'], { dispatch: boom });
    expect(quiet.code).toBe(70);
    expect(quiet.stderr).toContain('x internal error: boom');
    expect(quiet.stderr).toContain('re-run with --verbose');
    expect(quiet.stderr).not.toContain('at ');
    const loud = await runInProcess(['get', '--verbose'], { dispatch: boom });
    expect(loud.code).toBe(70);
    expect(loud.stderr).toMatch(/TypeError: boom\n\s+at /);
  });

  it('a command that printed its own output ends with its ExitSignal code', async () => {
    const r = await runInProcess(['doctor'], {
      dispatch: async () => {
        throw new ExitSignal(1);
      },
    });
    expect(r).toMatchObject({ code: 1, stderr: '' });
  });

  it('help and version → 0', async () => {
    expect((await runInProcess(['--help'])).code).toBe(0);
    expect((await runInProcess(['install', '--help'])).code).toBe(0);
    expect((await runInProcess(['--version'], { version: '1.2.3' })).stdout).toBe('1.2.3\n');
  });

  it('--json: errors are a JSON document on stdout, with the exit code unchanged', async () => {
    const usage = await runInProcess(['install', 'skill', '--json']);
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stdout)).toMatchObject({
      error: { code: 'E_USAGE', message: 'name the skill to install' },
      warnings: [],
    });
    const commander = await runInProcess(['get', '--bogus', '--json']);
    expect(commander.code).toBe(2);
    expect(JSON.parse(commander.stdout)).toMatchObject({ error: { code: 'E_USAGE' } });
    const internal = await runInProcess(['get', '--json'], {
      dispatch: async () => {
        throw new Error('boom');
      },
    });
    expect(internal.code).toBe(70);
    expect(JSON.parse(internal.stdout)).toMatchObject({
      error: { code: 'E_INTERNAL', message: 'boom' },
    });
  });
});
