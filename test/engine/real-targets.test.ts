import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLock } from '../../src/core/lockfile.js';
import { saveManifest } from '../../src/core/manifest.js';
import type { Entity, Target, TargetId } from '../../src/core/types.js';
import { installEntities } from '../../src/engine/install.js';
import { syncManifest } from '../../src/engine/sync.js';
import { uninstallEntities } from '../../src/engine/uninstall.js';
import { readJsonFile } from '../../src/lib/fs.js';
import { removeDir, writeFiles } from '../support/sandbox.js';
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
    expect(r.outcomes[0]!.entry.files.map((f) => f.path).sort()).toEqual([
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

  it('an OpenCode instruction renamed to a case variant leaves no stale /instructions item', async () => {
    w = await world();
    const instruction = (name: string, body: string): Entity => ({
      kind: 'instruction',
      name,
      path: `instructions/${name}.md`,
      origin: 'a',
      def: { kind: 'instruction', instruction: { name, alwaysApply: true, body } },
    });
    let current = instruction('Style', 'Be terse.\n');
    w.deps.scan = async () => ({ entities: [current], warnings: [], detected: 'convention' });
    const opts = { scope: 'project' as const, targets: ['opencode' as const] };
    const listed = async () =>
      (await readJsonFile<{ instructions: string[] }>(join(w.sb.project, 'opencode.json')))
        .instructions;

    await writeFiles(w.origins.a, { 'instructions/Style.md': 'Be terse.\n' });
    await installEntities(w.ctx, [{ kind: 'instruction', spec: 'Style' }], opts, w.deps);
    expect(await listed()).toEqual(['.opencode/instructions/Style.md']);

    // The origin renames the file to a case variant (and edits it): one item, the new path.
    await rm(join(w.origins.a, 'instructions/Style.md'));
    await writeFiles(w.origins.a, { 'instructions/style.md': 'Be brief.\n' });
    current = instruction('style', 'Be brief.\n');
    const r = await installEntities(w.ctx, [{ kind: 'instruction', spec: 'style' }], opts, w.deps);
    expect(r.failures).toEqual([]);
    expect(r.outcomes.map((o) => [o.entry.name, o.status])).toEqual([['style', 'updated']]);
    expect(await listed()).toEqual(['.opencode/instructions/style.md']);
    // One file: on a case-insensitive filesystem the old spelling may stay, as the same file.
    const dir = join(w.sb.project, '.opencode/instructions');
    expect((await readdir(dir)).map((f) => f.toLowerCase())).toEqual(['style.md']);
    expect(await readFile(join(dir, 'style.md'), 'utf8')).toContain('Be brief.');
  });

  it('a hook replaced by one of the same name keeps the asset files the new install wrote', async () => {
    w = await world();
    w.ctx.config.origins.push({ alias: 'b', type: 'local', path: w.origins.b });
    const raw = {
      hooks: {
        PostToolUse: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/run.sh' }] }],
      },
    };
    const hook = (origin: string): Entity => ({
      kind: 'hook',
      name: 'fmt',
      path: 'fmt/hooks/hooks.json',
      origin,
      def: { kind: 'hook', hooks: { name: 'fmt', dialect: 'claude', raw, pluginRootRel: 'fmt' } },
    });
    w.deps.scan = async (_root, spec) => ({
      entities: [hook(spec.alias)],
      warnings: [],
      detected: 'convention',
    });
    const hooksJson = JSON.stringify(raw);
    await writeFiles(w.origins.a, {
      'fmt/hooks/hooks.json': hooksJson,
      'fmt/run.sh': 'echo a\n',
      'fmt/old.sh': 'old\n',
    });
    await writeFiles(w.origins.b, { 'fmt/hooks/hooks.json': hooksJson, 'fmt/run.sh': 'echo b\n' });
    const opts = { scope: 'project' as const, targets: ['claude' as const] };
    w.ctx.flags.yes = true;
    await installEntities(w.ctx, [{ kind: 'hook', spec: 'fmt@a' }], opts, w.deps);
    const assets = join(w.sb.project, '.palm/hooks/fmt');
    expect(await readFile(join(assets, 'old.sh'), 'utf8')).toBe('old\n');

    const r = await installEntities(w.ctx, [{ kind: 'hook', spec: 'fmt@b' }], opts, w.deps);
    expect(r.failures).toEqual([]);
    expect(r.outcomes.map((o) => [o.entry.origin, o.status])).toEqual([['b', 'updated']]);
    expect(await readFile(join(assets, 'run.sh'), 'utf8')).toBe('echo b\n');
    expect(await readFile(join(assets, 'hooks/hooks.json'), 'utf8')).toBe(hooksJson);
    expect(existsSync(join(assets, 'old.sh'))).toBe(false); // only the old install had it
  });

  it('writes global installs under the temp home only', async () => {
    w = await world();
    const r = await installEntities(
      w.ctx,
      [{ kind: 'agent', spec: 'dual' }],
      { scope: 'global', targets: ['claude'] },
      w.deps,
    );
    expect(r.outcomes[0]!.entry.files.map((f) => f.path)).toEqual([
      join(w.sb.home, '.claude/agents/dual.md'),
    ]);
  });
});
