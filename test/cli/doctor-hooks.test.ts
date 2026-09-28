/**
 * `palm doctor` flags hook entries whose copied scripts are missing (PLAN §2 item 8): after a
 * fresh clone the committed hook config is there but `.palm/hooks/<name>` (gitignored) is not.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Check } from '../../src/commands/doctor.js';
import { saveLock } from '../../src/core/lockfile.js';
import { type LockEntry, TRANSFORM_VERSION } from '../../src/core/types.js';
import { createTarget } from '../../src/targets/index.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { CLAUDE_HOOKS, makeOrigin, mkEntity, mkInput } from '../targets/helpers.js';
import { runInProcess } from './helpers.js';

let sb: Sandbox | undefined;
afterEach(async () => {
  if (sb) await removeDir(sb.root);
  sb = undefined;
});

/** A project with the claude hook `fmt` deployed and locked. */
async function projectWithHook(): Promise<Sandbox> {
  const s = await sandbox();
  const origin = await makeOrigin();
  const entity = mkEntity(
    {
      kind: 'hook',
      hooks: { name: 'fmt', dialect: 'claude', raw: CLAUDE_HOOKS, pluginRootRel: 'plugins/fmt' },
    },
    'fmt',
  );
  const r = await createTarget('claude', s.env).deploy(
    mkInput({ entity, absPath: origin.hooksFile, originRoot: origin.root, scopeRoot: s.project }),
  );
  const entry: LockEntry = {
    kind: 'hook',
    name: 'fmt',
    origin: 'test',
    path: entity.path,
    contentHash: 'sha256:0',
    transform: TRANSFORM_VERSION,
    targets: ['claude'],
    files: r.files.map((path) => ({ path, hash: '' })),
    merged: r.merged,
  };
  await saveLock(join(s.project, 'palm.lock.yaml'), { version: 2, entries: [entry] });
  return s;
}

async function doctorChecks(s: Sandbox): Promise<{ code: number; checks: Check[] }> {
  const r = await runInProcess(['doctor', '--offline', '--json'], {
    cwd: s.project,
    env: { ...s.env, NO_COLOR: '1', PATH: process.env.PATH },
  });
  return { code: r.code, checks: (JSON.parse(r.stdout) as { items: Check[] }).items };
}

describe('palm doctor: hook assets', () => {
  it('reports the hook asset dirs as present', async () => {
    sb = await projectWithHook();
    const { checks } = await doctorChecks(sb);
    expect(checks).toContainEqual({
      group: 'hooks',
      name: 'project scope',
      status: 'ok',
      detail: '1 hook asset dir present',
    });
  });

  it('warns with the fix when .palm/hooks is missing after a fresh clone', async () => {
    sb = await projectWithHook();
    await rm(join(sb.project, '.palm'), { recursive: true, force: true });
    const { code, checks } = await doctorChecks(sb);
    expect(code).toBe(0); // a warning, not a failure
    expect(checks).toContainEqual({
      group: 'hooks',
      name: 'project scope',
      status: 'warn',
      detail:
        'missing .palm/hooks/fmt; run `palm install` to restore hook assets after a fresh clone',
    });
    // The asset files are reported once, by the hooks check, not again as lock drift.
    const drift = checks.find((c) => c.group === 'lock' && c.name === 'project scope');
    expect(drift?.status).toBe('ok');
    // Scopes without hook assets get no hooks line.
    expect(checks.some((c) => c.group === 'hooks' && c.name === 'global scope')).toBe(false);
  });
});
