import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { loadManifest } from '../../src/core/manifest.js';
import { installEntities } from '../../src/engine/install.js';
import {
  findCandidates,
  getEntityInfo,
  listInstalled,
  searchIndex,
} from '../../src/engine/query.js';
import { resolveTargets } from '../../src/engine/resolve-targets.js';
import { fakeUI } from '../support/fakes.js';
import { removeDir } from '../support/sandbox.js';
import { makeWorld, type World } from './world.js';

describe('query', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('searches, finds candidates, lists installed and describes entities', async () => {
    w = await makeWorld({ origins: ['a', 'b'] });
    const hits = await searchIndex(w.ctx, 'way', {}, w.deps);
    expect(hits.map((h) => [h.entity.name, h.entity.origin, h.score])).toEqual([
      ['wayfinder', 'a', 80],
      ['wayfinder', 'b', 80],
    ]);
    const desc = await searchIndex(w.ctx, 'reviews', { kind: 'agent' }, w.deps);
    expect(desc.map((h) => [h.entity.name, h.score])).toEqual([['reviewer', 40]]);
    expect((await searchIndex(w.ctx, 'tdd', { origin: 'a' }, w.deps))[0]!.score).toBe(100);
    expect((await searchIndex(w.ctx, 'rain', {}, w.deps)).map((h) => h.entity.name)).toEqual([
      'brainstorm',
    ]);

    expect(
      (await findCandidates(w.ctx, { kind: 'skill', name: 'WAYFINDER' }, {}, w.deps)).map(
        (e) => e.origin,
      ),
    ).toEqual(['a', 'b']);
    expect(
      (await findCandidates(w.ctx, { name: 'dual' }, { origin: 'a' }, w.deps))
        .map((e) => e.kind)
        .sort(),
    ).toEqual(['agent', 'skill']);
    const adhoc = await findCandidates(
      w.ctx,
      { kind: 'skill', name: 'wayfinder' },
      { from: { alias: 'tmp', type: 'local', path: w.origins.c } },
      w.deps,
    );
    expect(adhoc.map((e) => e.origin)).toEqual(['tmp']);

    await installEntities(
      w.ctx,
      [{ kind: 'agent', spec: 'reviewer' }],
      { scope: 'project', targets: ['claude'] },
      w.deps,
    );
    expect((await listInstalled(w.ctx, 'project')).map((e) => e.name).sort()).toEqual([
      'docs',
      'reviewer',
      'tdd',
    ]);
    expect((await listInstalled(w.ctx, 'project', 'skill')).map((e) => e.name)).toEqual(['tdd']);
    expect(await listInstalled(w.ctx, 'global')).toEqual([]);

    const info = await getEntityInfo(
      w.ctx,
      { kind: 'agent', name: 'reviewer' },
      { scope: 'project' },
      w.deps,
    );
    expect(info.entity?.description).toBe('reviews code');
    expect(info.lock?.origin).toBe('a');
    expect(info.deps).toEqual([
      { kind: 'skill', name: 'tdd' },
      { kind: 'skill', name: 'ghost' },
      { kind: 'mcp', name: 'docs' },
    ]);
  });
});

describe('resolveTargets', () => {
  let w: World;
  afterEach(async () => removeDir(w.sb.root));

  it('prefers flag > manifest > config > detection', async () => {
    w = await makeWorld({ detect: ['cursor'] });
    expect(await resolveTargets(w.ctx, { scope: 'project', flag: ['codex'] }, w.deps)).toEqual([
      'codex',
    ]);
    await expect(
      resolveTargets(w.ctx, { scope: 'project', flag: ['vim' as never] }, w.deps),
    ).rejects.toMatchObject({ code: 'E_USAGE' });
    expect(await resolveTargets(w.ctx, { scope: 'project' }, w.deps)).toEqual(['cursor']);
    w.ctx.config.targets = ['copilot'];
    expect(await resolveTargets(w.ctx, { scope: 'project' }, w.deps)).toEqual(['copilot']);
    await writeFile(join(w.sb.project, 'palm.yaml'), 'targets: [claude, codex]\n');
    expect(await resolveTargets(w.ctx, { scope: 'project' }, w.deps)).toEqual(['claude', 'codex']);
    expect(await resolveTargets(w.ctx, { scope: 'global' }, w.deps)).toEqual(['copilot']);
  });

  it('asks interactively when nothing is detected and saves the answer', async () => {
    const ui = fakeUI({ chooseMany: (o) => o.slice(0, 2).map((x) => x.value) });
    w = await makeWorld({ ui });
    expect(await resolveTargets(w.ctx, { scope: 'project', save: true }, w.deps)).toEqual([
      'claude',
      'codex',
    ]);
    expect(ui.pickManys[0]!.options.map((o) => o.label)).toEqual([
      'Fake claude',
      'Fake codex',
      'Fake copilot',
      'Fake cursor',
      'Fake gemini',
      'Fake opencode',
    ]);
    expect((await loadManifest(join(w.sb.project, 'palm.yaml'))).targets).toEqual([
      'claude',
      'codex',
    ]);
    // A global pick is used for this run only: config.yaml `targets` would become the default
    // for every project without its own.
    expect(await resolveTargets(w.ctx, { scope: 'global', save: true }, w.deps)).toEqual([
      'claude',
      'codex',
    ]);
    expect((await loadConfig(w.ctx.paths)).targets).toBeUndefined();
  });

  it('fails non-interactively when nothing is detected', async () => {
    w = await makeWorld({ ui: fakeUI({ interactive: false }) });
    const err = await resolveTargets(w.ctx, { scope: 'project' }, w.deps).catch((e) => e);
    expect(err).toMatchObject({ code: 'E_TARGET' });
    expect(err.hint).toContain('--target claude,codex');
  });
});
