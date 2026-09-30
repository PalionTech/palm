/**
 * The onboarding transcripts of PLAN.md §4.9 are the golden output: Nora's three commands and
 * Lena's two, line for line. The engine is faked with the results those sessions describe; a
 * transcript line `  ...` stands for the listing lines the plan leaves out.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entity, LockEntry, SourceCheckout, SourceIndex } from '../../src/core/types.js';
import type { SourceListing } from '../../src/create/engine.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';
import { fakeEngine, fakeScope, fakeSourceRef, lockEntry, outcome, palm } from './fakes.js';

vi.mock('../../src/commands/ports.js', () => import('./contract.js'));

/** Match `actual` against a transcript where a line `  ...` stands for one or more lines. */
function expectTranscript(actual: string, golden: string): void {
  const got = actual.replace(/\n$/, '').split('\n');
  const want = golden.replace(/^\n/, '').replace(/\n$/, '').split('\n');
  let g = 0;
  for (let w = 0; w < want.length; w++) {
    if (want[w] !== '  ...') {
      expect(got[g], `line ${g + 1}`).toBe(want[w]);
      g++;
      continue;
    }
    const next = want[w + 1];
    const found = got.indexOf(next ?? '', g + 1);
    expect(found, `lines elided before "${next}"`).toBeGreaterThan(g);
    g = found;
  }
  expect(got.length).toBe(g);
}

const SKILLS = [
  ['brainstorming', 'Explore requirements before writing code'],
  ['test-driven-development', 'Write the failing test first'],
  ['systematic-debugging', 'Find the root cause before fixing'],
  ['writing-plans', 'Write a plan before touching code'],
  ['executing-plans', 'Carry out a plan step by step'],
  ['using-git-worktrees', 'Work in an isolated worktree'],
  ['code-review', 'Review a change before merging'],
  ['receiving-review', 'Act on review feedback'],
  ['finishing-a-branch', 'Wrap up a development branch'],
  ['dispatching-agents', 'Split work across agents'],
  ['subagent-development', 'Develop with subagents'],
  ['verify-before-done', 'Verify before claiming done'],
  ['writing-skills', 'Write new skills'],
  ['sharing-skills', 'Share skills upstream'],
  ['using-superpowers', 'How to use these skills'],
] as const;

function skill(name: string, description: string): Entity {
  return {
    kind: 'skill',
    name,
    description,
    path: `skills/${name}`,
    source: 'obra/superpowers',
    def: { kind: 'skill', skill: { name, description } },
  };
}

const SESSION_START: Entity = {
  kind: 'hook',
  name: 'session-start',
  path: 'hooks/hooks.json',
  source: 'obra/superpowers',
  def: {
    kind: 'hook',
    hooks: {
      name: 'session-start',
      dialect: 'claude',
      raw: {
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd' }] },
          ],
        },
      },
      references: [],
      closure: { paths: ['hooks'] },
      promptHooks: [],
    },
  },
};

function superpowersListing(): SourceListing {
  const checkout: SourceCheckout = {
    source: { name: 'obra/superpowers', type: 'git', url: 'https://github.com/obra/superpowers.git' },
    sourceId: 'github.com__obra__superpowers',
    root: '/cache/obra',
    repoDir: '/cache/obra',
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    ref: 'v4.0.3',
  };
  const index: SourceIndex = {
    source: 'obra/superpowers',
    sourceId: checkout.sourceId,
    root: checkout.root,
    sha: checkout.sha,
    entities: [...SKILLS.map(([n, d]) => skill(n, d)), SESSION_START],
    warnings: [],
    detected: 'plugin-manifest',
  };
  return { source: fakeSourceRef({ name: 'obra/superpowers' }), checkout, index, declared: false };
}

function skillEntry(name: string, source: string, files: string[]): LockEntry {
  return lockEntry({ kind: 'skill', name, source, path: `skills/${name}`, files });
}

let sb: Sandbox | undefined;
afterEach(async () => {
  if (sb) await removeDir(sb.root);
  sb = undefined;
});

