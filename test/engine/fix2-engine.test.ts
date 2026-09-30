/**
 * Engine rulings from the second persona rerun (FINDINGS-v3.md), one test per ruling id, on the
 * engine's fakes: interrupts in the write phase (O13 J4').
 */
import './fakes.js';

import { describe, expect, it } from 'vitest';
import { PalmError } from '../../src/core/errors.js';
import type { Target, TargetId } from '../../src/core/types.js';
import { resolveEngineDeps } from '../../src/engine/deps.js';
import { installFromSource } from '../../src/engine/install.js';
import { requestInstallStop } from '../../src/engine/runner.js';
import { openScope } from '../../src/engine/scope.js';
import { syncScope } from '../../src/engine/sync.js';
import { droppedTargets } from '../../src/engine/targets.js';
import { makeWorld, type World } from './world.js';

const project = { scope: 'project' as const };

const KIT = {
  'skills/tdd/SKILL.md': 'Test first.\n',
  'skills/review/SKILL.md': 'Review carefully.\n',
  'skills/zen/SKILL.md': 'Breathe.\n',
};

/** The world's targets, with `apply` of `id` replaced for the entity `name`. */
function applyFor(w: World, name: string, fn: () => void): World['deps'] {
  const base = w.deps.getTarget as (id: TargetId) => Target;
  return {
    ...w.deps,
    getTarget: (id: TargetId) => {
      const t = base(id);
      return {
        ...t,
        apply: async (input) => {
          if (input.rendered.files.some((f) => f.path.includes(`/${name}/`))) fn();
          return t.apply(input);
        },
      };
    },
  };
}

async function install(w: World, names: string[], deps = w.deps) {
  const url = await w.remote('kit', { 'v1.0.0': KIT });
  return installFromSource(
    w.ctx,
    { source: url, names: names.map((name) => ({ name })) },
    project,
    deps,
  );
}

describe("O13 J4' M-Ctrl-C interrupts in the write phase", () => {
  it('O13 a stop requested while an entity is written ends the run after it, with a report', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const r = await install(w, ['tdd', 'review', 'zen'], applyFor(w, 'tdd', requestInstallStop));
    expect(r.interrupted).toEqual({ done: 1, total: 3 });
    expect(r.outcomes.map((o) => o.entry.name)).toEqual(['tdd']);
    expect(r.warnings).toContain(
      'cancelled after 1 of 3; palm.lock.yaml records what was installed',
    );
    expect((await w.lock()).entries?.map((e) => e.name)).toEqual(['tdd']);
  });

  it("J4' a program that died of the same Ctrl-C mid-run still leaves a report and a lock", async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const dies = () => {
      throw new PalmError('E_CANCELLED', 'cancelled; nothing was written');
    };
    const r = await install(w, ['tdd', 'review', 'zen'], applyFor(w, 'review', dies));
    expect(r.interrupted).toEqual({ done: 1, total: 3 });
    expect((await w.lock()).entries?.map((e) => e.name)).toEqual(['tdd']);
    expect(await w.read('.claude/skills/zen/SKILL.md')).toBeUndefined();
  });

  it('M-Ctrl-C a cancel before anything is written stays E_CANCELLED and writes nothing', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const dies = () => {
      throw new PalmError('E_CANCELLED', 'cancelled; nothing was written');
    };
    await expect(install(w, ['tdd', 'review'], applyFor(w, 'tdd', dies))).rejects.toMatchObject({
      code: 'E_CANCELLED',
    });
    expect(await w.lockText()).toBeUndefined();
  });
});

describe("B2 J10' a target palm.yaml no longer lists", () => {
  async function narrowed() {
    const w = await makeWorld({ targets: ['claude', 'codex'] });
    await install(w, ['tdd']);
    const yaml = (await w.manifestText()) ?? '';
    await w.write('palm.yaml', yaml.replace('targets: [claude, codex]', 'targets: [claude]'));
    return w;
  }

  it('B2 droppedTargets names the target and the files the next install removes', async () => {
    const w = await narrowed();
    const deps = await resolveEngineDeps(w.deps);
    const state = await openScope(w.ctx, 'project', { deps, readOnly: true });
    expect(droppedTargets(w.ctx, deps, state)).toEqual([
      { target: 'codex', files: ['.codex/skills/tdd/SKILL.md'], entries: 1 },
    ]);
  });

  it('B2 a dry run lists the removal; the install removes it', async () => {
    const w = await narrowed();
    const dry = w.context({ dryRun: true });
    const plan = await syncScope(dry, project, w.deps);
    expect(dry.log.text()).toContain('would remove .codex/skills/tdd/SKILL.md');
    expect(plan.removals).toEqual(['.codex/skills/tdd/SKILL.md']);
    expect(w.exists('.codex/skills/tdd/SKILL.md')).toBe(true);
    const done = await syncScope(w.ctx, project, w.deps);
    expect(done.removals).toEqual(['.codex/skills/tdd/SKILL.md']);
    expect(w.exists('.codex/skills/tdd/SKILL.md')).toBe(false);
    expect(w.exists('.claude/skills/tdd/SKILL.md')).toBe(true);
  });

  it("J10' removing an entry from palm.yaml puts its files in the plan's removals", async () => {
    const w = await makeWorld({ targets: ['claude'] });
    await install(w, ['tdd', 'review']);
    const yaml = (await w.manifestText()) ?? '';
    await w.write('palm.yaml', yaml.replace(/tdd, |, tdd/, ''));
    const plan = await syncScope(w.context({ dryRun: true }), project, w.deps);
    expect(plan.removals).toEqual(['.claude/skills/tdd/SKILL.md']);
  });
});
