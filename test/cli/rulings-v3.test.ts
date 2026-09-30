/**
 * The CLI rulings of the second persona rerun (scratchpad FINDINGS-v3): each test is named after
 * the ruling it proves. The hint rulings (O3 O7 R4' O15 J6' N11 T9 N7 Q3 O16 and the rest) are
 * scenarios of test/cli/hints.test.ts; these are the lines, counts, labels and flows around them.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apmInstallWords } from '../../src/commands/foreign-lists.js';
import { parseArgv } from '../../src/commands/program.js';
import { PalmError } from '../../src/core/errors.js';
import type {
  CheckReport,
  Entity,
  InstallResult,
  LockEntry,
  MigrateReport,
  UpdatePlan,
} from '../../src/core/types.js';
import type { ScopeState } from '../../src/create/engine.js';
import { createOutput } from '../../src/ui/output.js';
import { printInstallSummary } from '../../src/ui/summary.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import {
  entity,
  fakeEngine,
  fakeListing,
  fakeScope,
  fakeUI,
  lockEntry,
  outcome,
  palm,
} from './fakes.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await removeDir(sb.root);
});

const MP = 'mattpocock/skills';
const scope = (over: Partial<Parameters<typeof fakeScope>[0]> = {}) =>
  fakeScope({ root: sb.project, targets: ['claude'], ...over });

const nothing: InstallResult = { outcomes: [], failures: [], warnings: [] };

/** The summary a result prints, as plain text on stdout and stderr. */
function summary(result: InstallResult, opts: Partial<Parameters<typeof printInstallSummary>[2]>) {
  const written: string[] = [];
  const sink = {
    write: (s: string) => {
      written.push(s);
    },
  };
  const out = createOutput({ stdout: sink, stderr: sink, noColor: true });
  printInstallSummary(out, result, { scope: 'project', targets: ['claude'], ...opts });
  out.finish();
  return written.join('');
}

const skillAt = (name: string, files = [`.claude/skills/${name}/SKILL.md`]) =>
  lockEntry({ kind: 'skill', name, source: MP, files });

