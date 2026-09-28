import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLock } from '../../src/core/lockfile.js';
import { saveManifest } from '../../src/core/manifest.js';
import type { EngineDeps, Entity, McpServerConfig, ScanResult } from '../../src/core/types.js';
import { installEntities, requestInstallStop } from '../../src/engine/install.js';
import { applyUpdate, planExecutables, planUpdate } from '../../src/engine/update.js';
import { fakeUI, makeContext } from '../support/fakes.js';
import { removeDir } from '../support/sandbox.js';
import { makeWorld, type World } from './world.js';

const PROJECT = { scope: 'project' as const, targets: ['claude' as const] };

const FS_MCP: McpServerConfig = {
  name: 'fs',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server-fs'],
};

const lockOf = (w: World) => loadLock(join(w.sb.project, 'palm.lock.yaml'));

/** The world's scanner plus extra entities for origin `a`. */
function withEntities(w: World, extra: Entity[]): void {
  const scan = w.deps.scan!;
  w.deps.scan = async (root, spec): Promise<ScanResult> => {
    const r = await scan(root, spec);
    if (spec.alias !== 'a') return r;
    return { ...r, entities: [...r.entities, ...extra.map((e) => ({ ...e, origin: 'a' }))] };
  };
}

const HOOK: Entity = {
  kind: 'hook',
  name: 'fmt',
  path: 'skills/tdd',
  origin: 'a',
  def: {
    kind: 'hook',
    hooks: {
      name: 'fmt',
      dialect: 'claude',
      raw: {
        hooks: {
          PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: './fmt.sh' }] }],
        },
      },
    },
  },
};

function recordConfirms(w: World, answer = true): string[] {
  const asked: string[] = [];
  w.ui.confirm = async (message: string) => {
    asked.push(message);
    return answer;
  };
  return asked;
}

describe('edit-safe overwrite (lockfile v2 hashes)', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('refuses to overwrite a file changed since palm wrote it, goes on with the rest, --force overwrites', async () => {
    w = await makeWorld();
    await installEntities(
      w.ctx,
      [
        { kind: 'skill', spec: 'tdd' },
        { kind: 'skill', spec: 'wayfinder' },
      ],
      PROJECT,
      w.deps,
    );
    const tddFile = join(w.sb.project, '.claude/skill/tdd.txt');
    await writeFile(tddFile, 'my own notes');
    await writeFile(join(w.origins.a, 'skills/tdd/SKILL.md'), 'tdd v2\n');
    await writeFile(join(w.origins.a, 'skills/wayfinder/SKILL.md'), 'wayfinder v2\n');
    const before = (await lockOf(w)).entries.find((e) => e.name === 'tdd')!;

    const r = await installEntities(
      w.ctx,
      [
        { kind: 'skill', spec: 'tdd' },
        { kind: 'skill', spec: 'wayfinder' },
      ],
      PROJECT,
      w.deps,
    );
    expect(r.outcomes.map((o) => [o.entry.name, o.status])).toEqual([
      ['tdd', 'failed'],
      ['wayfinder', 'updated'],
    ]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ kind: 'skill', name: 'tdd', code: 'E_CONFLICT' });
    expect(r.failures[0]!.message).toContain(
      '.claude/skill/tdd.txt changed since palm installed it',
    );
    expect(r.failures[0]!.hint).toContain('--force');
    expect(await readFile(tddFile, 'utf8')).toBe('my own notes');
    // the lock still describes the old install of tdd
    expect((await lockOf(w)).entries.find((e) => e.name === 'tdd')).toEqual(before);

    w.ctx.flags.force = true;
    const forced = await installEntities(w.ctx, [{ kind: 'skill', spec: 'tdd' }], PROJECT, w.deps);
    expect(forced.failures).toEqual([]);
    expect(forced.outcomes[0]!.status).toBe('updated');
    expect(await readFile(tddFile, 'utf8')).not.toBe('my own notes');
  });
});

