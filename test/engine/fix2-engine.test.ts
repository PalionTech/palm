/**
 * Engine rulings from the second persona rerun (FINDINGS-v3.md), one test per ruling id, on the
 * engine's fakes: interrupts in the write phase (O13 J4').
 */
import './fakes.js';

import { describe, expect, it } from 'vitest';
import { PalmError } from '../../src/core/errors.js';
import type { Target, TargetId } from '../../src/core/types.js';
import { installFromSource } from '../../src/engine/install.js';
import { requestInstallStop } from '../../src/engine/runner.js';
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