describe('the listing and the notes (Q18, M5, T15, O4, N11)', () => {
  it('Q18: notes point to palm describe source, which describes an undeclared source', async () => {
    const listed = fakeListing({ name: MP }, [entity('tdd')], { warnings: ['skipped a.md: x'] });
    const deps = () => fakeEngine({ scopes: [scope()], listSource: async () => listed });
    const list = await palm(sb, ['install', MP], { deps: deps() });
    expect(list.stdout).toContain(`(see: palm describe source ${MP})`);
    const described = await palm(sb, ['describe', 'source', MP], { deps: deps() });
    expect(described.code).toBe(0);
    expect(described.stdout).toContain(`source ${MP}`);
    expect(described.stdout).toContain('offers      1 skill');
    expect(described.stderr).toContain('skipped a.md: x');
  });

  it('N1: a note a person acts on prints in full; the others are one count line', async () => {
    const warnings = ['2 agent-shaped files not indexed: people/*.md; add layout: {…}', 'other'];
    const listed = fakeListing({ name: MP }, [entity('tdd')], { warnings });
    const deps = fakeEngine({ scopes: [scope()], listSource: async () => listed });
    const r = await palm(sb, ['install', MP], { deps });
    expect(r.stdout).toContain(`i ${MP}: 2 agent-shaped files not indexed: people/*.md`);
    expect(r.stdout).toContain(`i 1 more note from indexing ${MP}`);
  });

  it('M5, T15, O4: a plugin row comes first, and a name that is also a plugin says so', async () => {
    const plugin = {
      ...entity('ast-grep'),
      kind: 'plugin',
      def: { kind: 'plugin', members: [{ kind: 'skill', name: 'ast-grep-outline' }] },
    } as unknown as Entity;
    const listed = fakeListing({ name: 'ast-grep/agent-skill' }, [
      entity('ast-grep'),
      entity('ast-grep-outline'),
      plugin,
    ]);
    const deps = fakeEngine({ scopes: [scope()], listSource: async () => listed });
    const r = await palm(sb, ['install', 'ast-grep/agent-skill'], { deps });
    const lines = r.stdout.split('\n');
    expect(lines[0]).toContain('1 plugin, 2 skills');
    expect(lines[1]).toMatch(/^ {2}plugin {2}ast-grep\s+1 skill\s+\(also skill ast-grep/);
    expect(r.stdout).toContain('palm install ast-grep/agent-skill skill:ast-grep ast-grep-outline');
  });

  it('N11: the header of a listing names the source as --as does, and -g says ~/.palm/palm.yaml', async () => {
    const url = 'https://gitlab.acme.com/platform/company-agent-kit.git';
    const listed = fakeListing({ name: 'company-agent-kit' }, [entity('incident')]);
    const deps = fakeEngine({ scopes: [scope()], listSource: async () => listed });
    const r = await palm(sb, ['install', url, '--as', 'acme'], { deps });
    expect(r.stdout.split('\n')[0]).toMatch(/^acme {2}/);
  });
});

describe('the summary lines (Y3, Y16, Y18, Q11, O22, R14, R15)', () => {
  it("Y3': notices that widen activation are never collapsed", () => {
    const widened = (n: string) =>
      outcome(skillAt(n), 'installed', [
        `instruction ${n}: on-request in the source, always-on for claude until 0.3`,
      ]);
    const plain = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => outcome(skillAt(n)));
    const text = summary({ ...nothing, outcomes: [...plain, widened('g'), widened('h')] }, {});
    expect(text).toContain('always-on for claude until 0.3');
    expect(text).toContain('instruction g: on-request in the source, always-on');
    expect(text).toContain('instruction h: on-request in the source, always-on');
    expect(text).toContain('... 5 more');
  });

  it("Y16': narrowing an entry's targets says what was removed", () => {
    const before = { ...skillAt('tdd'), render: { claude: 'h', opencode: 'h', cursor: 'h' } };
    const after = { ...skillAt('tdd'), render: { cursor: 'h' } };
    const text = summary(
      { ...nothing, outcomes: [outcome(after, 're-rendered')] },
      { before: () => before },
    );
    expect(text).toContain('removed from claude, opencode');
  });

  it("Y18': a restore under --force reads overwritten", () => {
    const text = summary(
      { ...nothing, outcomes: [outcome(skillAt('tdd'), 'restored')] },
      { forced: true },
    );
    expect(text).toContain('1 overwritten.');
    expect(text).not.toContain('restored');
  });

  it('Q11: the commit line prints whenever an install adds a new path, not only the first', () => {
    const mcp = lockEntry({ kind: 'mcp', name: 'docs', source: MP, files: ['.mcp.json'] });
    const known = new Set(['.claude/']);
    const text = summary({ ...nothing, outcomes: [outcome(mcp)] }, { known });
    expect(text).toContain('1 installed. Commit palm.yaml, palm.lock.yaml and .mcp.json together.');
    const again = summary({ ...nothing, outcomes: [outcome(skillAt('tdd'))] }, { known });
    expect(again).toBe('+ skill  tdd   .claude/skills/tdd/   1 file\n1 installed.\n');
  });

  it("O22, R19': a full commit sha in a row reads as seven characters", () => {
    const sha = 'e276d99d85e7f5951e45d524fbcfe7436ee78a37';
    const text = summary(
      { ...nothing, outcomes: [outcome(skillAt('tdd'))] },
      { from: { [MP]: { url: 'u', ref: sha, sha } } },
    );
    expect(text).toContain(`from ${MP} e276d99`);
    expect(text).not.toContain(sha);
  });

  it("R14': the same failure twice prints once", () => {
    const f = {
      kind: 'hook' as const,
      name: 'fmt',
      source: MP,
      code: 'E_CONFLICT',
      message: 'changed',
      hint: `palm install ${MP} fmt --force`,
    };
    const text = summary({ ...nothing, failures: [f, f] }, {});
    expect(text.match(/x hook fmt/g)).toHaveLength(1);
    expect(text).toContain(`palm install ${MP} hook:fmt --force`);
  });

  it("R15': removing a plugin prints its line", async () => {
    const plugin = lockEntry({ kind: 'plugin', name: 'odu', source: 'juspay/odu' });
    const deps = fakeEngine({
      scopes: [scope({ sources: [{ name: 'juspay/odu' }], entries: [plugin] })],
      removeEntities: async () => ({ removed: [plugin], failures: [], warnings: [] }),
    });
    const r = await palm(sb, ['remove', 'juspay/odu', 'plugin:odu'], { deps });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('- plugin  odu');
  });
});

