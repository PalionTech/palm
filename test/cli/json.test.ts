import { afterEach, describe, expect, it } from 'vitest';
import { failureCount } from '../../src/ui/output.js';
import { fakeTargets } from '../support/fakes.js';
import { removeDir } from '../support/sandbox.js';
import { type CliSandbox, cliSandbox, runInProcess, writeOrigins } from './helpers.js';

/** stdout must be exactly one JSON document (and nothing else). */
function onlyJson(stdout: string): Record<string, unknown> {
  expect(stdout.startsWith('{')).toBe(true);
  expect(stdout.trimEnd().endsWith('}')).toBe(true);
  const doc = JSON.parse(stdout) as Record<string, unknown>;
  expect(Array.isArray(doc.warnings)).toBe(true);
  return doc;
}

describe('--json: stdout carries one JSON document, everything else goes to stderr', () => {
  let sb: CliSandbox | undefined;
  afterEach(async () => {
    if (sb) await removeDir(sb.root);
    sb = undefined;
  });

  it('get, get origins, get targets, get all, describe (dist)', async () => {
    sb = await cliSandbox();
    await writeOrigins(sb, [{ alias: 'matt', fixture: 'mattpocock-like' }]);
    for (const argv of [
      ['get', 'skills'],
      ['get', 'skills', '--available'],
      ['get', 'origins'],
      ['get', 'targets'],
      ['get', 'all'],
      ['describe', 'skill', 'tdd'],
      ['describe', 'origin', 'matt'],
      ['describe', 'target', 'claude'],
      ['cache', 'info'],
    ]) {
      const r = await sb.palm(...argv, '--json', '--offline');
      expect(r.exitCode, argv.join(' ')).toBe(0);
      onlyJson(r.stdout);
    }
  });

  it('describe of something missing: an error document, exit 1', async () => {
    sb = await cliSandbox();
    const r = await sb.palm('describe', 'skill', 'nope', '--json', '--offline');
    expect(r.exitCode).toBe(1);
    expect(onlyJson(r.stdout)).toMatchObject({ error: { code: 'E_NOT_FOUND' } });
  });

  it('install with a failing target: the result document lists the failure, exit 1', async () => {
    sb = await cliSandbox();
    await writeOrigins(sb, [{ alias: 'matt', fixture: 'mattpocock-like' }]);
    const { getTarget } = fakeTargets({ failFor: ['claude'] });
    const r = await runInProcess(['install', 'skill', 'tdd', '--target', 'claude', '--json'], {
      cwd: sb.project,
      env: sb.env,
      deps: { getTarget },
    });
    expect(r.code).toBe(1);
    expect(onlyJson(r.stdout)).toMatchObject({
      outcomes: [{ status: 'failed', entry: { name: 'tdd', targets: [] } }],
      failures: [{ name: 'tdd', target: 'claude', code: 'E_TARGET', message: 'claude is broken' }],
    });
  });

  it('install where one of two targets fails: the result document; exit 1 once the engine reports failures', async () => {
    sb = await cliSandbox();
    await writeOrigins(sb, [{ alias: 'matt', fixture: 'mattpocock-like' }]);
    const { getTarget } = fakeTargets({ failFor: ['codex'] });
    const r = await runInProcess(['i', 'skill', 'tdd', '-t', 'claude,codex', '--json'], {
      cwd: sb.project,
      env: sb.env,
      deps: { getTarget },
    });
    const doc = onlyJson(r.stdout);
    expect(doc).toMatchObject({
      outcomes: [{ entry: { name: 'tdd', targets: ['claude'] } }],
      failures: [{ name: 'tdd', target: 'codex', message: 'codex is broken' }],
    });
    expect(failureCount(doc)).toBe(1);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain('{');
  });

  it('human output of the same install shows the table and the failure on stderr', async () => {
    sb = await cliSandbox();
    await writeOrigins(sb, [{ alias: 'matt', fixture: 'mattpocock-like' }]);
    const { getTarget } = fakeTargets({ failFor: ['codex'] });
    const r = await runInProcess(['i', 'skill', 'tdd', '-t', 'claude,codex'], {
      cwd: sb.project,
      env: sb.env,
      deps: { getTarget },
    });
    expect(r.stdout).toContain('+ installed  skill  tdd');
    expect(r.stderr).toMatch(/x skill tdd@matt → codex: codex is broken/);
    expect(r.code).toBe(1);
  });
});
