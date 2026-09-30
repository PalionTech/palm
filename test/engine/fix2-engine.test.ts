/**
 * Engine rulings from the second persona rerun (FINDINGS-v3.md), one test per ruling id, on the
 * engine's fakes: interrupts in the write phase (O13 J4').
 */
import './fakes.js';

import { describe, expect, it } from 'vitest';
import { PalmError } from '../../src/core/errors.js';
import type { Target, TargetId } from '../../src/core/types.js';
import { resolveEngineDeps } from '../../src/engine/deps.js';
import { installFromSource, installMcp } from '../../src/engine/install.js';
import { requestInstallStop } from '../../src/engine/runner.js';
import { openScope } from '../../src/engine/scope.js';
import { syncScope } from '../../src/engine/sync.js';
import { droppedTargets } from '../../src/engine/targets.js';
import { scopeTwins } from '../../src/engine/twins.js';
import { makeWorld, type World, writeTree } from './world.js';

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

describe('X13 M9 the same entity in both scopes', () => {
  async function both(globalTargets: string) {
    const w = await makeWorld({ targets: ['claude'] });
    await writeTree(w.palmHome, { 'palm.yaml': `targets: [${globalTargets}]\n` });
    await install(w, ['tdd', 'review']);
    const url = await w.remote('kit', { 'v1.0.0': KIT });
    const req = { source: url, names: [{ name: 'tdd' }] };
    await installFromSource(w.ctx, req, { scope: 'global' }, w.deps);
    return w;
  }

  it('X13 scopeTwins names an entity the project and -g both install for claude', async () => {
    const w = await both('claude');
    const state = await openScope(w.ctx, 'project', { readOnly: true });
    expect(await scopeTwins(w.ctx, state)).toEqual([
      {
        kind: 'skill',
        name: 'tdd',
        source: 'kit',
        other: { scope: 'global', source: 'kit' },
        targets: ['claude'],
      },
    ]);
    const mine = await openScope(w.ctx, 'global', { readOnly: true });
    expect((await scopeTwins(w.ctx, mine)).map((t) => t.other.scope)).toEqual(['project']);
  });

  it('M9 nothing is reported when the other scope renders for other harnesses', async () => {
    const w = await both('codex');
    const state = await openScope(w.ctx, 'project', { readOnly: true });
    expect(await scopeTwins(w.ctx, state)).toEqual([]);
  });
});

describe("Y15' a policy change re-renders every target", () => {
  it("Y15' --secrets env-ref after literal rewrites every target's literal", async () => {
    const w = await makeWorld({ targets: ['claude', 'opencode'] });
    const cfg = {
      name: 'docs',
      transport: 'http' as const,
      url: 'https://docs.example.com/mcp',
      headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
    };
    const env = { ...w.ctx.env, DOCS_TOKEN: 'plain-test-value' };
    const literal = { ...w.context({ secrets: 'literal' }), env };
    await installMcp(literal, [{ config: cfg }], project, w.deps);
    expect(await w.read('.opencode/mcp.json')).toContain('plain-test-value');
    const back = { ...w.context({ secrets: 'env-ref' }), env };
    const r = await installMcp(back, [{ config: cfg }], { ...project, force: true }, w.deps);
    expect(r.failures).toEqual([]);
    expect(r.outcomes.map((o) => o.status)).not.toContain('modified');
    for (const file of ['.claude/mcp.json', '.opencode/mcp.json']) {
      expect(await w.read(file)).not.toContain('plain-test-value');
      expect(await w.read(file)).toContain('${DOCS_TOKEN}');
    }
    expect(await w.manifestText()).not.toContain('literal');
  });
});

describe("R7' a ref move lists the entries the new commit lacks", () => {
  async function moved() {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', {
      'v1.0.0': KIT,
      'v2.0.0': { 'skills/tdd/SKILL.md': 'Test first, always.\n' },
    });
    await installFromSource(
      w.ctx,
      { source: `${url}#v1.0.0`, names: [{ name: 'tdd' }, { name: 'review' }] },
      project,
      w.deps,
    );
    const yaml = (await w.manifestText()) ?? '';
    await w.write('palm.yaml', yaml.replace(/ref: \S+/, 'ref: v2.0.0'));
    return w;
  }

  it("R7' the confirmation says would remove; a dry run changes nothing", async () => {
    const w = await moved();
    const dry = w.context({ dryRun: true });
    const plan = await syncScope(dry, project, w.deps);
    expect(dry.log.text()).toMatch(
      / {2}- skill review \(not in v2\.0\.0 \([0-9a-f]{7}\); would remove\)/,
    );
    expect(plan.failures).toEqual([]);
    expect(w.exists('.claude/skills/review/SKILL.md')).toBe(true);
  });

  it("R7' the confirmed move removes the entry from disk, the lock and palm.yaml", async () => {
    const w = await moved();
    const r = await syncScope(w.context({ yes: true }), project, w.deps);
    expect(r.failures).toEqual([]);
    expect(r.outcomes.find((o) => o.entry.name === 'review')?.status).toBe('removed');
    expect(w.exists('.claude/skills/review/SKILL.md')).toBe(false);
    expect((await w.lock()).entries?.map((e) => e.name)).toEqual(['tdd']);
    expect(await w.manifestText()).not.toContain('review');
  });
});

/** 24 distinct characters: random-looking to the scanner, built at runtime. */
const RANDOM = 'Zx8kQ2mN7pL4vR9tW3yB6cF1';

describe('S1 a high-entropy value a source ships under any key becomes a reference', () => {
  it('S1 CREDENTIALS env and X-Session header are written as references', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true });
    const url = await w.remote('srv', {
      'v1.0.0': {
        'mcp.json': JSON.stringify({
          remote: {
            transport: 'http',
            url: 'https://srv.example/mcp',
            headers: { 'X-Session': RANDOM, 'X-Mode': 'fast' },
          },
          local: { transport: 'stdio', command: 'srv-mcp', env: { CREDENTIALS: RANDOM } },
        }),
      },
    });
    const req = { source: url, names: [{ name: 'remote' }, { name: 'local' }] };
    const r = await installFromSource(w.ctx, req, project, w.deps);
    expect(r.failures).toEqual([]);
    const written = (await w.read('.claude/mcp.json')) ?? '';
    expect(written).not.toContain(RANDOM);
    expect(written).toContain('${CREDENTIALS}');
    expect(written).toContain('"X-Mode": "fast"');
    expect(written).toMatch(/"X-Session": "\$\{[A-Z_]+\}"/);
    expect(r.warnings.join('\n')).toContain('env.CREDENTIALS held a literal secret in the source');
  });

  it('S1 a server declared by hand keeps its plain values (J2 stays with the typed rules)', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true });
    const cfg = {
      name: 'own',
      transport: 'stdio' as const,
      command: 'own-mcp',
      env: { MODE: RANDOM },
    };
    await installMcp(w.ctx, [{ config: cfg }], project, w.deps);
    expect(await w.read('.claude/mcp.json')).toContain(RANDOM);
  });
});
