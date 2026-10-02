/**
 * Install and name rulings from the second persona rerun (FINDINGS-v3.md), one test per id:
 * two-kind names (O4 T15 M5 M10 O3 V7'), a declined member of a named plugin (Q4), plugin
 * member lists (M1, R13' Q5), `--all` with only programs (Q6), layouts (Z2 N2, R3', T12),
 * renames (T10) and names only the default branch has (T11).
 */
import './fakes.js';

import { describe, expect, it } from 'vitest';
import { PalmError } from '../../src/core/errors.js';
import type { PickOption, UI } from '../../src/core/types.js';
import { installFromSource } from '../../src/engine/install.js';
import { removeEntities } from '../../src/engine/remove.js';
import { syncScope } from '../../src/engine/sync.js';
import { fakeUI } from './fakes.js';
import { type Files, makeWorld, type World } from './world.js';

const project = { scope: 'project' as const };

const HOOK = {
  'hooks/session-start/hooks.json': JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/session-start/run.sh' }],
        },
      ],
    },
  }),
  'hooks/session-start/run.sh': { text: 'echo hi\n', mode: 0o755 },
};

/** A plugin `ast-grep` beside a skill `ast-grep` it does not hold, and a name two kinds share. */
const CLASH: Files = {
  'skills/ast-grep/SKILL.md': 'Search code by shape.\n',
  'skills/other/SKILL.md': 'Other.\n',
  'skills/review/SKILL.md': 'Review.\n',
  'agents/review.md': 'An agent.\n',
  'skills/tdd/SKILL.md': 'Test first.\n',
  'plugins/ast-grep.json': JSON.stringify({ members: ['skill:other'] }),
};

const SUPERPOWERS: Files = {
  'skills/brainstorming/SKILL.md': 'Think first.\n',
  'skills/writing/SKILL.md': 'Write.\n',
  ...HOOK,
  'plugins/superpowers.json': JSON.stringify({
    members: ['skill:brainstorming', 'skill:writing', 'hook:session-start'],
  }),
};

/** The same plugin without its program. */
const SKILLS_ONLY: Files = {
  'skills/brainstorming/SKILL.md': 'Think first.\n',
  'skills/writing/SKILL.md': 'Write.\n',
  'plugins/superpowers.json': JSON.stringify({ members: ['skill:brainstorming', 'skill:writing'] }),
};

async function install(w: World, source: string, names: string[], extra = {}) {
  return installFromSource(
    w.ctx,
    { source, names: names.map((n) => (n.includes(':') ? spec(n) : { name: n })), ...extra },
    project,
    w.deps,
  );
}

function spec(text: string) {
  const [kind, name] = text.split(':');
  return { kind: kind as 'skill', name: name as string };
}

/** A terminal whose which-kind question answers with the option labelled `label`. */
function picking(label: string, consent: 'yes' | 'no' = 'yes'): UI {
  const ui = fakeUI({ interactive: true });
  return {
    ...ui,
    pick: async <T>(_m: string, options: PickOption<T>[]) =>
      (options.find((o) => o.label === label) ?? (options[0] as PickOption<T>)).value,
    consent: async () => consent,
  };
}

describe("O4 T15 M5 M10 O3 V7' two-kind names", () => {
  it('O4 a plugin and a skill of one name are ambiguous; nothing is written', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('clash', { 'v1.0.0': CLASH });
    await expect(install(w, url, ['ast-grep'])).rejects.toMatchObject({
      code: 'E_AMBIGUOUS',
      message: `"ast-grep" names 2 kinds in source ${url}: plugin:ast-grep, skill:ast-grep`,
      hint: `palm install ${url} plugin:ast-grep`,
    });
    expect(await w.manifestText()).toBe('targets: [claude]\n');
    expect(await w.lockText()).toBeUndefined();
    expect(w.exists('.claude/skills/other/SKILL.md')).toBe(false);
  });

  it('O3 every ambiguous name in one error with one corrected command', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('clash', { 'v1.0.0': CLASH });
    const err = await install(w, url, ['ast-grep', 'review', 'tdd']).catch((e: PalmError) => e);
    expect(err).toBeInstanceOf(PalmError);
    expect((err as PalmError).message).toContain('"ast-grep" names 2 kinds');
    expect((err as PalmError).message).toContain(
      '"review" names 2 kinds: skill:review, agent:review',
    );
    expect((err as PalmError).hint).toBe(`palm install ${url} plugin:ast-grep skill:review tdd`);
  });

  it('M10 on a terminal palm asks which kind and installs only that one', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('clash', { 'v1.0.0': CLASH });
    const ctx = w.context({}, picking('skill:ast-grep'));
    const r = await installFromSource(
      ctx,
      { source: url, names: [{ name: 'ast-grep' }] },
      project,
      w.deps,
    );
    expect(r.failures).toEqual([]);
    expect(r.requested).toEqual([{ kind: 'skill', name: 'ast-grep' }]);
    expect(w.exists('.claude/skills/ast-grep/SKILL.md')).toBe(true);
    expect(w.exists('.claude/skills/other/SKILL.md')).toBe(false);
  });

  it("V7' a which-kind question left unanswered writes nothing", async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('clash', { 'v1.0.0': CLASH });
    const ui: UI = {
      ...fakeUI({ interactive: true }),
      pick: async () => {
        throw new PalmError('E_CANCELLED', 'cancelled');
      },
    };
    const ctx = w.context({}, ui);
    await expect(
      installFromSource(
        ctx,
        { source: url, names: [{ name: 'tdd' }, { name: 'ast-grep' }] },
        project,
        w.deps,
      ),
    ).rejects.toMatchObject({ code: 'E_CANCELLED' });
    expect(await w.manifestText()).toBe('targets: [claude]\n');
    expect(w.exists('.claude/skills/tdd/SKILL.md')).toBe(false);
  });
});