describe('transactions: persist after every item, SIGINT, crash', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('a crash on the second item leaves the first one in the lock', async () => {
    w = await makeWorld();
    w.deps.resolveSecrets = async () => {
      throw new Error('keychain exploded');
    };
    await expect(
      installEntities(
        w.ctx,
        [
          { kind: 'skill', spec: 'tdd' },
          { kind: 'mcp', spec: 'fs', adhocMcp: FS_MCP },
        ],
        PROJECT,
        w.deps,
      ),
    ).rejects.toThrow('keychain exploded');
    const lock = await lockOf(w);
    expect(lock.entries.map((e) => e.name)).toEqual(['tdd']);
  });

  it('SIGINT stops after the current item, persists it, and throws E_CANCELLED', async () => {
    w = await makeWorld();
    const inner = w.deps.getTarget!;
    w.deps.getTarget = (id) => {
      const t = inner(id);
      return {
        ...t,
        deploy: async (input) => {
          const res = await t.deploy(input);
          requestInstallStop(); // what the SIGINT handler does
          return res;
        },
      };
    };
    const err = await installEntities(
      w.ctx,
      [
        { kind: 'skill', spec: 'tdd' },
        { kind: 'skill', spec: 'wayfinder' },
      ],
      PROJECT,
      w.deps,
    ).catch((e) => e);
    expect(err).toMatchObject({ code: 'E_CANCELLED' });
    expect(err.message).toContain('Interrupted after 1 of 2');
    expect(w.calls.deploy.map((c) => c.input.entity.name)).toEqual(['tdd']);
    expect((await lockOf(w)).entries.map((e) => e.name)).toEqual(['tdd']);
    const m = await readFile(join(w.sb.project, 'palm.yaml'), 'utf8');
    expect(m).toContain('tdd@a');
    expect(m).not.toContain('wayfinder');
  });

  it('removes the previous install only after the new deploy succeeded', async () => {
    w = await makeWorld({ failFor: [] });
    await installEntities(w.ctx, [{ kind: 'skill', spec: 'tdd' }], PROJECT, w.deps);
    await writeFile(join(w.origins.a, 'skills/tdd/SKILL.md'), 'tdd v2\n');
    const inner = w.deps.getTarget!;
    w.deps.getTarget = (id) => ({
      ...inner(id),
      deploy: async () => {
        throw new Error('disk full');
      },
    });
    const r = await installEntities(w.ctx, [{ kind: 'skill', spec: 'tdd' }], PROJECT, w.deps);
    expect(r.outcomes[0]!.status).toBe('failed');
    expect(r.failures[0]).toMatchObject({
      target: 'claude',
      code: 'E_INTERNAL',
      message: 'disk full',
    });
    expect(w.calls.undeploy).toEqual([]);
    expect(existsSync(join(w.sb.project, '.claude/skill/tdd.txt'))).toBe(true);
    expect((await lockOf(w)).entries[0]!.targets).toEqual(['claude']);
  });
});

