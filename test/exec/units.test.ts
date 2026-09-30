import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { Entity, ExecUnit, SourceCheckout } from '../../src/core/types.js';
import {
  closureTree,
  commandAt,
  execFrom,
  execHash,
  execUnitOf,
  isExecutable,
  unitKey,
} from '../../src/exec/units.js';
import {
  GH_ASSETS,
  ghCliEntity,
  ghCliRender,
  ghCliScripts,
  ghCliUnit,
  rendered,
  teamHelperEntity,
  teamHelperUnit,
} from './examples.js';

const git = vi.hoisted(() => ({ commitDate: vi.fn(async () => '2026-07-14T09:12:00+02:00') }));

vi.mock('../../src/core/git.js', async (real) => ({ ...(await real()), ...git }));

const hashOf = (unit: ExecUnit) => unit.hash;

describe('unitKey', () => {
  it('is <kind>:<name>@<source>', () => {
    expect(unitKey({ kind: 'hook', name: 'gh-cli', source: 'trailofbits/skills' })).toBe(
      'hook:gh-cli@trailofbits/skills',
    );
    expect(unitKey({ kind: 'mcp', name: 'docs', source: 'manifest' })).toBe('mcp:docs@manifest');
  });
});

describe('isExecutable', () => {
  const hook = (raw: unknown): Entity => ({
    ...ghCliEntity,
    def: {
      kind: 'hook',
      hooks: {
        name: 'h',
        dialect: 'claude',
        raw,
        references: [],
        closure: { paths: [] },
        promptHooks: [],
      },
    },
  });

  it('is true for a hook set with a command hook in any dialect', () => {
    expect(isExecutable(ghCliEntity)).toBe(true);
    expect(isExecutable(hook({ version: 1, hooks: { stop: [{ command: './stop.sh' }] } }))).toBe(
      true,
    );
    expect(
      isExecutable(hook({ hooks: { sessionStart: [{ type: 'command', bash: 'x.sh' }] } })),
    ).toBe(true);
  });

  it('is false for prompt hooks only, a remote server and text entities', () => {
    expect(
      isExecutable(
        hook({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'check it' }] }] } }),
      ),
    ).toBe(false);
    const http: Entity = {
      ...teamHelperEntity,
      def: {
        ...teamHelperEntity.def,
        mcp: { name: 'd', transport: 'http', url: 'https://x' },
      } as Entity['def'],
    };
    expect(isExecutable(http)).toBe(false);
    expect(isExecutable(teamHelperEntity)).toBe(true);
    expect(
      isExecutable({
        ...ghCliEntity,
        kind: 'skill',
        def: { kind: 'skill', skill: { name: 's', description: 'd' } },
      }),
    ).toBe(false);
  });
});

