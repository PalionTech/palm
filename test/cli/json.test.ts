/**
 * `--json` (DESIGN.md §10 "Output contract"): stdout holds exactly one JSON document, lists are
 * `{ items }`, every document has `warnings`, an error is `{ error: { code, message, hint } }`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckReport } from '../../src/core/types.js';
import type { EntityInfo } from '../../src/create/engine.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { fakeEngine, fakeScope, lockEntry, outcome, palm } from './fakes.js';

vi.mock('../../src/commands/ports.js', () => import('./contract.js'));

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
  render: { claude: 'sha256:1', cursor: 'sha256:1' },
  files: ['.claude/skills/tdd/SKILL.md'],
});
const mpSource = {
  url: 'https://github.com/mattpocock/skills.git',
  ref: '^1',
  resolved: 'v1.2.3',
  sha: '8be01d4aa',
};

async function json(argv: string[], deps: ReturnType<typeof fakeEngine>) {
  const r = await palm(sb, [...argv, '--json'], { deps });
  return { ...r, doc: JSON.parse(r.stdout) as Record<string, unknown> };
}

describe('--json', () => {
  it('get: { items, warnings } with the source, ref, sha, targets, files and layer', async () => {
    const deps = fakeEngine({
      listInstalled: async () => [{ entry: tdd, source: mpSource, layer: 'team' as const }],
    });
    const r = await json(['get'], deps);
    expect(r.code).toBe(0);
    expect(r.doc).toEqual({
      items: [
        {
          kind: 'skill',
          name: 'tdd',
          source: 'mattpocock/skills',
          ref: '^1',
          resolved: 'v1.2.3',
          sha: '8be01d4aa',
          targets: ['claude', 'cursor'],
          files: ['.claude/skills/tdd/SKILL.md'],
          merged: [],
          layer: 'team',
        },
      ],
      warnings: [],
    });
  });

  it('describe: the entity info and warnings', async () => {
    const info: EntityInfo = {
      entry: tdd,
      source: mpSource,
      files: { claude: ['.claude/skills/tdd/SKILL.md'] },
      notes: ['cursor reads .claude/skills; no second copy'],
      selectedBy: 'manifest',
    };
    const deps = fakeEngine({ describeEntity: async () => info });
    const r = await json(['describe', 'tdd'], deps);
    expect(r.doc).toEqual({ ...info, warnings: [] });
    expect(deps.calls.describeEntity?.[0]?.[0]).toEqual({ name: 'tdd' });
  });

  it('check: { ok, checks: [{ id, label, status, problems }], warnings } and exit 1', async () => {
    const report: CheckReport = {
      scope: 'project',
      ok: false,
      checks: [
        { id: 'manifest-lock', label: 'manifest and lock agree', status: 'ok', problems: [] },
        {
          id: 'lock-disk',
          label: '1 file differs from the lock',
          status: 'fail',
          problems: [
            {
              entity: { kind: 'skill', name: 'tdd', source: 'mattpocock/skills' },
              file: '.claude/skills/tdd/SKILL.md',
              message: 'changed since palm wrote it',
              fix: 'palm install mattpocock/skills tdd --force',
            },
          ],
        },
      ],
    };
    const r = await json(['check'], fakeEngine({ checkScope: async () => report }));
    expect(r.code).toBe(1);
    expect(r.doc).toEqual({ ok: false, checks: report.checks, warnings: [] });
    expect(r.stderr).toBe('');
  });

  it('install: { outcomes, failures, warnings } with the result warnings', async () => {
    const deps = fakeEngine({
      scopes: [fakeScope({ root: sb.project, manifestTargets: ['claude'] })],
      installFromSource: async () => ({
        outcomes: [outcome(tdd)],
        failures: [],
        warnings: ['agent reviewer names skills tdd: palm install mattpocock/skills tdd'],
      }),
    });
    const r = await json(['install', 'mattpocock/skills', 'tdd'], deps);
    expect(r.code).toBe(0);
    expect(r.doc).toEqual({
      outcomes: [outcome(tdd)],
      failures: [],
      warnings: ['agent reviewer names skills tdd: palm install mattpocock/skills tdd'],
    });
    expect(r.stderr).toBe('');
  });

  it('an error is { error: { code, message, hint }, warnings } and stdout holds nothing else', async () => {
    const deps = fakeEngine({ scopes: [fakeScope({ root: sb.project })] });
    const r = await json(['install', 'tdd'], deps);
    expect(r.code).toBe(2);
    expect(r.doc).toEqual({
      error: {
        code: 'E_USAGE',
        message: '"tdd" is not a repository. palm installs from git repositories:',
        hint: '  palm install <owner/repo> tdd             for example  palm install mattpocock/skills tdd',
      },
      warnings: [],
    });
  });

  it('a commander error is a usage error document too', async () => {
    const r = await json(['get', '--bogus'], fakeEngine());
    expect(r.code).toBe(2);
    expect(r.doc).toMatchObject({
      error: { code: 'E_USAGE', message: "unknown option '--bogus'" },
    });
  });

  it('info lines go to stderr so stdout stays one document', async () => {
    const legacy = await palm(sb, ['get', 'origins', '--json'], {
      deps: fakeEngine({ scopes: [fakeScope({ root: sb.project })] }),
    });
    expect(JSON.parse(legacy.stdout)).toEqual({ items: [], warnings: [] });
    expect(legacy.stderr).toBe('i palm get origins is now: palm get sources\n');
  });
});
