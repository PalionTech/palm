import './fakes.js';

import { describe, expect, it } from 'vitest';
import { installFromSource } from '../../src/engine/install.js';
import { describeEntity, listInstalled, loadCost, ownerOfPath } from '../../src/engine/query.js';
import { makeWorld, type World } from './world.js';

const KIT = {
  'skills/tdd/SKILL.md': 'Test first.\n',
  'mcp.json': JSON.stringify({
    docs: {
      transport: 'http',
      url: 'https://docs.example/mcp',
      headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
    },
  }),
};

async function world(): Promise<World> {
  const w = await makeWorld({ targets: ['claude', 'cursor'] });
  const url = await w.remote('kit', { 'v1.0.0': KIT });
  await installFromSource(
    w.ctx,
    { source: url, names: [{ name: 'tdd' }, { kind: 'mcp', name: 'docs' }] },
    { scope: 'project' },
    w.deps,
  );
  return w;
}

describe('queries', () => {
  it('lists installed entries with their lock source, filtered by kind, name and source', async () => {
    const w = await world();
    const all = await listInstalled(w.ctx, 'project');
    expect(all.map((r) => r.entry.name).sort()).toEqual(['docs', 'tdd']);
    expect(all[0]).toMatchObject({ layer: 'team', source: { url: 'https://example.com/kit.git' } });
    expect(
      (await listInstalled(w.ctx, 'project', { kind: 'mcp' })).map((r) => r.entry.name),
    ).toEqual(['docs']);
    expect(await listInstalled(w.ctx, 'project', { source: 'other' })).toEqual([]);
  });

  it('describes an entity: files per harness, what selected it, the variables it needs', async () => {
    const w = await world();
    const info = await describeEntity(
      w.ctx,
      { kind: 'mcp', name: 'docs' },
      { scope: 'project' },
      w.deps,
    );
    expect(info.selectedBy).toBe('manifest');
    expect(info.files).toEqual({ claude: ['.claude/mcp.json'], cursor: ['.cursor/mcp.json'] });
    expect(info.secrets).toEqual([{ name: 'DOCS_TOKEN', set: false }]);
    expect(info.entity?.name).toBe('docs');
    await expect(
      describeEntity(w.ctx, { name: 'nope' }, { scope: 'project' }, w.deps),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND', hint: 'palm get' });
  });

  it('finds the entry that wrote a path, holds files inside it, or merged into it', async () => {
    const w = await world();
    expect(
      (await ownerOfPath(w.ctx, '.claude/skills/tdd/SKILL.md', { scope: 'project' })).map((o) => [
        o.entry.name,
        o.match,
      ]),
    ).toEqual([['tdd', 'file']]);
    expect(
      (await ownerOfPath(w.ctx, '.claude/skills', { scope: 'project' })).map((o) => o.match),
    ).toEqual(['inside']);
    expect(
      (await ownerOfPath(w.ctx, '.cursor/mcp.json', { scope: 'project' })).map((o) => [
        o.entry.name,
        o.match,
      ]),
    ).toEqual([['docs', 'merged']]);
    expect(await ownerOfPath(w.ctx, '/elsewhere', { scope: 'project' })).toEqual([]);
  });

  it('reserves the load-cost footer for 0.3', async () => {
    const w = await world();
    expect(await loadCost(w.ctx, 'project')).toEqual({});
  });
});