describe('execUnitOf', () => {
  it('collects every command once across targets, with each target rendering and file', () => {
    const unit = ghCliUnit();
    expect(unit.key).toBe('hook:gh-cli@trailofbits/skills');
    expect(unit.kind).toBe('hook');
    expect(unit.commands).toEqual([
      {
        id: 'SessionStart//-',
        canonical: 'bash ${PLUGIN_ROOT}/hooks/persist-session-id.sh',
        event: 'SessionStart',
      },
      {
        id: 'PreToolUse//Bash',
        canonical: 'bash ${PLUGIN_ROOT}/hooks/intercept-github-curl.sh',
        event: 'PreToolUse',
        matcher: 'Bash',
      },
    ]);
    expect(Object.keys(unit.rendered)).toEqual(['claude', 'cursor']);
    expect(unit.rendered.cursor?.[0]).toEqual({
      id: 'SessionStart//-',
      command: `bash "$CURSOR_PROJECT_DIR"/${GH_ASSETS}/hooks/persist-session-id.sh`,
      file: '.cursor/hooks.json',
    });
    expect(unit.closure.root).toBe(GH_ASSETS);
    expect(unit.closure.files.map((f) => f.path)).toEqual(
      [...ghCliScripts().map((f) => f.path)].sort(),
    );
    expect(unit.closure.bytes).toBe(21504);
    expect(unit.from?.ref).toBe('v2.1.0');
    expect(unit.env).toBeUndefined();
    expect(unit.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('records env keys (sorted, never values) and cwd for a stdio server', () => {
    const entity: Entity = {
      ...teamHelperEntity,
      def: {
        ...teamHelperEntity.def,
        mcp: {
          name: 't',
          transport: 'stdio',
          command: 'node',
          env: { Z: 'z', A: 'secret' },
          cwd: '${CLAUDE_PLUGIN_ROOT}',
        },
      } as Entity['def'],
    };
    const unit = execUnitOf(entity, {}, { root: 'r', inPlace: false, files: [] });
    expect(unit.env).toEqual(['A', 'Z']);
    expect(unit.cwd).toBe('${CLAUDE_PLUGIN_ROOT}');
    expect(JSON.stringify(unit)).not.toContain('secret');
    expect(teamHelperUnit().env).toEqual([]);
  });

  it('lists no files for an in-place source, so its scripts do not move the hash', () => {
    const renders = { claude: ghCliRender('claude') };
    const a = execUnitOf(ghCliEntity, renders, {
      root: 'agent-kit/hooks',
      inPlace: true,
      files: ghCliScripts(),
    });
    const b = execUnitOf(ghCliEntity, renders, {
      root: 'agent-kit/hooks',
      inPlace: true,
      files: [],
    });
    expect(a.closure).toEqual({ root: 'agent-kit/hooks', inPlace: true, files: [], bytes: 0 });
    expect(a.hash).toBe(b.hash);
  });
});

describe('execHash', () => {
  const base = ghCliUnit();
  const build = (change: {
    renders?: Parameters<typeof execUnitOf>[1];
    files?: ReturnType<typeof ghCliScripts>;
    from?: ExecUnit['from'];
    entity?: Entity;
  }) =>
    execUnitOf(
      change.entity ?? ghCliEntity,
      change.renders ?? { claude: ghCliRender('claude'), cursor: ghCliRender('cursor') },
      { root: GH_ASSETS, inPlace: false, files: change.files ?? ghCliScripts() },
      change.from,
    );

  it('does not move with a commit bump, a new target, a dropped target or file order', () => {
    expect(hashOf(build({ from: { sha: 'ffffff0', ref: 'v2.2.0' } }))).toBe(base.hash);
    const gemini = ghCliRender('claude');
    expect(
      hashOf(
        build({
          renders: { claude: ghCliRender('claude'), cursor: ghCliRender('cursor'), gemini },
        }),
      ),
    ).toBe(base.hash);
    expect(hashOf(build({ renders: { cursor: ghCliRender('cursor') } }))).toBe(base.hash);
    expect(hashOf(build({ files: ghCliScripts().reverse() }))).toBe(base.hash);
  });

  it('does not move when commands arrive in another order (they are sorted by id)', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(base.commands, { minLength: base.commands.length }),
        (commands) => {
          expect(execHash({ commands, closureTree: closureTree(base.closure.files) })).toBe(
            base.hash,
          );
        },
      ),
    );
  });

  it('does not move with env key order or repeats', () => {
    const tree = closureTree([]);
    expect(execHash({ commands: [], env: ['B', 'A'], closureTree: tree })).toBe(
      execHash({ commands: [], env: ['A', 'B', 'A'], closureTree: tree }),
    );
  });

  it('moves on any script byte, executable bit, command, argument order, event, matcher, env key or cwd', () => {
    const files = ghCliScripts();
    const changed = (i: number, patch: object) =>
      files.map((f, j) => (j === i ? { ...f, ...patch } : f));
    const cmd = base.commands;
    const tree = closureTree(base.closure.files);
    const variants = [
      hashOf(build({ files: changed(0, { hash: `sha256:1b9e04c3${'0'.repeat(56)}` }) })),
      hashOf(build({ files: changed(2, { mode: 0o755 }) })),
      hashOf(build({ files: changed(0, { mode: 0o644 }) })),
      hashOf(
        build({
          files: [...files, { path: 'hooks/new.sh', mode: 0o644, hash: 'sha256:1', size: 1 }],
        }),
      ),
      hashOf(build({ files: changed(0, { path: 'hooks/renamed.sh' }) })),
      execHash({
        commands: [{ ...cmd[0]!, canonical: `${cmd[0]!.canonical} --now` }, cmd[1]!],
        closureTree: tree,
      }),
      execHash({ commands: [{ ...cmd[0]!, canonical: 'node b.js a' }], closureTree: tree }),
      execHash({ commands: [{ ...cmd[0]!, canonical: 'node a b.js' }], closureTree: tree }),
      execHash({ commands: [{ ...cmd[0]!, event: 'Stop' }, cmd[1]!], closureTree: tree }),
      execHash({ commands: [cmd[0]!, { ...cmd[1]!, matcher: 'Bash|Edit' }], closureTree: tree }),
      execHash({ commands: cmd, env: ['GH_TOKEN'], closureTree: tree }),
      execHash({ commands: cmd, cwd: '${CLAUDE_PLUGIN_ROOT}', closureTree: tree }),
      execHash({ commands: cmd, cwd: '${CLAUDE_PLUGIN_ROOT}/sub', closureTree: tree }),
    ];
    expect(new Set([base.hash, ...variants]).size).toBe(variants.length + 1);
  });

  it('keeps only the executable bit of a mode, as git does', () => {
    const files = ghCliScripts().map((f) =>
      f.mode === 0o755 ? { ...f, mode: 0o775 } : { ...f, mode: 0o664 },
    );
    expect(hashOf(build({ files }))).toBe(base.hash);
  });
});

describe('commandAt', () => {
  it('pairs commands with their renderings by id and occurrence', () => {
    const line = (canonical: string, command: string) => ({
      id: 'Stop//-',
      canonical,
      command,
      file: 'f',
      event: 'Stop',
    });
    const unit = execUnitOf(
      ghCliEntity,
      { claude: rendered([line('a', 'A'), line('b', 'B')]) },
      { root: 'r', inPlace: false, files: [] },
    );
    expect([commandAt(unit, 'claude', 0), commandAt(unit, 'claude', 1)]).toEqual(['A', 'B']);
    expect(commandAt(unit, 'cursor', 1)).toBe('b');
    expect(commandAt(unit, undefined, 5)).toBe('');
  });
});

describe('execFrom', () => {
  const checkout: SourceCheckout = {
    source: { name: 'trailofbits/skills', type: 'git' },
    sourceId: 'github.com__trailofbits__skills',
    root: '/cache/x/sha-82fe822',
    repoDir: '/cache/x/sha-82fe822',
    sha: '82fe822a9d0c',
    ref: 'v2.1.0',
  };

  it('takes the sha, the ref and the author date from the checkout', async () => {
    expect(await execFrom(checkout)).toEqual({
      sha: '82fe822a9d0c',
      ref: 'v2.1.0',
      date: '2026-07-14T09:12:00+02:00',
    });
    expect(git.commitDate).toHaveBeenCalledWith('/cache/x/sha-82fe822', '82fe822a9d0c');
  });

  it('drops a ref that is the sha, and gives nothing for a local source', async () => {
    git.commitDate.mockResolvedValueOnce(undefined as never);
    expect(await execFrom({ ...checkout, ref: '82fe822' })).toEqual({ sha: '82fe822a9d0c' });
    expect(await execFrom({ ...checkout, sha: undefined })).toBeUndefined();
  });
});