describe('remove (O25, Q17)', () => {
  const entries = [skillAt('tdd'), skillAt('grill')];
  const removing = () =>
    fakeEngine({
      scopes: [scope({ sources: [{ name: MP }], entries })],
      removeEntities: async () => ({ removed: entries, failures: [], warnings: [] }),
    });

  it('O25, Q17: palm remove <source> asks, then removes every entry of it', async () => {
    const deps = removing();
    const ui = fakeUI({ interactive: true, confirm: true });
    const r = await palm(sb, ['remove', MP], { deps, ui });
    expect(r.code).toBe(0);
    expect(ui.asked).toEqual([`Remove 2 entries from ${MP} and the source?`]);
    const [refs] = deps.calls.removeEntities?.[0] ?? [];
    expect(refs).toEqual([
      { kind: 'skill', name: 'tdd', source: MP },
      { kind: 'skill', name: 'grill', source: MP },
    ]);
  });

  it('O25: no at the question removes nothing and exits 130; --all is the same request', async () => {
    const deps = removing();
    const ui = fakeUI({ interactive: true, confirm: false });
    const r = await palm(sb, ['remove', MP, '--all'], { deps, ui });
    expect(r.code).toBe(130);
    expect(r.stdout).toContain('cancelled; nothing was removed');
    expect(deps.calls.removeEntities).toBeUndefined();
  });
});