describe('executable consent', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('asks once for every hook and stdio MCP server, listing them', async () => {
    w = await makeWorld();
    withEntities(w, [HOOK]);
    const asked = recordConfirms(w);
    await installEntities(
      w.ctx,
      [
        { kind: 'hook', spec: 'fmt' },
        { kind: 'mcp', spec: 'fs', adhocMcp: FS_MCP },
        { kind: 'mcp', spec: 'io.github.acme/weather' },
        { kind: 'skill', spec: 'tdd' },
      ],
      PROJECT,
      w.deps,
    );
    expect(asked).toEqual(['Install and allow these to run?']);
    const info = w.log.messages.filter((m) => m.level === 'info').map((m) => m.msg);
    expect(info).toContain('This install adds 3 commands that run on your machine:');
    expect(info).toContain('  hook fmt (claude): PostToolUse → ./fmt.sh');
    expect(info).toContain('  mcp fs: npx -y server-fs');
    expect(info).toContain('  mcp weather: npx -y @acme/weather@1.2.0');

    // unchanged on a second run: not asked again
    await installEntities(w.ctx, [{ kind: 'mcp', spec: 'fs', adhocMcp: FS_MCP }], PROJECT, w.deps);
    expect(asked).toHaveLength(1);
  });

  it('declining cancels before anything is written', async () => {
    w = await makeWorld();
    recordConfirms(w, false);
    await expect(
      installEntities(
        w.ctx,
        [
          { kind: 'skill', spec: 'tdd' },
          { kind: 'mcp', spec: 'fs', adhocMcp: FS_MCP },
        ],
        PROJECT,
        w.deps,
      ),
    ).rejects.toMatchObject({ code: 'E_CANCELLED' });
    expect(w.calls.deploy).toEqual([]);
    expect(existsSync(join(w.sb.project, 'palm.lock.yaml'))).toBe(false);
  });

  it('non-interactive runs need --yes; text entities are never gated', async () => {
    w = await makeWorld({ ui: fakeUI({ interactive: false }) });
    const err = await installEntities(
      w.ctx,
      [{ kind: 'mcp', spec: 'fs', adhocMcp: FS_MCP }],
      PROJECT,
      w.deps,
    ).catch((e) => e);
    expect(err).toMatchObject({ code: 'E_NON_INTERACTIVE' });
    expect(err.hint).toContain('--yes');
    expect(w.calls.deploy).toEqual([]);

    const text = await installEntities(
      w.ctx,
      [
        { kind: 'agent', spec: 'dual' },
        { kind: 'skill', spec: 'tdd' },
      ],
      PROJECT,
      w.deps,
    );
    expect(text.outcomes.map((o) => o.status)).toEqual(['installed', 'installed']);

    w.ctx.flags.yes = true;
    const yes = await installEntities(
      w.ctx,
      [{ kind: 'mcp', spec: 'fs', adhocMcp: FS_MCP }],
      PROJECT,
      w.deps,
    );
    expect(yes.outcomes[0]!.status).toBe('installed');
  });

  it('does not ask again about executables the caller already allowed (consented)', async () => {
    w = await makeWorld();
    withEntities(w, [HOOK]);
    const asked = recordConfirms(w);
    const requests = [
      { kind: 'hook' as const, spec: 'fmt' },
      { kind: 'mcp' as const, spec: 'fs', adhocMcp: FS_MCP },
    ];
    const consented = ['mcp fs: npx -y server-fs'];
    await installEntities(w.ctx, requests, { ...PROJECT, consented }, w.deps);
    expect(asked).toHaveLength(1);
    const info = w.log.messages.filter((m) => m.level === 'info').map((m) => m.msg);
    expect(info).toContain('This install adds a command that runs on your machine:');
    expect(info).not.toContain('  mcp fs: npx -y server-fs');

    const all = ['hook fmt (claude): PostToolUse → ./fmt.sh', ...consented];
    await installEntities(
      w.ctx,
      [{ kind: 'hook', spec: 'fmt' }],
      { ...PROJECT, consented: all, targets: ['claude', 'codex'] },
      w.deps,
    );
    expect(asked).toHaveLength(1);
  });

  it('palm update lists what it would allow to run; its one confirmation covers the install', async () => {
    w = await makeWorld();
    const members: Array<{ kind: 'skill' | 'hook'; name: string }> = [
      { kind: 'skill', name: 'tdd' },
    ];
    const kit: Entity = {
      kind: 'plugin',
      name: 'kit',
      path: 'plugins/superpowers',
      origin: 'a',
      def: { kind: 'plugin', members },
    };
    withEntities(w, [kit, { ...HOOK, plugin: 'kit' }]);
    const asked = recordConfirms(w);
    await installEntities(w.ctx, [{ kind: 'plugin', spec: 'kit' }], PROJECT, w.deps);
    expect(asked).toEqual([]); // a skill only: nothing to allow

    members.push({ kind: 'hook', name: 'fmt' }); // the new version adds a hook
    await writeFile(join(w.origins.a, 'skills/tdd/SKILL.md'), '---\nname: tdd\n---\ntdd v2\n');
    const plan = await planUpdate(w.ctx, [], { scope: 'project' }, w.deps);
    const runs = ['hook fmt (claude): PostToolUse → ./fmt.sh'];
    expect(plan.items).toContainEqual(
      expect.objectContaining({ mark: 'added', kind: 'hook', name: 'fmt', executables: runs }),
    );
    expect(planExecutables(plan)).toEqual(runs);

    const r = await applyUpdate(w.ctx, plan, w.deps);
    expect(r.failures).toEqual([]);
    expect(r.outcomes.map((o) => [o.entry.name, o.status])).toContainEqual(['fmt', 'installed']);
    expect(asked).toEqual([]); // the update's confirmation was the consent
  });

  it('--dry-run lists the executables without asking', async () => {
    w = await makeWorld({ ui: fakeUI({ interactive: false }), flags: { dryRun: true } });
    const r = await installEntities(
      w.ctx,
      [{ kind: 'mcp', spec: 'fs', adhocMcp: FS_MCP }],
      PROJECT,
      w.deps,
    );
    expect(r.outcomes[0]!.status).toBe('installed');
    expect(w.log.messages.map((m) => m.msg)).toContain('  mcp fs: npx -y server-fs');
  });
});

