/**
 * The second persona-rerun rulings for src/exec (scratchpad FINDINGS-v3.md), one test per id.
 */
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Closure, Entity } from '../../src/core/types.js';
import { inPlaceClosure } from '../../src/exec/closure.js';
import { withScriptReads } from '../../src/exec/reads.js';
import { previousStaysActive } from '../../src/exec/trust.js';
import { closureTree, execUnitOf } from '../../src/exec/units.js';

async function tree(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'palm-exec-v3-')));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
  return root;
}

function hookEntity(name: string, path: string, paths: string[], raw: unknown = {}): Entity {
  return {
    kind: 'hook',
    name,
    source: 'kit',
    path,
    def: {
      kind: 'hook',
      hooks: {
        name,
        dialect: 'claude',
        raw,
        pluginRootRel: dirname(path),
        references: [],
        closure: { paths },
        promptHooks: [],
      },
    },
  };
}

function closureOf(entity: Entity): Closure {
  return entity.def.kind === 'hook' ? entity.def.hooks.closure : { paths: [] };
}

const lines = (...l: string[]) => `${l.join('\n')}\n`;

describe("E1' reads through the script's own directory", () => {
  it("E1' ${SCRIPT_DIR}/plugin.json is a read even though the copy leaves plugin.json out", async () => {
    const root = await tree({
      'hooks/session/hooks.json': '{}',
      'hooks/session/start.sh': lines(
        '#!/usr/bin/env bash',
        'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
        'name=$(grep -o "name" "${SCRIPT_DIR}/plugin.json" || echo unknown)',
      ),
      'hooks/session/plugin.json': '{"name": "team-hooks"}\n',
    });
    const entity = hookEntity('session', 'hooks/session/hooks.json', ['hooks/session']);
    const { entity: read, warnings } = await withScriptReads(entity, root);
    expect(closureOf(read).reads).toEqual(['hooks/session/plugin.json']);
    expect(warnings).toEqual([]);
    const files = await inPlaceClosure(root, closureOf(read));
    expect(files.map((f) => f.path)).toContain('hooks/session/plugin.json');
  });

  it("E1' the long dirname forms, quoted directory expressions and ${BASH_SOURCE[0]%/*} resolve", async () => {
    const root = await tree({
      'hooks/h/hooks.json': '{}',
      'hooks/h/run.sh': lines(
        'DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )',
        'cat "$DIR/../../data/a.txt"',
        'cat "$(dirname "$0")"/../../data/b.txt',
        'source "${BASH_SOURCE[0]%/*}/lib/c.sh"',
        'cat "${SCRIPT_HOME}/unknown.txt"',
      ),
      'data/a.txt': 'a\n',
      'data/b.txt': 'b\n',
      'hooks/h/lib/c.sh': 'echo c\n',
    });
    const entity = hookEntity('h', 'hooks/h/hooks.json', ['hooks/h/hooks.json', 'hooks/h/run.sh']);
    const { entity: read } = await withScriptReads(entity, root);
    expect(closureOf(read).reads).toEqual(['data/a.txt', 'data/b.txt', 'hooks/h/lib/c.sh']);
  });
});

describe('Sofia S3 O10 in-repo reads outside the source folder are hashed in place', () => {
  const GUARD = lines(
    '#!/usr/bin/env bash',
    '. "$CLAUDE_PROJECT_DIR/tools/helpers.sh"',
    '. "$(dirname "$0")/../../../../tools/more.sh"',
    'echo guard',
  );

  async function project() {
    const root = await tree({
      'agent-kit/hooks/guard/hooks.json': '{}',
      'agent-kit/hooks/guard/scripts/guard.sh': GUARD,
      'tools/helpers.sh': 'echo helper-v1\n',
      'tools/more.sh': 'echo more-v1\n',
      '.agents/hooks/main.go': 'package main\n',
    });
    return { root, kit: join(root, 'agent-kit') };
  }

  const guard = (raw: unknown = {}) =>
    hookEntity('guard', 'hooks/guard/hooks.json', ['hooks/guard'], raw);

  it('Sofia S3 a helper sourced through $CLAUDE_PROJECT_DIR or $(dirname "$0")/.. is hashed; editing it moves the hash', async () => {
    const { root, kit } = await project();
    const { entity, warnings } = await withScriptReads(guard(), kit, { worktree: root });
    expect(closureOf(entity).reads).toEqual(['../tools/helpers.sh', '../tools/more.sh']);
    expect(warnings).toEqual([]);
    const before = closureTree(await inPlaceClosure(kit, closureOf(entity)));
    await writeFile(join(root, 'tools/helpers.sh'), 'echo helper-v2-changed-behaviour\n');
    const after = closureTree(await inPlaceClosure(kit, closureOf(entity)));
    expect(after).not.toBe(before);
  });

  it('Sofia S3 a git source warns about a read leaving it and never guesses project files', async () => {
    const { kit } = await project();
    const { entity, warnings } = await withScriptReads(guard(), kit);
    expect(closureOf(entity).reads).toBeUndefined();
    expect(warnings).toEqual([
      'hook guard: hooks/guard/scripts/guard.sh reads ../tools/more.sh, outside the source; palm does not copy it',
    ]);
  });

  it('Sofia S3 an in-repo read outside the worktree warns that palm does not hash it', async () => {
    const { root, kit } = await project();
    const script = lines('cat "$(dirname "$0")/../../../../../outside.txt"');
    await writeFile(join(kit, 'hooks/guard/scripts/guard.sh'), script);
    const { warnings } = await withScriptReads(guard(), kit, { worktree: root });
    expect(warnings).toEqual([
      'hook guard: hooks/guard/scripts/guard.sh reads ../../outside.txt, outside the source; palm does not hash it',
    ]);
  });

  it('O10 a project file an in-repo hook command runs is hashed with the closure', async () => {
    const { root, kit } = await project();
    await writeFile(join(kit, 'hooks/guard/scripts/guard.sh'), 'echo guard\n');
    const raw = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'go run .agents/hooks/main.go' }] }] },
    };
    const { entity } = await withScriptReads(guard(raw), kit, { worktree: root });
    expect(closureOf(entity).reads).toEqual(['../.agents/hooks/main.go']);
    const files = await inPlaceClosure(kit, closureOf(entity));
    expect(files.map((f) => f.path)).toContain('../.agents/hooks/main.go');
  });
});

describe("E2' declining a changed in-repo program", () => {
  it("E2' the line says the changed script is live already and how to disable it", async () => {
    const hash = `sha256:${'1b9e04c2'.padEnd(64, '0')}`;
    const entry = {
      kind: 'hook' as const,
      name: 'guard',
      source: './agent-kit',
      path: 'hooks/guard/hooks.json',
      content: '',
      render: {},
      files: [],
      exec: { commands: [], hash },
      trust: [hash],
    };
    const root = await tree({ 'hooks/guard/hooks.json': '{}' });
    const entity = hookEntity('guard', 'hooks/guard/hooks.json', ['hooks/guard']);
    const unit = execUnitOf(
      entity,
      {},
      {
        root: 'agent-kit',
        inPlace: true,
        files: await inPlaceClosure(root, { paths: ['hooks/guard'] }),
        abs: root,
      },
    );
    expect(previousStaysActive(entry, 'project', unit)).toBe(
      'hook guard: the changed script is already live (it runs in place from your repository); palm remove ./agent-kit hook:guard disables it',
    );
    expect(previousStaysActive(entry, 'project')).toContain('previous version stays active');
  });
});