describe('get and describe (M12, Q16, Q3)', () => {
  /** A scope whose lock paths resolve under the sandbox project (the fakes resolve none). */
  function resolving(state: ScopeState): ScopeState {
    Object.assign(state.paths, { abs: (p: string) => join(sb.project, p) });
    return state;
  }

  it('M12: get and describe mark the files that are gone', async () => {
    const tdd = skillAt('tdd', ['.claude/skills/tdd/SKILL.md', '.claude/skills/tdd/ref.md']);
    await mkdir(join(sb.project, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(sb.project, '.claude/skills/tdd/SKILL.md'), 'x');
    const row = { entry: tdd, source: { url: 'u' }, layer: 'team' as const };
    const deps = () =>
      fakeEngine({
        scopes: [resolving(scope({ entries: [tdd] }))],
        listInstalled: async () => [row],
        describeEntity: async () => ({
          entry: tdd,
          source: {},
          files: { claude: tdd.files },
          notes: [],
          selectedBy: 'palm.yaml',
        }),
      });
    const got = await palm(sb, ['get'], { deps: deps() });
    expect(got.stdout).toContain('2 (1 missing)');
    expect(got.stdout).toContain('restore missing files: palm install');
    const described = await palm(sb, ['describe', 'tdd'], { deps: deps() });
    expect(described.stdout).toContain('.claude/skills/tdd/ref.md (missing)');
  });

  it('Q16: get names the other scope when the name is installed there, as remove does', async () => {
    const deps = fakeEngine({
      scopes: [scope({ scope: 'global', entries: [skillAt('tdd')] })],
      listInstalled: async () => [],
    });
    const r = await palm(sb, ['get', 'skills', 'tdd'], { deps });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('it is installed in the global scope: palm get skill tdd -g');
  });

  it('Q3: describe suggests the one declared source only when it offers the name', async () => {
    const offered = fakeListing({ name: 'obra/superpowers' }, [entity('brainstorming')]);
    const deps = () =>
      fakeEngine({
        scopes: [scope({ sources: [{ name: 'obra/superpowers' }] })],
        listInstalled: async () => [],
        listSource: async () => offered,
      });
    const tdd = await palm(sb, ['describe', 'tdd'], { deps: deps() });
    expect(tdd.stderr).toContain('list what is installed: palm get');
    const brain = await palm(sb, ['describe', 'brainstorming'], { deps: deps() });
    expect(brain.stderr).toContain('palm describe obra/superpowers brainstorming');
  });
});

describe('errors and empty scopes (M13, Q10, O20)', () => {
  it('M13: a palm.yaml with merge-conflict markers says so, with the line', async () => {
    await writeFile(
      join(sb.project, 'palm.yaml'),
      'targets: [claude]\n<<<<<<< HEAD\nsources: {}\n=======\n>>>>>>> branch\n',
    );
    const deps = fakeEngine({
      openScope: async () => {
        throw new PalmError('E_PARSE', 'palm.yaml: bad indentation of a mapping entry (3:1)');
      },
    });
    const r = await palm(sb, ['install'], { deps });
    expect(r.stderr).toBe(
      'x palm.yaml has merge conflict markers at line 2; resolve them\n  keep one side of each conflict in palm.yaml, then run: palm check\n',
    );
  });

  it('Q10: migrate without palm.yaml says no palm.yaml here', async () => {
    const deps = fakeEngine({
      migrateScope: async () => {
        throw new PalmError(
          'E_USAGE',
          'nothing to migrate: palm.yaml and palm.lock.yaml are in the 0.2 format',
          'palm install',
        );
      },
    });
    const r = await palm(sb, ['migrate'], { deps });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('x no palm.yaml here; nothing to migrate');
  });

  it('O20: migrate prints a hidden-character warning once, not again after the check', async () => {
    const warning = `skill w: skills/w/a.md: 2 hidden characters, first U+200B ZERO WIDTH SPACE at line 3`;
    const report: MigrateReport = {
      manifest: 'targets: [claude]\n',
      lock: '',
      movedAssets: [],
      exec: [],
      warnings: [warning],
      failures: [],
    } as unknown as MigrateReport;
    const check: CheckReport = {
      scope: 'project',
      ok: true,
      checks: [
        {
          id: 'hidden-unicode',
          label: 'hidden Unicode',
          status: 'warn',
          problems: [
            { entity: { kind: 'skill', name: 'w', source: MP }, message: '2 files hold U+200B' },
          ],
        },
      ],
    };
    const deps = fakeEngine({ migrateScope: async () => report, checkScope: async () => check });
    const r = await palm(sb, ['migrate'], { deps });
    expect(r.stderr).not.toContain('2 hidden characters');
    expect(r.stdout).toContain('! skill w: 2 files hold U+200B');
  });
});

describe('update (Q12, O23)', () => {
  const plan = (from: string, to: string): UpdatePlan =>
    ({
      scope: 'project',
      sources: [{ name: MP, ref: to, from, to }],
      items: [
        { mark: 'updated', kind: 'skill', name: 'tdd', source: MP, from, to, atRisk: [] },
        ...['a', 'b'].map((name) => ({
          mark: 'unchanged' as const,
          kind: 'skill' as const,
          name,
          source: MP,
          from,
          to,
          note: 'same content',
          atRisk: [],
        })),
        { mark: 'unchanged', kind: 'skill', name: 'c', source: MP, atRisk: [] },
      ],
      failures: [],
      warnings: [],
    }) as unknown as UpdatePlan;

  it('Q12: an update to an older version reads downgraded, in the plan and the summary', async () => {
    const tdd: LockEntry = skillAt('tdd');
    const deps = fakeEngine({
      scopes: [scope({ entries: [tdd] })],
      planUpdate: async () => plan('v1.2.0 (6acc160)', 'v1.0.0 (1234567)'),
      planChanges: () => 1,
      applyUpdate: async () => ({ ...nothing, outcomes: [outcome(tdd, 'updated')] }),
    });
    const r = await palm(sb, ['update', '--yes'], { deps });
    expect(r.stdout).toContain('downgrade');
    expect(r.stdout).toContain('1 downgraded.');
  });

  it('O23: entries whose source moved with the same content are one re-pinned count', async () => {
    const deps = fakeEngine({
      planUpdate: async () => plan('v1.0.0 (1234567)', 'v1.1.0 (7654321)'),
      planChanges: () => 1,
    });
    const r = await palm(sb, ['update', '--dry-run'], { deps });
    expect(r.stdout).toContain('= 2 re-pinned (same content), 1 unchanged');
    expect(r.stdout).not.toMatch(/= +skill +a /);
  });
});

describe('create (N5, O17, E5)', () => {
  const golang = lockEntry({ kind: 'skill', name: 'golang', source: 'JanDeDobbeleer/agentic' });

  it('N5: create --dry-run refuses a name another entry holds, and offers another name', async () => {
    const deps = fakeEngine({ scopes: [scope({ entries: [golang] })] });
    const r = await palm(sb, ['create', 'skill', 'golang', '--dry-run'], { deps });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      'x skill golang is already installed from JanDeDobbeleer/agentic; a scope holds one skill golang\n  pick another name: palm create skill golang-local --dry-run\n',
    );
    expect(r.stdout).not.toContain('would write');
  });

  it("O17, R2': the real run's clash offers another name, never a remove that loses the edit", async () => {
    const kit = { name: './agent-kit', path: join(sb.project, 'agent-kit') };
    const deps = fakeEngine({
      scopes: [scope({ entries: [golang] }), scope({ entries: [golang], sources: [kit] })],
      installFromSource: async () => ({
        ...nothing,
        failures: [
          {
            kind: 'skill',
            name: 'golang',
            source: './agent-kit',
            code: 'E_CONFLICT',
            message:
              'skill golang is already installed from JanDeDobbeleer/agentic; a scope holds one skill golang',
            hint: 'palm remove JanDeDobbeleer/agentic skill:golang',
          },
        ],
      }),
    });
    const r = await palm(sb, ['create', 'skill', 'golang'], { deps });
    expect(r.stderr).toContain('pick another name: palm create skill golang-local');
    expect(r.stderr).not.toContain('palm remove');
  });

  it("E5': create accepts --review", () => {
    expect(parseArgv(['create', 'hook', 'fmt', '--review']).invocation.opts.review).toBe(true);
  });
});

