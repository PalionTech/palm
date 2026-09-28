import { describe, expect, it } from 'vitest';
import { type Entity, type LockEntry, TRANSFORM_VERSION } from '../../src/core/types.js';
import { type DeploymentInput, planDeployment } from '../../src/engine/deploy.js';
import { executablesOf } from '../../src/engine/install.js';
import { type PlanItem, scopedMcpKey } from '../../src/engine/plan.js';

const entity: Entity = {
  kind: 'skill',
  name: 'tdd',
  path: 'skills/tdd',
  origin: 'a',
  def: { kind: 'skill', skill: { name: 'tdd', description: 'x' } },
};

const entry = (over: Partial<LockEntry> = {}): LockEntry => ({
  kind: 'skill',
  name: 'tdd',
  origin: 'a',
  path: 'skills/tdd',
  contentHash: 'h1',
  transform: TRANSFORM_VERSION,
  targets: ['claude', 'codex'],
  files: [{ path: '.claude/skills/tdd/SKILL.md', hash: 'f' }],
  ...over,
});

const item: PlanItem = { entity, source: {}, direct: true };

function input(over: Partial<DeploymentInput> = {}): DeploymentInput {
  return {
    item,
    hash: 'h1',
    existing: entry(),
    others: [],
    intact: true,
    targets: ['claude', 'codex'],
    exact: false,
    force: false,
    ...over,
  };
}

describe('planDeployment (pure)', () => {
  it('unchanged when the lock realises the item on every target', () => {
    expect(planDeployment(input())).toMatchObject({ action: 'unchanged' });
  });

  it('adds a missing target incrementally, keeping the existing install', () => {
    const d = planDeployment(
      input({ targets: ['cursor'], existing: entry({ targets: ['claude'] }) }),
    );
    expect(d).toMatchObject({ action: 'deploy', to: ['cursor'], previous: [], status: 'updated' });
    expect(d.action === 'deploy' && d.carry?.targets).toEqual(['claude']);
  });

  it('full redeploy replacing the previous install: new content, older transform, missing files, --force', () => {
    for (const over of [
      { hash: 'h2' },
      { existing: entry({ transform: 0 }) },
      { intact: false },
      { force: true },
    ]) {
      const d = planDeployment(input(over));
      expect(d).toMatchObject({ action: 'deploy', to: ['claude', 'codex'], status: 'updated' });
      expect(d.action === 'deploy' && d.previous).toHaveLength(1);
    }
    expect(planDeployment(input({ existing: entry({ transform: 0 }) })).notes).toContain(
      're-rendered for this palm version',
    );
  });

  it('exact targets contract: the dropped target is not deployed and the note says so', () => {
    const d = planDeployment(input({ targets: ['claude'], exact: true }));
    expect(d).toMatchObject({ action: 'deploy', to: ['claude'], notes: ['removed from codex'] });
    // not exact: installing with fewer targets keeps the others
    expect(planDeployment(input({ targets: ['claude'] }))).toMatchObject({ action: 'unchanged' });
  });

  it('another origin copy is replaced; the owned keys cover files and merged pointers', () => {
    const other = entry({
      origin: 'b',
      merged: [{ file: '.mcp.json', pointer: '/mcpServers/tdd', value: {} }],
    });
    const d = planDeployment(input({ existing: undefined, others: [other] }));
    expect(d).toMatchObject({
      action: 'deploy',
      status: 'updated',
      owned: ['.claude/skills/tdd/SKILL.md', '.mcp.json#/mcpServers/tdd'],
      notes: ['replaces skill tdd from b'],
    });
    expect(planDeployment(input({ existing: undefined }))).toMatchObject({
      action: 'deploy',
      status: 'installed',
      previous: [],
    });
  });

  it('keeps a dependency installed another way', () => {
    const keep = entry({ via: 'agent:x' });
    expect(planDeployment(input({ item: { ...item, keep } }))).toEqual({
      action: 'keep',
      entry: keep,
      notes: ['already installed (agent:x)'],
    });
  });
});

describe('naming and consent helpers', () => {
  it('scopes a registry key by its namespace', () => {
    expect(scopedMcpKey('@b/mcp')).toBe('b-mcp');
    expect(scopedMcpKey('io.github.acme/weather')).toBe('acme-weather');
    expect(scopedMcpKey('weather')).toBe('weather');
  });

  it('lists what an entity would run: hook commands and stdio MCP servers only', () => {
    const mcp = (transport: 'stdio' | 'http'): Entity => ({
      kind: 'mcp',
      name: 'fs',
      path: 'fs',
      origin: 'adhoc',
      def: { kind: 'mcp', mcp: { name: 'fs', transport, command: 'npx', args: ['-y', 'fs'] } },
    });
    expect(executablesOf(mcp('stdio'))).toEqual(['mcp fs: npx -y fs']);
    expect(executablesOf(mcp('http'))).toEqual([]);
    expect(executablesOf(entity)).toEqual([]);
    const cursorHook: Entity = {
      kind: 'hook',
      name: 'guard',
      path: 'hooks.json',
      origin: 'a',
      def: {
        kind: 'hook',
        hooks: {
          name: 'guard',
          dialect: 'cursor',
          raw: { version: 1, hooks: { beforeShellExecution: [{ command: './guard.sh' }] } },
        },
      },
    };
    expect(executablesOf(cursorHook)).toEqual([
      'hook guard (cursor): beforeShellExecution → ./guard.sh',
    ]);
  });
});
