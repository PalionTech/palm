/**
 * `palm create` rulings of the 0.2 persona rerun (FINDINGS-v2.md K13, B6, J6, C27): every check
 * runs before a byte is written, the template lands where the source's layout indexes it, and a
 * run that installs nothing takes its template back.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PalmError } from '../../src/core/errors.js';
import type {
  Entity,
  InstallRequest,
  LayoutDescriptor,
  PalmContext,
  Source,
  SourceIndex,
} from '../../src/core/types.js';
import type { CliDeps, ScopeState } from '../../src/create/engine.js';
import { createEntity } from '../../src/create/templates.js';
import { createOutput } from '../../src/ui/output.js';
import { exists, read, removeDir, type Sandbox, sandbox, write } from '../support/sandbox.js';
import { fakeEngine, fakeScope, fakeSourceRef, fakeUI, lockEntry, outcome } from './fakes.js';

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

/** A scope whose source `./kit` (at `<project>/kit`) carries `layout`. */
function scopeWithKit(layout?: LayoutDescriptor): ScopeState {
  const ref = fakeSourceRef({ name: './kit', path: join(sb.project, 'kit') });
  if (layout) (ref.source as Source).layout = layout;
  const state = fakeScope({ root: sb.project, manifestTargets: ['claude'] });
  const refs = [ref];
  return {
    ...state,
    sources: { ...state.sources, all: () => refs, size: 1 },
  } as unknown as ScopeState;
}

/** An index of the source with nothing named like the template. */
const emptyListing = async () => ({ index: { entities: [] } }) as never;

function installing(state: ScopeState, over: Partial<CliDeps> = {}) {
  return fakeEngine({
    scopes: [state],
    listSource: emptyListing,
    installFromSource: async (_ctx, req: InstallRequest) => ({
      outcomes: req.names.map((n) =>
        outcome(lockEntry({ kind: n.kind ?? 'skill', name: n.name, source: './kit' })),
      ),
      failures: [],
      warnings: [],
    }),
    ...over,
  });
}

const kitDir = () => join(sb.project, 'kit');

describe('K13 targets are checked before the template is written', () => {
  it('K13 no target: E_USAGE naming palm init, nothing written, nothing installed', async () => {
    const deps = fakeEngine({ scopes: [fakeScope({ root: sb.project, targets: [] })] });
    const run = createEntity(
      context(),
      { kind: 'skill', name: 'n', dir: '.', scope: 'project' },
      deps,
    );
    await expect(run).rejects.toMatchObject({ code: 'E_USAGE', hint: 'palm init --target claude' });
    expect(await exists(join(sb.project, 'skills'))).toBe(false);
    expect(deps.calls.installFromSource).toBeUndefined();
  });
});

describe('K13 B6 the template lands where the layout indexes it', () => {
  const layout: LayoutDescriptor = {
    skills: ['packages/*'],
    agents: ['people/*.md'],
    instructions: ['rules/*.mdc'],
    hooks: ['ops/hooks/*/hooks.json'],
  };

  it.each([
    ['skill', 'packages/notes/SKILL.md'],
    ['agent', 'people/notes.md'],
    ['instruction', 'rules/notes.mdc'],
    ['hook', 'ops/hooks/notes/hooks.json'],
  ] as const)('B6 %s goes to %s', async (kind, rel) => {
    const deps = installing(scopeWithKit(layout));
    const created = await createEntity(
      context(),
      { kind, name: 'notes', dir: 'kit', scope: 'project' },
      deps,
    );
    expect(created.file).toBe(join(kitDir(), rel));
    expect(await exists(created.file)).toBe(true);
  });

  it('B6 an .mdc instruction is always-on; a hook names its script from its root', async () => {
    const deps = installing(scopeWithKit(layout));
    await createEntity(
      context(),
      { kind: 'instruction', name: 'db', dir: 'kit', scope: 'project' },
      deps,
    );
    expect(await read(join(kitDir(), 'rules/db.mdc'))).toMatch(
      /^---\ndescription: .*\nalwaysApply: true\n---\n/,
    );
    await createEntity(
      context(),
      { kind: 'hook', name: 'log', dir: 'kit', scope: 'project' },
      installing(scopeWithKit(layout)),
    );
    expect(await read(join(kitDir(), 'ops/hooks/log/hooks.json'))).toContain('scripts/log.sh');
    expect(await exists(join(kitDir(), 'ops/hooks/log/scripts/log.sh'))).toBe(true);
  });

  it('K13 a layout with no glob for the kind is refused before writing', async () => {
    const deps = installing(scopeWithKit({ skills: ['packages/*'] }));
    const run = createEntity(
      context(),
      { kind: 'agent', name: 'a', dir: 'kit', scope: 'project' },
      deps,
    );
    await expect(run).rejects.toMatchObject({
      code: 'E_USAGE',
      message: "the source's layout lists no agents glob a new agent fits",
    });
    expect(await exists(kitDir())).toBe(false);
  });

  it('K13 a layout with only exclude keeps the convention path', async () => {
    const deps = installing(scopeWithKit({ exclude: ['tests'] }));
    const created = await createEntity(
      context(),
      { kind: 'skill', name: 'n', dir: 'kit', scope: 'project' },
      deps,
    );
    expect(created.file).toBe(join(kitDir(), 'skills/n/SKILL.md'));
  });
});

