import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { loadLock, saveLock } from '../../src/core/lockfile.js';
import { loadManifest, saveManifest } from '../../src/core/manifest.js';
import type { McpServerConfig } from '../../src/core/types.js';
import { installEntities } from '../../src/engine/install.js';
import { resolveTargets } from '../../src/engine/resolve-targets.js';
import { syncManifest } from '../../src/engine/sync.js';
import { readJsonFile } from '../../src/lib/fs.js';
import { removeDir } from '../support/sandbox.js';
import { makeWorld, type World } from './world.js';

async function realTargets(w: World): Promise<void> {
  w.deps.getTarget = (await import('../../src/targets/index.js')).getTarget;
}

describe('syncManifest', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('a range pin (#^1.2) satisfied by the locked tag (v1.3.0) is unchanged', async () => {
    w = await makeWorld();
    await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'tdd@a' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    const file = join(w.sb.project, 'palm.lock.yaml');
    const lock = await loadLock(file);
    lock.entries[0]!.ref = 'v1.3.0';
    await saveLock(file, lock);
    await saveManifest(join(w.sb.project, 'palm.yaml'), {
      targets: ['claude'],
      skills: ['tdd@a#^1.2'],
    });
    const deploys = w.calls.deploy.length;
    const r = await syncManifest(w.ctx, { scope: 'project', prune: false }, w.deps);
    expect(r.outcomes.map((o) => o.status)).toEqual(['unchanged']);
    expect(w.calls.deploy).toHaveLength(deploys);
  });
});

describe('lockfile v1 upgrade', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('a v1 lock loads, the next install re-renders its entries and writes v2 with hashes', async () => {
    w = await makeWorld();
    const file = join(w.sb.project, 'palm.lock.yaml');
    await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'tdd@a' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    await writeFile(
      file,
      [
        'version: 1',
        'entries:',
        '  - kind: skill',
        '    name: tdd',
        '    origin: a',
        '    path: skills/tdd',
        `    contentHash: ${(await loadLock(file)).entries[0]!.contentHash}`,
        '    installedAt: 2026-01-01T00:00:00.000Z',
        '    targets: [claude]',
        '    files: [.claude/skill/tdd.txt]',
        '',
      ].join('\n'),
    );
    await saveManifest(join(w.sb.project, 'palm.yaml'), { targets: ['claude'], skills: ['tdd@a'] });
    const r = await syncManifest(w.ctx, { scope: 'project', prune: false }, w.deps);
    expect(r.outcomes[0]).toMatchObject({ status: 'updated' });
    expect(r.outcomes[0]!.notes).toContain('re-rendered for this palm version');
    const text = await readFile(file, 'utf8');
    expect(text).toMatch(/^version: 2$/m);
    expect(text).not.toContain('installedAt');
    expect((await loadLock(file)).entries[0]).toMatchObject({
      transform: 1,
      files: [{ path: '.claude/skill/tdd.txt', hash: expect.stringMatching(/^sha256:/) }],
    });
  });
});