describe('Q4 a declined member of a named plugin', () => {
  it('Q4 plugin:x with its hook declined installs the rest; the names resolved to the plugin', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true, consent: 'no' });
    const url = await w.remote('superpowers', { 'v1.0.0': SUPERPOWERS });
    const r = await install(w, url, ['plugin:superpowers']);
    expect(r.requested).toEqual([{ kind: 'plugin', name: 'superpowers' }]);
    expect(r.outcomes.find((o) => o.entry.kind === 'hook')).toMatchObject({ declined: true });
    expect(w.exists('.claude/skills/brainstorming/SKILL.md')).toBe(true);
  });

  it('Q4 the bare name, picked as the plugin on a terminal, resolves the same way', async () => {
    const w = await makeWorld({ targets: ['claude'], consent: 'no' });
    const files = { ...SUPERPOWERS, 'skills/superpowers/SKILL.md': 'Meta.\n' };
    const url = await w.remote('superpowers', { 'v1.0.0': files });
    const ctx = w.context({}, picking('plugin:superpowers', 'no'));
    const r = await installFromSource(
      ctx,
      { source: url, names: [{ name: 'superpowers' }] },
      project,
      w.deps,
    );
    expect(r.requested).toEqual([{ kind: 'plugin', name: 'superpowers' }]);
    expect(r.outcomes.find((o) => o.entry.kind === 'hook')).toMatchObject({ declined: true });
  });
});

describe("M1 R13' Q5 plugin member lists", () => {
  it('M1 a typo in only: is E_PARSE naming the nearest member; nothing is removed', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('superpowers', { 'v1.0.0': SKILLS_ONLY });
    await install(w, url, ['plugin:superpowers'], {});
    const text = (await w.manifestText()) as string;
    await w.write(
      'palm.yaml',
      text.replace(
        'plugins: [superpowers]',
        'plugins: [{name: superpowers, only: [skill:brainstormng]}]',
      ),
    );
    await expect(syncScope(w.ctx, project, w.deps)).rejects.toMatchObject({
      code: 'E_PARSE',
      message:
        'palm.yaml: only: skill:brainstormng names no member of plugin superpowers in source superpowers; did you mean skill:brainstorming?',
    });
    expect(w.exists('.claude/skills/brainstorming/SKILL.md')).toBe(true);
    expect(w.exists('.claude/skills/writing/SKILL.md')).toBe(true);
  });

  it("R13' Q5 installing an excluded hook by name takes it out of exclude:", async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true, consent: 'no' });
    const url = await w.remote('superpowers', { 'v1.0.0': SUPERPOWERS });
    await install(w, url, ['plugin:superpowers']);
    expect(await w.manifest()).toMatchObject({
      sources: {
        superpowers: { plugins: [{ name: 'superpowers', exclude: ['hook:session-start'] }] },
      },
    });
    w.exec.script.answer = 'yes';
    const r = await install(w, 'superpowers', ['hook:session-start']);
    expect(r.failures).toEqual([]);
    const manifest = await w.manifest();
    expect(manifest).toMatchObject({ sources: { superpowers: { plugins: ['superpowers'] } } });
    expect(JSON.stringify(manifest)).not.toContain('hooks');
    expect(await w.entry('hook', 'session-start')).toMatchObject({ via: 'plugin:superpowers' });
  });
});

