import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLock } from '../../src/core/lockfile.js';
import { loadManifest } from '../../src/core/manifest.js';
import { installEntities } from '../../src/engine/install.js';
import { fakeUI } from '../support/fakes.js';
import { removeDir } from '../support/sandbox.js';
import { makeWorld, type World } from './world.js';

describe('installEntities', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  const lockOf = (world: World) => loadLock(join(world.sb.project, 'palm.lock.yaml'));
  const manifestOf = (world: World) => loadManifest(join(world.sb.project, 'palm.yaml'));

  it('installs a skill into every target and records lock + manifest', async () => {
    w = await makeWorld();
    const r = await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'wayfinder@a' }],
      { scope: 'project', targets: ['claude', 'codex'] },
      w.deps,
    );
    expect(r.outcomes).toHaveLength(1);
    expect(r.outcomes[0]!.status).toBe('installed');
    expect(existsSync(join(w.sb.project, '.claude/skill/wayfinder.txt'))).toBe(true);
    expect(existsSync(join(w.sb.project, '.codex/skill/wayfinder.txt'))).toBe(true);
    const input = w.calls.deploy[0]!.input;
    expect(input).toMatchObject({
      absPath: join(w.origins.a, 'skills/wayfinder'),
      originRoot: w.origins.a,
      scope: 'project',
      scopeRoot: w.sb.project,
      ownedFiles: [],
    });

    const lock = await lockOf(w);
    expect(lock.entries).toHaveLength(1);
    expect(lock.entries[0]).toMatchObject({
      kind: 'skill',
      name: 'wayfinder',
      origin: 'a',
      path: 'skills/wayfinder',
      transform: 1,
      targets: ['claude', 'codex'],
      files: [{ path: '.claude/skill/wayfinder.txt' }, { path: '.codex/skill/wayfinder.txt' }],
    });
    expect(lock.entries[0]!).not.toHaveProperty('installedAt');
    expect(lock.entries[0]!.contentHash).toMatch(/^sha256:/);
    for (const f of lock.entries[0]!.files) expect(f.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await manifestOf(w)).skills).toEqual(['wayfinder@a']);
  });

  it('reports unchanged on reinstall and updates when content changes', async () => {
    w = await makeWorld();
    const opts = { scope: 'project' as const, targets: ['claude' as const] };
    await installEntities(w.ctx, [{ kind: 'skill', spec: 'wayfinder' }], opts, w.deps);
    const again = await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'wayfinder' }],
      opts,
      w.deps,
    );
    expect(again.outcomes[0]!.status).toBe('unchanged');
    expect(w.calls.deploy).toHaveLength(1);

    await writeFile(join(w.origins.a, 'skills/wayfinder/SKILL.md'), 'wayfinder A v2\n');
    const updated = await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'wayfinder' }],
      opts,
      w.deps,
    );
    expect(updated.outcomes[0]!.status).toBe('updated');
    // the new files replace the old ones in place: nothing stale is left to undeploy
    expect(w.calls.undeploy).toHaveLength(0);
    expect(w.calls.deploy).toHaveLength(2);
    expect(existsSync(join(w.sb.project, '.claude/skill/wayfinder.txt'))).toBe(true);

    // a new target on an unchanged entity only deploys to the new one
    const more = await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'wayfinder' }],
      { scope: 'project', targets: ['codex'] },
      w.deps,
    );
    expect(more.outcomes[0]!.status).toBe('updated');
    expect(w.calls.deploy.map((c) => c.id)).toEqual(['claude', 'claude', 'codex']);
    expect((await lockOf(w)).entries[0]!.targets).toEqual(['claude', 'codex']);
  });

  it('asks the picker when several origins provide the name', async () => {
    const ui = fakeUI({ choose: (options) => options.find((o) => o.label.includes('@b'))!.value });
    w = await makeWorld({ ui, origins: ['a', 'b'] });
    const r = await installEntities(
      w.ctx,
      [{ spec: 'wayfinder' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    expect(ui.picks).toHaveLength(1);
    expect(ui.picks[0]!.options.map((o) => o.label)).toEqual([
      'wayfinder  (skill)  @a',
      'wayfinder  (skill)  @b',
    ]);
    expect(ui.picks[0]!.options[1]!.hint).toBe('the B wayfinder');
    expect(r.outcomes[0]!.entry.origin).toBe('b');
    expect((await manifestOf(w)).skills).toEqual(['wayfinder@b']);
  });

  it('fails with E_AMBIGUOUS when not interactive', async () => {
    w = await makeWorld({ ui: fakeUI({ interactive: false }), origins: ['a', 'b'] });
    const err = await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'wayfinder' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    ).catch((e) => e);
    expect(err).toMatchObject({ code: 'E_AMBIGUOUS' });
    expect(err.hint).toContain('wayfinder@a');
    expect(err.hint).toContain('wayfinder@b');
  });

  it('--yes auto-picks only byte-identical candidates', async () => {
    w = await makeWorld({
      ui: fakeUI({ interactive: false }),
      origins: ['a', 'c'],
      flags: { yes: true },
    });
    const r = await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'wayfinder' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    expect(r.outcomes[0]!.entry.origin).toBe('a');
    await removeDir(w.sb.root);

    w = await makeWorld({
      ui: fakeUI({ interactive: false }),
      origins: ['a', 'b'],
      flags: { yes: true },
    });
    await expect(
      installEntities(
        w.ctx,
        [{ kind: 'skill', spec: 'wayfinder' }],
        { scope: 'project', targets: ['claude'] },
        w.deps,
      ),
    ).rejects.toMatchObject({ code: 'E_AMBIGUOUS' });
  });

  it('suggests close names when nothing matches', async () => {
    w = await makeWorld();
    const err = await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'wayfindr' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    ).catch((e) => e);
    expect(err).toMatchObject({ code: 'E_NOT_FOUND' });
    expect(err.hint).toContain('wayfinder@a');
    expect(err.hint).toContain('palm install origin');
    await expect(
      installEntities(
        w.ctx,
        [{ kind: 'skill', spec: 'wayfinder@nope' }],
        { scope: 'project', targets: ['claude'] },
        w.deps,
      ),
    ).rejects.toMatchObject({ code: 'E_ORIGIN' });
  });

  it('expands plugins into members recorded with via', async () => {
    w = await makeWorld();
    const r = await installEntities(
      w.ctx,
      [{ kind: 'plugin', spec: 'superpowers' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    expect(r.outcomes.map((o) => [o.entry.kind, o.entry.name, o.entry.via, o.status])).toEqual([
      ['plugin', 'superpowers', undefined, 'installed'],
      ['skill', 'brainstorm', 'plugin:superpowers', 'installed'],
    ]);
    expect(r.warnings.some((m) => m.includes('missing-member'))).toBe(true);
    expect(w.calls.deploy.map((c) => c.input.entity.name)).toEqual(['brainstorm']);
    const m = await manifestOf(w);
    expect(m.plugins).toEqual(['superpowers@a']);
    expect(m.skills).toBeUndefined();
  });

  it('resolves agent dependencies and notes secrets', async () => {
    w = await makeWorld();
    const r = await installEntities(
      w.ctx,
      [{ kind: 'agent', spec: 'reviewer' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    const byName = Object.fromEntries(r.outcomes.map((o) => [o.entry.name, o]));
    expect(Object.keys(byName).sort()).toEqual(['docs', 'reviewer', 'tdd']);
    expect(byName.tdd!.entry.via).toBe('agent:reviewer');
    expect(byName.docs!.entry).toMatchObject({ kind: 'mcp', via: 'agent:reviewer' });
    expect(byName.docs!.notes.join('\n')).toContain('DOCS_TOKEN');
    expect(r.warnings.some((m) => m.includes('"ghost"'))).toBe(true);
    const deployedMcp = w.calls.deploy.find((c) => c.input.entity.kind === 'mcp')!.input;
    expect(deployedMcp.secretPolicy).toBe('env-ref');
    expect((await manifestOf(w)).agents).toEqual(['reviewer@a']);
  });

  it('does not reinstall a dependency that is already installed directly', async () => {
    w = await makeWorld();
    const opts = { scope: 'project' as const, targets: ['claude' as const] };
    await installEntities(w.ctx, [{ kind: 'skill', spec: 'tdd' }], opts, w.deps);
    const r = await installEntities(w.ctx, [{ kind: 'agent', spec: 'reviewer' }], opts, w.deps);
    const tdd = r.outcomes.find((o) => o.entry.name === 'tdd')!;
    expect(tdd.status).toBe('unchanged');
    expect(tdd.entry.via).toBeUndefined();
    expect(w.calls.deploy.filter((c) => c.input.entity.name === 'tdd')).toHaveLength(1);
  });

  it('dry run writes nothing', async () => {
    w = await makeWorld({ flags: { dryRun: true } });
    const r = await installEntities(
      w.ctx,
      [{ kind: 'agent', spec: 'reviewer' }],
      { scope: 'project', targets: ['claude', 'codex'] },
      w.deps,
    );
    expect(r.outcomes.map((o) => o.status)).toEqual(['installed', 'installed', 'installed']);
    expect(w.calls.deploy.every((c) => c.input.dryRun)).toBe(true);
    expect(existsSync(join(w.sb.project, 'palm.lock.yaml'))).toBe(false);
    expect(existsSync(join(w.sb.project, 'palm.yaml'))).toBe(false);
    expect(existsSync(join(w.sb.project, '.claude'))).toBe(false);
  });

  it('falls back to the MCP registry and records a registry manifest entry', async () => {
    w = await makeWorld();
    const r = await installEntities(
      w.ctx,
      [{ kind: 'mcp', spec: 'io.github.acme/weather' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    expect(w.registryCalls).toEqual(['io.github.acme/weather']);
    expect(r.outcomes[0]!.entry).toMatchObject({
      kind: 'mcp',
      name: 'weather',
      origin: 'registry',
      path: 'io.github.acme/weather',
      ref: '1.2.0',
    });
    expect((await manifestOf(w)).mcp).toEqual([
      { name: 'weather', registry: 'io.github.acme/weather' },
    ]);
    await expect(
      installEntities(
        w.ctx,
        [{ kind: 'mcp', spec: 'io.github.acme/nothing' }],
        { scope: 'project', targets: ['claude'] },
        w.deps,
      ),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });

  it('installs ad hoc MCP servers with literal secrets globally', async () => {
    w = await makeWorld();
    const adhocMcp = {
      name: 'fs',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', 'server-fs'],
    };
    const r = await installEntities(
      w.ctx,
      [{ kind: 'mcp', spec: 'fs', adhocMcp }],
      { scope: 'global', targets: ['claude'] },
      w.deps,
    );
    expect(r.outcomes[0]!.entry).toMatchObject({ kind: 'mcp', name: 'fs', origin: 'adhoc' });
    expect(w.calls.deploy[0]!.input).toMatchObject({
      scope: 'global',
      scopeRoot: w.sb.home,
      secretPolicy: 'literal',
    });
    expect(existsSync(join(w.sb.home, '.claude/mcp/fs.txt'))).toBe(true);
    const m = await loadManifest(join(w.sb.palmHome, 'palm.yaml'));
    expect(m.mcp).toEqual([
      { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server-fs'] },
    ]);
    expect((await loadLock(join(w.sb.palmHome, 'palm.lock.yaml'))).entries).toHaveLength(1);
  });

  it('records a failed target and goes on; all targets failing is a failed outcome, not a throw', async () => {
    w = await makeWorld({ failFor: ['codex'] });
    const r = await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'tdd' }],
      { scope: 'project', targets: ['claude', 'codex'] },
      w.deps,
    );
    expect(r.outcomes[0]!.status).toBe('installed');
    expect(r.outcomes[0]!.entry.targets).toEqual(['claude']);
    expect(r.failures).toEqual([
      {
        kind: 'skill',
        name: 'tdd',
        origin: 'a',
        target: 'codex',
        code: 'E_TARGET',
        message: 'codex is broken',
      },
    ]);
    const all = await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'wayfinder' }],
      { scope: 'project', targets: ['codex'] },
      w.deps,
    );
    expect(all.outcomes[0]!.status).toBe('failed');
    expect(all.failures).toMatchObject([{ name: 'wayfinder', target: 'codex', code: 'E_TARGET' }]);
    // the lock lists only what succeeded: tdd on claude, no wayfinder; nothing was added to palm.yaml
    const lock = await lockOf(w);
    expect(lock.entries.map((e) => [e.name, e.targets])).toEqual([['tdd', ['claude']]]);
    expect((await manifestOf(w)).skills).toEqual(['tdd@a']);
  });

  it('refuses unmanaged files unless forced', async () => {
    w = await makeWorld();
    await mkdir(join(w.sb.project, '.claude/skill'), { recursive: true });
    await writeFile(join(w.sb.project, '.claude/skill/tdd.txt'), 'mine');
    const refused = await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'tdd' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    expect(refused.outcomes[0]!.status).toBe('failed');
    expect(refused.failures).toMatchObject([{ code: 'E_CONFLICT', target: 'claude' }]);
    expect(existsSync(join(w.sb.project, 'palm.lock.yaml'))).toBe(false);
    w.ctx.flags.force = true;
    const r = await installEntities(
      w.ctx,
      [{ kind: 'skill', spec: 'tdd' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    expect(r.outcomes[0]!.status).toBe('installed');
  });
});