describe('J6 --in is checked before writing, in a dry run too', () => {
  it('J6 a project --in outside the project is E_SOURCE, dry run or not', async () => {
    for (const dryRun of [true, false]) {
      const deps = installing(scopeWithKit());
      const opts = { kind: 'skill', name: 'n', dir: '../elsewhere', scope: 'project' } as const;
      await expect(createEntity(context(dryRun), opts, deps)).rejects.toMatchObject({
        code: 'E_SOURCE',
      });
    }
    expect(await exists(join(sb.root, 'elsewhere'))).toBe(false);
  });

  it('J6 under -g, --in may be any directory under the home directory', async () => {
    const deps = installing(scopeWithKit());
    const opts = { kind: 'skill', name: 'n', dir: '~/dotfiles/palm/kit', scope: 'global' } as const;
    const created = await createEntity(context(), opts, deps);
    expect(created.file).toBe(join(sb.home, 'dotfiles/palm/kit/skills/n/SKILL.md'));
    const outside = { ...opts, dir: join(sb.root, 'other') };
    await expect(
      createEntity(context(), outside, installing(scopeWithKit())),
    ).rejects.toMatchObject({
      code: 'E_SOURCE',
      hint: 'palm create skill n --in ~/.palm/kit -g',
    });
  });

  it('J6 --in an output directory is refused before writing', async () => {
    const deps = installing(scopeWithKit());
    const run = createEntity(
      context(),
      { kind: 'skill', name: 'n', dir: '.claude', scope: 'project' },
      deps,
    );
    await expect(run).rejects.toMatchObject({ code: 'E_SOURCE' });
    expect(await exists(join(sb.project, '.claude'))).toBe(false);
  });
});

describe('C27 a name the source already indexes', () => {
  function listing(entities: Array<Pick<Entity, 'kind' | 'name' | 'path'>>): Partial<CliDeps> {
    const index = { entities, warnings: [], detected: 'convention' } as unknown as SourceIndex;
    return { listSource: async () => ({ index }) as never };
  }

  it('C27 is refused naming where it is; nothing is written', async () => {
    await write(join(sb.project, 'skill/merge-master/SKILL.md'), '---\nname: merge-master\n---\n');
    const deps = installing(
      scopeWithKit(),
      listing([{ kind: 'skill', name: 'merge-master', path: 'merge-master' }]),
    );
    const run = createEntity(
      context(),
      { kind: 'skill', name: 'merge-master', dir: 'skill', scope: 'project' },
      deps,
    );
    await expect(run).rejects.toMatchObject({
      code: 'E_CONFLICT',
      message: 'skill merge-master already exists in ./skill (merge-master)',
      hint: 'install the one that is there: palm install ./skill skill:merge-master',
    });
    expect(await exists(join(sb.project, 'skill/skills'))).toBe(false);
  });

  it('C27 the template at its own path is a rerun, not a clash', async () => {
    await write(join(kitDir(), 'other.txt'), 'x');
    const deps = installing(
      scopeWithKit(),
      listing([{ kind: 'skill', name: 'n', path: 'skills/n' }]),
    );
    const created = await createEntity(
      context(),
      { kind: 'skill', name: 'n', dir: 'kit', scope: 'project' },
      deps,
    );
    expect(await exists(created.file)).toBe(true);
  });
});

describe('K13 a run that installs nothing takes its template back', () => {
  it('K13 a refused install removes the files and the folders create made', async () => {
    const refused = async (): Promise<never> => {
      throw new PalmError('E_UNTRUSTED_EXEC', 'hook log needs consent');
    };
    const deps = installing(scopeWithKit(), { installFromSource: refused });
    const run = createEntity(
      context(),
      { kind: 'hook', name: 'log', dir: 'kit', scope: 'project' },
      deps,
    );
    await expect(run).rejects.toMatchObject({ code: 'E_UNTRUSTED_EXEC' });
    expect(await exists(kitDir())).toBe(false);
  });

  it('K13 an install with only failures leaves nothing written and lists no file', async () => {
    await write(join(kitDir(), 'README.md'), '# kit\n');
    const failed = async () => ({
      outcomes: [],
      failures: [
        { kind: 'skill' as const, name: 'n', source: './kit', code: 'E_SOURCE', message: 'no' },
      ],
      warnings: [],
    });
    const deps = installing(scopeWithKit(), {
      installFromSource: failed,
      ...{ listSource: async () => ({ index: { entities: [] } }) as never },
    });
    const created = await createEntity(
      context(),
      { kind: 'skill', name: 'n', dir: 'kit', scope: 'project' },
      deps,
    );
    expect(created.files).toEqual([]);
    expect(await exists(join(kitDir(), 'skills'))).toBe(false);
    expect(await read(join(kitDir(), 'README.md'))).toBe('# kit\n');
  });
});
