import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLock } from '../../src/core/lockfile.js';
import { saveManifest } from '../../src/core/manifest.js';
import type { Target, TargetId } from '../../src/core/types.js';
import { installEntities } from '../../src/engine/install.js';
import { syncManifest } from '../../src/engine/sync.js';
import { uninstallEntities } from '../../src/engine/uninstall.js';
import { readJsonFile } from '../../src/lib/fs.js';
import { removeDir } from '../support/sandbox.js';
import { makeWorld, type World } from './world.js';

/** Engine + the real targets module (fake scanner, temp project and home). */
describe('engine with real targets', () => {
  let w: World;
  let getTarget: (id: TargetId) => Target;
  afterEach(async () => removeDir(w.sb.root));

  async function world(): Promise<World> {
    const mod = await import('../../src/targets/index.js');
    getTarget = mod.getTarget;
    const created = await makeWorld();
    created.deps.getTarget = getTarget;
    return created;
  }

  it('installs, reinstalls and uninstalls a skill for claude + codex', async () => {
    w = await world();
    const opts = { scope: 'project' as const, targets: ['claude' as const, 'codex' as const] };
    const r = await installEntities(w.ctx, [{ kind: 'skill', spec: 'wayfinder' }], opts, w.deps);
    expect(r.outcomes[0]!.status).toBe('installed');
    expect(r.outcomes[0]!.entry.files.sort()).toEqual([
      '.agents/skills/wayfinder/SKILL.md',
      '.claude/skills/wayfinder/SKILL.md',
    ]);
    expect(
      await readFile(join(w.sb.project, '.claude/skills/wayfinder/SKILL.md'), 'utf8'),
    ).toContain('wayfinder A');

    w.ctx.flags.force = true;
    const again = await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'wayfinder' }],
      opts,
      w.deps,
    );
    expect(again.outcomes[0]!.status).toBe('updated');
    expect(existsSync(join(w.sb.project, '.claude/skills/wayfinder/SKILL.md'))).toBe(true);
    w.ctx.flags.force = false;

    await uninstallEntities(w.ctx, [{ name: 'wayfinder' }], { scope: 'project' }, w.deps);
    expect(existsSync(join(w.sb.project, '.claude/skills/wayfinder'))).toBe(false);
    expect(existsSync(join(w.sb.project, '.agents/skills/wayfinder'))).toBe(false);
  });

  it('merges an MCP server, replaces it on change without duplicates, and unmerges it', async () => {
    w = await world();
    const file = join(w.sb.project, 'palm.yaml');
    await saveManifest(file, {
      targets: ['claude'],
      mcp: [{ name: 'fs', command: 'npx', args: ['a'] }],
    });
    await syncManifest(w.ctx, { scope: 'project', prune: false }, w.deps);
    type McpJson = { mcpServers: { fs: { args: string[] } } };
    const read = () => readJsonFile<McpJson>(join(w.sb.project, '.mcp.json'));
    expect((await read()).mcpServers.fs.args).toEqual(['a']);

    await saveManifest(file, {
      targets: ['claude'],
      mcp: [{ name: 'fs', command: 'npx', args: ['b'] }],
    });
    const r = await syncManifest(w.ctx, { scope: 'project', prune: false }, w.deps);
    expect(r.outcomes[0]!.status).toBe('updated');
    expect((await read()).mcpServers.fs.args).toEqual(['b']);
    const lock = await loadLock(join(w.sb.project, 'palm.lock.yaml'));
    expect(lock.entries[0]!.merged).toHaveLength(1);

    await uninstallEntities(w.ctx, [{ kind: 'mcp', name: 'fs' }], { scope: 'project' }, w.deps);
    expect(existsSync(join(w.sb.project, '.mcp.json'))).toBe(false); // palm wrote it alone: removed once empty
  });

  it('writes global installs under the temp home only', async () => {
    w = await world();
    const r = await installEntities(
      w.ctx,
      [{ kind: 'agent', spec: 'dual' }],
      { scope: 'global', targets: ['claude'] },
      w.deps,
    );
    expect(r.outcomes[0]!.entry.files).toEqual([join(w.sb.home, '.claude/agents/dual.md')]);
  });
});