describe('scope guards', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('refuses the home directory as a project unless it has palm.yaml or .git', async () => {
    w = await makeWorld();
    const ctx = await makeContext(w.sb, { cwd: w.sb.home });
    ctx.config.origins.push(...w.ctx.config.origins);
    const err = await installEntities(ctx, [{ kind: 'skill', spec: 'tdd' }], PROJECT, w.deps).catch(
      (e) => e,
    );
    expect(err).toMatchObject({
      code: 'E_USAGE',
      message: expect.stringContaining('run inside a project or use -g'),
    });
    // -g is fine from the home directory
    const g = await installEntities(
      ctx,
      [{ kind: 'skill', spec: 'tdd' }],
      { scope: 'global', targets: ['claude'] },
      w.deps,
    );
    expect(g.outcomes[0]!.status).toBe('installed');
    await mkdir(join(w.sb.home, '.git'));
    const marked = await makeContext(w.sb, { cwd: w.sb.home });
    marked.config.origins.push(...w.ctx.config.origins);
    const ok = await installEntities(
      marked,
      [{ kind: 'skill', spec: 'wayfinder' }],
      PROJECT,
      w.deps,
    );
    expect(ok.outcomes[0]!.status).toBe('installed');
  });

  it('a project origin may not reuse a user alias for another source', async () => {
    w = await makeWorld();
    await saveManifest(join(w.sb.project, 'palm.yaml'), {
      origins: [{ alias: 'a', type: 'local', path: join(w.sb.project, 'vendor/other') }],
    });
    const ctx = await makeContext(w.sb, { ui: w.ui, log: w.log });
    ctx.config.origins.push(...w.ctx.config.origins);
    const err = await installEntities(ctx, [{ kind: 'skill', spec: 'tdd' }], PROJECT, w.deps).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ code: 'E_CONFLICT' });
    expect(err.message).toContain('palm.yaml declares origin "a"');
    expect(err.message).toContain(w.origins.a);
  });

  it('local project origins must live inside the project; project origins are ignored under -g', async () => {
    w = await makeWorld({ origins: [] });
    await saveManifest(join(w.sb.project, 'palm.yaml'), {
      origins: [{ alias: 'outside', type: 'local', path: w.origins.b }],
    });
    const ctx = await makeContext(w.sb, { ui: w.ui, log: w.log });
    const err = await installEntities(
      ctx,
      [{ kind: 'skill', spec: 'shared@outside' }],
      PROJECT,
      w.deps,
    ).catch((e) => e);
    expect(err).toMatchObject({
      code: 'E_ORIGIN',
      message: expect.stringContaining('points outside the project'),
    });
    const global = await installEntities(
      ctx,
      [{ kind: 'skill', spec: 'shared@outside' }],
      { scope: 'global', targets: ['claude'] },
      w.deps,
    ).catch((e) => e);
    expect(global).toMatchObject({ code: 'E_ORIGIN', message: 'Unknown origin "outside"' });
  });
});

