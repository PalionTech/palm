/**
 * `palm create` rulings of the second 0.2 persona rerun (FINDINGS-v3.md N8, M21): a kit root
 * with a layout clear of the output directories takes templates, `name@source` names a declared
 * in-repo source, and a template without `--description` says its placeholder is live.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  InstallRequest,
  LayoutDescriptor,
  PalmContext,
  Source,
} from '../../src/core/types.js';
import type { CliDeps, ScopeState } from '../../src/create/engine.js';
import { createEntity } from '../../src/create/templates.js';
import { isPlaceholderDescription } from '../../src/index/placeholder-description.js';
import { createOutput } from '../../src/ui/output.js';
import { exists, read, removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import {
  type FakeSource,
  fakeEngine,
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

function context(dryRun = false): PalmContext {
  return {
    paths: { palmHome: sb.palmHome, home: sb.home, projectRoot: sb.project, cwd: sb.project },
    ui: fakeUI(),
    log: createOutput({ stdout: { write: () => 0 }, stderr: { write: () => 0 } }),
    env: sb.env,
    flags: {
      yes: false,
      dryRun,
      force: false,
      offline: false,
      json: false,
      allowExec: [],
      local: false,
    },
  };
}

const KIT_LAYOUT: LayoutDescriptor = { skills: ['packages/*'], agents: ['people/*.md'] };

/** A scope declaring `sources`, each local one with `layout` when given. */
function scopeWith(sources: Array<FakeSource & { layout?: LayoutDescriptor }>): ScopeState {
  const state = fakeScope({ root: sb.project, manifestTargets: ['claude'], sources });
  for (const ref of state.sources.all()) {
    const layout = sources.find((s) => s.name === ref.name)?.layout;
    if (layout) (ref.source as Source).layout = layout;
  }
  return state;
}

/** The kit repository itself declared as `.` with Kenji's layout. */
const kitRoot = (layout: LayoutDescriptor = KIT_LAYOUT) =>
  scopeWith([{ name: '.', path: sb.project, layout }]);

function installing(state: ScopeState, over: Partial<CliDeps> = {}) {
  return fakeEngine({
    scopes: [state],
    listSource: async () => ({ index: { entities: [] } }) as never,
    installFromSource: async (_ctx, req: InstallRequest) => ({
      outcomes: req.names.map((n) =>
        outcome(lockEntry({ kind: n.kind ?? 'skill', name: n.name, source: req.source })),
      ),
      failures: [],
      warnings: [],
    }),
    ...over,
  });
}

const hotfix = { kind: 'skill', name: 'hotfix', description: 'Ship a fix' } as const;

describe('N8 create --in . when the layout keeps clear of output directories', () => {
  it('N8 --in . with a declared layout clear of outputs writes where the layout indexes', async () => {
    const deps = installing(kitRoot());
    const created = await createEntity(context(), { ...hotfix, dir: '.', scope: 'project' }, deps);
    expect(created.file).toBe(join(sb.project, 'packages/hotfix/SKILL.md'));
    expect(await exists(created.file)).toBe(true);
    expect(deps.calls.installFromSource?.[0]?.[0]).toMatchObject({ source: sb.project });
  });

  it('N8 --in . without a layout is refused, saying how to make it usable', async () => {
    const run = createEntity(
      context(true),
      { ...hotfix, dir: '.', scope: 'project' },
      installing(scopeWith([{ name: '.', path: sb.project }])),
    );
    await expect(run).rejects.toMatchObject({
      code: 'E_SOURCE',
      message:
        '. overlaps the palm output directory .palm/; declare . with a layout that keeps clear of it',
      hint: 'palm create writes into a source of its own, for example --in ./agent-kit',
    });
  });

  it.each([
    ['*', '.palm'],
    ['**/*.md', '.palm'],
    ['.claude/*', '.claude/skills'],
    ['.github/skills/*', '.github'],
  ])('N8 a layout glob %s reaches an output directory: refused', async (glob, out) => {
    const run = createEntity(
      context(),
      { ...hotfix, dir: '.', scope: 'project' },
      installing(kitRoot({ skills: ['packages/*', glob] })),
    );
    await expect(run).rejects.toMatchObject({
      code: 'E_SOURCE',
      message: `. overlaps the palm output directory .palm/; its layout glob ${glob} reaches ${out}/`,
    });
    expect(await exists(join(sb.project, 'packages'))).toBe(false);
  });

  it('N8 a directory inside an output directory stays refused, layout or not', async () => {
    const state = scopeWith([
      { name: 'x', path: join(sb.project, '.claude/skills/kit'), layout: KIT_LAYOUT },
    ]);
    const run = createEntity(
      context(),
      { ...hotfix, dir: '.claude/skills/kit', scope: 'project' },
      installing(state),
    );
    await expect(run).rejects.toMatchObject({
      code: 'E_SOURCE',
      message: '.claude/skills/kit overlaps the claude output directory .claude/skills/',
    });
  });
});