describe('palm.yaml and --allow-exec (J10, K-manifest)', () => {
  it('K-manifest: an --allow-exec key typed with @palm.yaml reaches the engine as the lock names it', async () => {
    const seen: string[] = [];
    const deps = fakeEngine({
      scopes: [scope()],
      parseAllowExec: (text: string | undefined) => {
        seen.push(text ?? '');
        return [];
      },
      syncScope: async () => nothing,
    });
    await palm(sb, ['install', '--allow-exec', 'mcp:docs@palm.yaml=sha256:ab'], { deps });
    expect(seen).toEqual(['mcp:docs@manifest=sha256:ab']);
  });

  it('J10: a palm.yaml server reads palm.yaml in a failure line', () => {
    const text = summary(
      {
        ...nothing,
        failures: [
          {
            kind: 'mcp',
            name: 'docs',
            source: 'manifest',
            code: 'E_CONFLICT',
            message: 'changed',
            hint: 'palm install manifest docs --force',
          },
        ],
      },
      {},
    );
    expect(text).toContain('x mcp docs from palm.yaml: changed');
    expect(text).toContain('  palm install mcp docs --force');
    expect(text).not.toContain('manifest');
  });
});

describe("init (J6', O5)", () => {
  it("J6': init refused in a harness's global directory keeps the typed --target", async () => {
    const dir = join(sb.home, '.cursor');
    await mkdir(dir, { recursive: true });
    const r = await palm(sb, ['init', '--target', 'cursor'], { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('  palm init --target cursor -g');
  });

  it("J6': without --target the hint names the harness whose directory it is", async () => {
    const dir = join(sb.home, '.cursor');
    await mkdir(dir, { recursive: true });
    const r = await palm(sb, ['init'], { cwd: dir });
    expect(r.stderr).toContain('  palm init --target cursor -g');
  });

  it('O5: an APM virtual file path installs as its repository and kind:name', () => {
    expect(apmInstallWords('JanDeDobbeleer/agentic/instructions/golang.instructions.md')).toEqual([
      'JanDeDobbeleer/agentic',
      'instruction:golang',
    ]);
    expect(apmInstallWords('acme/kit/agents/reviewer.agent.md#v1')).toEqual([
      'acme/kit#v1',
      'agent:reviewer',
    ]);
    expect(apmInstallWords('acme/kit/notes/readme.md')).toEqual(['acme/kit']);
    expect(apmInstallWords('acme/standards#v1.0.0')).toEqual(['acme/standards#v1.0.0', '--all']);
  });
});