describe('Nora: Claude Code only, an empty project with .claude/', () => {
  async function nora(): Promise<Sandbox> {
    sb = await sandbox();
    await mkdir(join(sb.project, '.claude'), { recursive: true });
    return sb;
  }

  it('palm install superpowers: the first line is the fix', async () => {
    const box = await nora();
    const deps = fakeEngine({ scopes: [fakeScope({ root: box.project, targets: ['claude'] })] });
    const r = await palm(box, ['install', 'superpowers'], { deps });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expectTranscript(
      r.stderr,
      `
x "superpowers" is not a repository. palm installs from git repositories:
    palm install <owner/repo> [names...]      for example  palm install obra/superpowers
  Not sure which repository? https://github.com/search?q=superpowers+SKILL.md&type=code`,
    );
  });

  it('palm install obra/superpowers: what it offers, nothing written', async () => {
    const box = await nora();
    const deps = fakeEngine({
      scopes: [fakeScope({ root: box.project, targets: ['claude'] })],
      listSource: async () => superpowersListing(),
    });
    const r = await palm(box, ['install', 'obra/superpowers'], { deps });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expectTranscript(
      r.stdout,
      `
obra/superpowers  v4.0.3 (a1b2c3d)   15 skills, 1 hook
  skill  brainstorming             Explore requirements before writing code
  skill  test-driven-development   Write the failing test first
  ...
  hook   session-start             claude: SessionStart -> hooks/run-hook.cmd   (a program; asks before installing)
Nothing written. Install some:
    palm install obra/superpowers brainstorming test-driven-development
    palm install obra/superpowers --all`,
    );
    expect(deps.calls.installFromSource).toBeUndefined();
  });

  it('palm install obra/superpowers --all: 15 installed, the hook asks first', async () => {
    const box = await nora();
    const files = (n: string, count: number) =>
      Array.from({ length: count }, (_, i) => `.claude/skills/${n}/${i ? `ref-${i}.md` : 'SKILL.md'}`);
    const skills = SKILLS.map(([n], i) =>
      outcome(skillEntry(n, 'obra/superpowers', files(n, i === 0 ? 3 : 1))),
    );
    const hook = lockEntry({ kind: 'hook', name: 'session-start', source: 'obra/superpowers', declined: true });
    const lockSources = { 'obra/superpowers': { ref: '^4', resolved: 'v4.0.3', sha: 'a1b2c3d' } };
    const deps = fakeEngine({
      scopes: [
        fakeScope({ root: box.project, targets: ['claude'] }),
        fakeScope({ root: box.project, manifestTargets: ['claude'], lockSources }),
      ],
      installFromSource: async () => ({
        outcomes: [...skills, outcome(hook, 'skipped')],
        failures: [],
        warnings: [],
      }),
    });
    const r = await palm(box, ['install', 'obra/superpowers', '--all'], { deps });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expectTranscript(
      r.stdout,
      `
targets: claude   (detected from .claude/; change targets: in palm.yaml)
+ skill  brainstorming             .claude/skills/brainstorming/   3 files
  ... 14 more
! hook   session-start             runs a program on your machine; not installed
    see it:      palm install obra/superpowers session-start --dry-run
    install it:  palm install obra/superpowers session-start
15 installed. Commit palm.yaml, palm.lock.yaml and .claude/ together.`,
    );
    expect(deps.calls.installFromSource?.[0]?.[0]).toEqual({
      source: 'obra/superpowers',
      names: [],
      all: true,
    });
  });
});

describe('Lena: Cursor only, typed a skill name first', () => {
  it('palm install tdd: the fix names the repository', async () => {
    sb = await sandbox();
    await mkdir(join(sb.project, '.cursor'), { recursive: true });
    const deps = fakeEngine({ scopes: [fakeScope({ root: sb.project, targets: ['cursor'] })] });
    const r = await palm(sb, ['install', 'tdd'], { deps });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expectTranscript(
      r.stderr,
      `
x "tdd" is not a repository. palm installs from git repositories:
    palm install <owner/repo> tdd             for example  palm install mattpocock/skills tdd`,
    );
  });

  it('palm install mattpocock/skills tdd: one skill, one carrier', async () => {
    sb = await sandbox();
    await mkdir(join(sb.project, '.cursor'), { recursive: true });
    const tdd = skillEntry('tdd', 'mattpocock/skills', ['.agents/skills/tdd/SKILL.md']);
    const lockSources = { 'mattpocock/skills': { ref: '^1', resolved: 'v1.2.3', sha: '8be01d4' } };
    const deps = fakeEngine({
      scopes: [
        fakeScope({ root: sb.project, targets: ['cursor'] }),
        fakeScope({ root: sb.project, manifestTargets: ['cursor'], lockSources }),
      ],
      installFromSource: async () => ({
        outcomes: [outcome(tdd, 'installed', ['Cursor reads .agents/skills'])],
        failures: [],
        warnings: [],
      }),
    });
    const r = await palm(sb, ['install', 'mattpocock/skills', 'tdd'], { deps });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expectTranscript(
      r.stdout,
      `
targets: cursor   (detected from .cursor/; change targets: in palm.yaml)
+ skill  tdd   .agents/skills/tdd/   1 file   from mattpocock/skills v1.2.3   (Cursor reads .agents/skills)
1 installed. Commit palm.yaml, palm.lock.yaml and .agents/ together.`,
    );
    expect(deps.calls.installFromSource?.[0]?.[0]).toEqual({
      source: 'mattpocock/skills',
      names: [{ name: 'tdd' }],
    });
  });

  it('never says "origin" on the onboarding path', async () => {
    sb = await sandbox();
    const deps = fakeEngine({ scopes: [fakeScope({ root: sb.project })] });
    const r = await palm(sb, ['install', 'tdd'], { deps });
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/origin/i);
  });
});