describe('hidden Unicode at install', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  const issue = (severity: string) =>
    ({
      kind: 'skill',
      name: 'sneaky',
      path: 'skills/tdd',
      origin: 'a',
      def: { kind: 'skill', skill: { name: 'sneaky', description: 'x' } },
      issues: [
        {
          code: 'hidden-unicode',
          severity,
          message: 'SKILL.md: 1 hidden character, first U+202E RIGHT-TO-LEFT OVERRIDE at line 3',
          file: 'SKILL.md',
        },
      ],
    }) as unknown as Entity;

  it('refuses a critical finding (hint: palm audit --strip or --force), warns on a warning', async () => {
    w = await makeWorld();
    withEntities(w, [issue('critical')]);
    const r = await installEntities(w.ctx, [{ kind: 'skill', spec: 'sneaky' }], PROJECT, w.deps);
    expect(r.outcomes[0]!.status).toBe('failed');
    expect(r.failures[0]!.message).toBe(
      'skill sneaky contains hidden Unicode that can smuggle instructions: SKILL.md: 1 hidden character, first U+202E RIGHT-TO-LEFT OVERRIDE at line 3',
    );
    expect(r.failures[0]!.hint).toContain('palm audit --strip');
    expect(r.failures[0]!.hint).toContain('--force');
    expect(w.calls.deploy).toEqual([]);

    w.ctx.flags.force = true;
    const forced = await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'sneaky' }],
      PROJECT,
      w.deps,
    );
    expect(forced.outcomes[0]!.status).toBe('installed');
    expect(forced.warnings.join('\n')).toContain('despite hidden Unicode');
  });

  it('installs with a warning for warning-level findings', async () => {
    w = await makeWorld();
    withEntities(w, [issue('warning')]);
    const r = await installEntities(w.ctx, [{ kind: 'skill', spec: 'sneaky' }], PROJECT, w.deps);
    expect(r.outcomes[0]!.status).toBe('installed');
    expect(r.warnings.join('\n')).toContain('invisible character');
  });
});

describe('scoped MCP names', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('@a/mcp and @b/mcp get distinct lock and config keys, kept on reinstall', async () => {
    w = await makeWorld();
    const cand = (name: string) => [
      {
        name,
        version: '1.0.0',
        config: {
          name: 'mcp',
          transport: 'http' as const,
          url: `https://${name.slice(1, 2)}.example/mcp`,
        },
      },
    ];
    w.deps.resolveRegistry = (async (name: string) => cand(name)) as EngineDeps['resolveRegistry'];
    const r = await installEntities(
      w.ctx,
      [
        { kind: 'mcp', spec: '@a/mcp', registry: '@a/mcp' },
        { kind: 'mcp', spec: '@b/mcp', registry: '@b/mcp' },
      ],
      PROJECT,
      w.deps,
    );
    expect(r.outcomes.map((o) => [o.entry.name, o.entry.path])).toEqual([
      ['mcp', '@a/mcp'],
      ['b-mcp', '@b/mcp'],
    ]);
    const deployed = w.calls.deploy.map(
      (c) => (c.input.entity.def as { mcp: McpServerConfig }).mcp.name,
    );
    expect(deployed).toEqual(['mcp', 'b-mcp']);
    expect((await lockOf(w)).entries.map((e) => e.name).sort()).toEqual(['b-mcp', 'mcp']);
    const manifest = await readFile(join(w.sb.project, 'palm.yaml'), 'utf8');
    expect(manifest).toContain('name: b-mcp');

    // a reinstall of @b/mcp stays b-mcp and replaces nothing of @a/mcp
    const again = await installEntities(
      w.ctx,
      [{ kind: 'mcp', spec: '@b/mcp', registry: '@b/mcp', mcpName: 'b-mcp' } as never],
      PROJECT,
      w.deps,
    );
    expect(again.outcomes[0]!.entry.name).toBe('b-mcp');
    expect(again.outcomes[0]!.status).toBe('unchanged');
    expect((await lockOf(w)).entries).toHaveLength(2);
  });
});