describe('machine-independent targets', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('persists detected targets to palm.yaml (project), never to config.yaml (global)', async () => {
    w = await makeWorld({ detect: ['claude', 'cursor'] });
    const project = await resolveTargets(w.ctx, { scope: 'project', save: true }, w.deps);
    expect(project).toEqual(['claude', 'cursor']);
    expect((await loadManifest(join(w.sb.project, 'palm.yaml'))).targets).toEqual([
      'claude',
      'cursor',
    ]);
    expect(w.log.messages).toContainEqual({
      level: 'info',
      msg: 'saved targets claude, cursor to palm.yaml',
    });

    // the second developer detects something else, but gets the recorded set
    const other = await makeWorld({ detect: ['codex'] });
    other.ctx.paths.projectRoot = w.sb.project;
    expect(await resolveTargets(other.ctx, { scope: 'project', save: true }, other.deps)).toEqual([
      'claude',
      'cursor',
    ]);
    await removeDir(other.sb.root);

    // config.yaml `targets` would become every project's default: -g saves only --target.
    const logged = w.log.messages.length;
    await resolveTargets(w.ctx, { scope: 'global', save: true }, w.deps);
    expect((await loadConfig(w.ctx.paths)).targets).toBeUndefined();
    expect(w.log.messages.slice(logged).filter((m) => m.level === 'info')).toEqual([]);
    await resolveTargets(w.ctx, { scope: 'global', flag: ['codex'], save: true }, w.deps);
    expect((await loadConfig(w.ctx.paths)).targets).toEqual(['codex']);
  });

  it('shrinking targets removes the dropped harness files on the next install', async () => {
    w = await makeWorld();
    await realTargets(w);
    w.ctx.flags.yes = true;
    const manifest = join(w.sb.project, 'palm.yaml');
    await saveManifest(manifest, {
      targets: ['claude', 'codex'],
      skills: ['wayfinder@a'],
      mcp: [{ name: 'fs', command: 'npx', args: ['server-fs'] }],
    });
    await syncManifest(w.ctx, { scope: 'project', prune: false }, w.deps);
    const at = (p: string) => join(w.sb.project, p);
    expect(existsSync(at('.agents/skills/wayfinder/SKILL.md'))).toBe(true);
    expect(await readFile(at('.codex/config.toml'), 'utf8')).toContain('[mcp_servers.fs]');

    await saveManifest(manifest, {
      targets: ['claude'],
      skills: ['wayfinder@a'],
      mcp: [{ name: 'fs', command: 'npx', args: ['server-fs'] }],
    });
    const r = await syncManifest(w.ctx, { scope: 'project', prune: false }, w.deps);
    expect(r.failures).toEqual([]);
    expect(r.outcomes.map((o) => [o.entry.name, o.status, o.entry.targets])).toEqual([
      ['wayfinder', 'updated', ['claude']],
      ['fs', 'updated', ['claude']],
    ]);
    expect(existsSync(at('.agents/skills/wayfinder'))).toBe(false);
    const toml = existsSync(at('.codex/config.toml'))
      ? await readFile(at('.codex/config.toml'), 'utf8')
      : '';
    expect(toml).not.toContain('mcp_servers');
    expect(existsSync(at('.claude/skills/wayfinder/SKILL.md'))).toBe(true);
    const mcp = await readJsonFile<{ mcpServers: Record<string, unknown> }>(at('.mcp.json'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['fs']);
    const lock = await loadLock(at('palm.lock.yaml'));
    for (const e of lock.entries) {
      expect(e.targets).toEqual(['claude']);
      expect(e.files.every((f) => !f.path.startsWith('.agents/'))).toBe(true);
      expect((e.merged ?? []).every((m) => !m.file.startsWith('.codex/'))).toBe(true);
    }
  });

  it('a transport change (url → command) leaves no stale url or headers', async () => {
    w = await makeWorld();
    await realTargets(w);
    w.ctx.flags.yes = true;
    const opts = { scope: 'project' as const, targets: ['claude' as const, 'codex' as const] };
    const http: McpServerConfig = {
      name: 'fs',
      transport: 'http',
      url: 'https://fs.example/mcp',
      headers: { 'X-Team': 'palm' },
    };
    await installEntities(w.ctx, [{ kind: 'mcp', spec: 'fs', adhocMcp: http }], opts, w.deps);
    const at = (p: string) => join(w.sb.project, p);
    expect(await readFile(at('.codex/config.toml'), 'utf8')).toContain('url');

    const stdio: McpServerConfig = { name: 'fs', transport: 'stdio', command: 'npx', args: ['x'] };
    const r = await installEntities(
      w.ctx,
      [{ kind: 'mcp', spec: 'fs', adhocMcp: stdio }],
      opts,
      w.deps,
    );
    expect(r.outcomes[0]!.status).toBe('updated');
    const json = await readJsonFile<{ mcpServers: { fs: Record<string, unknown> } }>(
      at('.mcp.json'),
    );
    expect(json.mcpServers.fs).toMatchObject({ command: 'npx', args: ['x'] });
    expect(json.mcpServers.fs).not.toHaveProperty('url');
    expect(json.mcpServers.fs).not.toHaveProperty('headers');
    const toml = await readFile(at('.codex/config.toml'), 'utf8');
    expect(toml).toContain('command = "npx"');
    expect(toml).not.toMatch(/url|X-Team|http_headers/);
    const lock = await loadLock(at('palm.lock.yaml'));
    expect(lock.entries[0]!.merged).toHaveLength(2);
  });
});