describe('Q6 --all with only programs', () => {
  it('Q6 declares nothing and names the programs to install', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('context7', {
      'v1.0.0': {
        'mcp.json': JSON.stringify({
          context7: { transport: 'stdio', command: 'npx', args: ['c7'] },
        }),
        'plugins/context7.json': JSON.stringify({ members: ['mcp:context7'] }),
      },
    });
    const r = await installFromSource(
      w.ctx,
      { source: url, names: [], all: true },
      project,
      w.deps,
    );
    expect(r.failures).toEqual([]);
    expect(await w.manifestText()).toBe('targets: [claude]\n');
    expect(await w.lockText()).toBeUndefined();
    expect(w.ctx.log.text()).toContain(
      `Nothing installed; the source offers only programs: palm install ${url} mcp:context7`,
    );
  });
});

describe("Z2 N2 R3' T12 layouts", () => {
  it('Z2 N2 the same --layout on a declared source is a no-op; another one is refused', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', {
      'v1.0.0': { 'skills/tdd/SKILL.md': 'x\n', 'skills/b/SKILL.md': 'b\n' },
    });
    const layout = { skills: ['skills/*'] };
    await install(w, url, ['tdd'], { layout });
    const again = await install(w, url, ['b'], { layout });
    expect(again.failures).toEqual([]);
    await expect(install(w, url, ['b'], { layout: { skills: ['other/*'] } })).rejects.toMatchObject(
      {
        code: 'E_USAGE',
      },
    );
  });

  it("R3' members of a plugin the source no longer indexes stay installed and are reported", async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const src = await w.local('kit', SKILLS_ONLY);
    await install(w, src, ['plugin:superpowers']);
    await w.remove('kit/plugins');
    const r = await syncScope(w.ctx, project, w.deps);
    expect(r.failures.map((f) => f.message)).toEqual([
      'plugin superpowers is no longer in source ./kit',
    ]);
    expect(w.exists('.claude/skills/brainstorming/SKILL.md')).toBe(true);
    expect(await w.entry('skill', 'writing')).toMatchObject({ via: 'plugin:superpowers' });
  });

  it("R3' with a layout, the report names the layout", async () => {
    const w = await makeWorld({ targets: ['claude'] });
    await w.local('kit', { 'skills/tdd/SKILL.md': 'x\n' });
    await w.write(
      'palm.yaml',
      'targets: [claude]\nsources:\n  kit:\n    path: ./kit\n    layout: {agents: [people/*.md]}\n    skills: [gone]\n',
    );
    const r = await syncScope(w.ctx, project, w.deps);
    expect(r.failures[0]?.message).toBe(
      'skill gone is not indexed by the layout of source kit; add it to its layout: in palm.yaml, or remove it',
    );
  });

  it('T12 removing the last entry keeps a source that has a layout', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', { 'v1.0.0': { 'skills/tdd/SKILL.md': 'x\n' } });
    await install(w, url, ['tdd'], { layout: { skills: ['skills/*'] } });
    await removeEntities(w.ctx, [{ name: 'tdd' }], project, w.deps);
    expect(await w.manifest()).toMatchObject({
      sources: { kit: { url, layout: { skills: ['skills/*'] } } },
    });
    expect(w.exists('.claude/skills/tdd/SKILL.md')).toBe(false);
  });
});

describe('T10 T11 renames and the default branch', () => {
  it('T10 the renamed line only after the run succeeded', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', {
      'v1.0.0': { 'skills/tdd/SKILL.md': 'x\n', 'skills/b/SKILL.md': 'b\n' },
    });
    await install(w, url, ['tdd']);
    await expect(install(w, url, ['nosuch'], { as: 'team' })).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    });
    expect(w.ctx.log.text()).not.toContain('(renamed)');
    expect(await w.manifest()).toMatchObject({ sources: { kit: { url } } });
    await install(w, url, ['b'], { as: 'team' });
    expect(w.ctx.log.text()).toContain('source kit → team (renamed)');
  });

  it('T11 a name only the default branch has: the error says so and hints #main', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const url = await w.remote('kit', {
      'v1.0.0': { 'skills/tdd/SKILL.md': 'x\n' },
      main: { 'skills/tdd/SKILL.md': 'x\n', 'skills/beta/SKILL.md': 'new\n' },
    });
    await expect(install(w, url, ['beta'])).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
      message: `"beta" is not in source kit at v1.0.0; its default branch main has it`,
      hint: `palm install ${url}#main beta`,
    });
    await expect(install(w, url, ['nosuch'])).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
      message: `"nosuch" is not in source ${url}; list what it offers:`,
    });
  });
});