describe('N8 name@source names a declared in-repo source', () => {
  const sources = () =>
    scopeWith([
      { name: 'acme', path: join(sb.project, 'kit'), layout: KIT_LAYOUT },
      { name: 'obra/superpowers', url: 'https://github.com/obra/superpowers.git' },
    ]);

  it('N8 hotfix@acme writes into acme by its layout and installs from acme', async () => {
    const deps = installing(sources());
    const created = await createEntity(
      context(),
      { ...hotfix, name: 'hotfix@acme', scope: 'project' },
      deps,
    );
    expect(created.file).toBe(join(sb.project, 'kit/packages/hotfix/SKILL.md'));
    expect(await read(created.file)).toMatch(/^---\nname: hotfix\n/);
    expect(deps.calls.installFromSource?.[0]?.[0]).toEqual({
      source: 'acme',
      names: [{ kind: 'skill', name: 'hotfix' }],
    });
  });

  it('N8 a git source or an undeclared key is E_USAGE naming an in-repo source', async () => {
    const git = createEntity(
      context(),
      { ...hotfix, name: 'hotfix@obra/superpowers', scope: 'project' },
      installing(sources()),
    );
    await expect(git).rejects.toMatchObject({
      code: 'E_USAGE',
      message:
        'hotfix@obra/superpowers: obra/superpowers is a git source; palm create writes into an in-repo source',
      hint: 'palm create skill hotfix@acme',
    });
    const missing = createEntity(
      context(),
      { ...hotfix, name: 'hotfix@nope', scope: 'project' },
      installing(scopeWith([])),
    );
    await expect(missing).rejects.toMatchObject({
      code: 'E_USAGE',
      message:
        'hotfix@nope: palm.yaml declares no source nope; palm create writes into an in-repo source',
      hint: 'palm create skill hotfix --in ./agent-kit',
    });
  });

  it('N8 --in naming another directory beside @source is E_USAGE; the same one is fine', async () => {
    const other = createEntity(
      context(),
      { ...hotfix, name: 'hotfix@acme', dir: 'elsewhere', scope: 'project' },
      installing(sources()),
    );
    await expect(other).rejects.toMatchObject({
      code: 'E_USAGE',
      message: '--in elsewhere and @acme name two directories; give one',
      hint: 'palm create skill hotfix@acme',
    });
    const same = await createEntity(
      context(true),
      { ...hotfix, name: 'hotfix@acme', dir: 'kit', scope: 'project' },
      installing(sources()),
    );
    expect(same.file).toBe(join(sb.project, 'kit/packages/hotfix/SKILL.md'));
  });
});

describe('M21 a template without --description is marked and says so', () => {
  const agentKit = () => installing(scopeWith([]));

  it('M21 the placeholder starts with TODO: describe and the run warns naming the file', async () => {
    const created = await createEntity(
      context(),
      { kind: 'skill', name: 'ios-release-notes', scope: 'project' },
      agentKit(),
    );
    const text = await read(created.file);
    expect(text).toContain(
      'description: "TODO: describe what ios-release-notes does and when the agent should use it."',
    );
    expect(created.result.warnings).toEqual([
      'skill ios-release-notes: the description is a placeholder (TODO: describe …) that every harness lists; write one in agent-kit/skills/ios-release-notes/SKILL.md, or pass --description',
    ]);
  });

  it('M21 --description writes no placeholder and no warning; a dry run warns too', async () => {
    const given = await createEntity(
      context(),
      { kind: 'agent', name: 'rev', description: 'Reviews diffs', scope: 'project' },
      agentKit(),
    );
    expect(given.result.warnings).toEqual([]);
    const dry = await createEntity(
      context(true),
      { kind: 'instruction', name: 'db', scope: 'project' },
      agentKit(),
    );
    expect(dry.result.warnings[0]).toMatch(/^instruction db: the description is a placeholder/);
  });

  it('M21 isPlaceholderDescription recognises the marker and nothing else', () => {
    expect(isPlaceholderDescription('TODO: describe what x does.')).toBe(true);
    expect(isPlaceholderDescription('  TODO: describe when to hand a task to x.')).toBe(true);
    expect(isPlaceholderDescription('Describe the TODO list: what is left to do')).toBe(false);
    expect(isPlaceholderDescription(undefined)).toBe(false);
  });

  it('M21 palm create without --description prints the warning', async () => {
    const kit = { name: './agent-kit', path: join(sb.project, 'agent-kit') };
    const deps = fakeEngine({
      scopes: [
        fakeScope({ root: sb.project, manifestTargets: ['claude'] }),
        fakeScope({ root: sb.project, manifestTargets: ['claude'], sources: [kit] }),
      ],
      listSource: async () => ({ index: { entities: [] } }) as never,
      installFromSource: async (_ctx, req: InstallRequest) => ({
        outcomes: req.names.map((n) =>
          outcome(lockEntry({ kind: 'skill', name: n.name, source: './agent-kit' })),
        ),
        failures: [],
        warnings: [],
      }),
    });
    const r = await palm(sb, ['create', 'skill', 'notes'], { deps });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(
      '! skill notes: the description is a placeholder (TODO: describe …) that every harness lists; write one in agent-kit/skills/notes/SKILL.md, or pass --description',
    );
  });
});
