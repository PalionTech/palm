/**
 * Rulings of the second 0.2 persona rerun (FINDINGS-v3.md) on the index notes: what the listing,
 * the install and `describe` show about what a scan left out. One test per ruling id.
 */
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entity, ScanResult, Source } from '../../src/core/types.js';
import { Lock } from '../../src/domain/lock.js';
import { commandSkillClashes } from '../../src/index/command-clashes.js';
import {
  excludedMentions,
  excludedReferenceNote,
  hookReadsExcluded,
} from '../../src/index/excluded-refs.js';
import { nearMissFor } from '../../src/index/near-miss-lookup.js';
import { indexNotes } from '../../src/index/notes.js';
import { hookCommandSummary, pasteOffer } from '../../src/index/offer.js';
import { listSkillFiles } from '../../src/targets/fs-utils.js';
import { putFile, removeDir, tempDir } from '../support/sandbox.js';
import { scanSource } from './helpers.js';

let tmp: string;
beforeEach(async () => {
  tmp = await tempDir('palm-notes-v3-');
});
afterEach(async () => removeDir(tmp));

const put = (rel: string, content: string | object) => putFile(tmp, rel, content);
const run = (root = tmp, extra: Partial<Source> = {}) =>
  scanSource(root, { name: './kit', type: 'local', path: root, ...extra });

const skillMd = (name: string, body = `# ${name}\n`) =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}`;
const agentMd = (name: string, extra = 'model: sonnet\n') =>
  `---\nname: ${name}\ndescription: ${name} agent\n${extra}---\nReview.\n`;

function find(r: ScanResult, kind: Entity['kind'], name: string): Entity {
  const e = r.entities.find((x) => x.kind === kind && x.name === name);
  if (!e) throw new Error(`no ${kind} ${name} in ${r.entities.map((x) => x.name).join(', ')}`);
  return e;
}

/** Kenji's kit: skills by convention, agents under people/, a server file under mcp/. */
async function kenjiKit(): Promise<ScanResult> {
  await put('skills/review/SKILL.md', skillMd('review'));
  await put('people/reviewer.md', agentMd('reviewer'));
  await put('people/oncall.md', agentMd('oncall'));
  await put('mcp/servers.json', { mcpServers: { slack: { command: 'npx', args: ['slack'] } } });
  return run();
}

describe('N1 near-miss and zero-match notes print in the listing and at install', () => {
  it('N1 a declared source: the near misses, then the layout that indexes them, once', async () => {
    const r = await kenjiKit();
    const notes = indexNotes(r.warnings, { declared: true });
    expect(notes.shown).toEqual([
      '2 agent-shaped files not indexed: people/*.md',
      '1 MCP-shaped file not indexed: mcp/servers.json',
      'add layout: { skills: [skills/*], agents: [people/*.md], mcp: [mcp/servers.json] }',
    ]);
    expect(notes.rest).toEqual([]);
  });

  it('N1 an undeclared source: the same notes with --layout flags on its install line', async () => {
    const r = await kenjiKit();
    const install = (args: readonly string[]) =>
      [
        'palm install ./company-agent-kit',
        ...args.map((a) => (a.includes('*') ? `'${a}'` : a)),
      ].join(' ');
    expect(indexNotes(r.warnings, { declared: false, install }).shown.at(-1)).toBe(
      "to index them: palm install ./company-agent-kit --layout 'skills=skills/*' --layout 'agents=people/*.md' --layout mcp=mcp/servers.json",
    );
    expect(indexNotes(r.warnings, { declared: false }).shown.at(-1)).toBe(
      "to index them, add --layout 'skills=skills/*' --layout 'agents=people/*.md' --layout mcp=mcp/servers.json",
    );
  });

  it('N1 a layout glob that matches nothing is a shown note', async () => {
    await put('people/reviewer.md', agentMd('reviewer'));
    const r = await run(tmp, { layout: { agents: ['peopel/*.md'] } });
    expect(indexNotes(r.warnings, { declared: true }).shown).toEqual([
      'layout agents: "peopel/*.md" matches nothing in the source',
    ]);
  });

  it('N1 a SKILL.md under an ignored name keeps its own layout suggestion', async () => {
    await put('skills/review/SKILL.md', skillMd('review'));
    await put('skills/test/SKILL.md', skillMd('test'));
    const r = await run();
    expect(indexNotes(r.warnings, { declared: false }).shown).toEqual([
      'skipped skills/test/SKILL.md (ignored name "test"); to index them, add --layout \'skills=skills/*\'',
    ]);
  });

  it('N1 the not-found name in a near-miss file is named, with the layout that indexes it', async () => {
    const r = await kenjiKit();
    const hit = nearMissFor({ root: tmp, warnings: r.warnings }, 'reviewer');
    expect(hit?.message).toBe('people/reviewer.md looks like an agent but is not indexed');
    expect(hit?.layoutArgs).toEqual([
      '--layout',
      'skills=skills/*',
      '--layout',
      'agents=people/*.md',
      '--layout',
      'mcp=mcp/servers.json',
    ]);
    expect(nearMissFor({ root: tmp, warnings: r.warnings }, 'slack')?.message).toBe(
      'mcp/servers.json holds an MCP server named slack but is not indexed',
    );
    expect(nearMissFor({ root: tmp, warnings: r.warnings }, 'nobody')).toBeUndefined();
  });
});

describe("R1' the APM dependency lines are shown notes", () => {
  it("R1' dependencies.apm prints in the listing, not behind the count line", async () => {
    await put('apm.yml', 'name: kolu\ndependencies:\n  apm:\n    - srid/agency\n');
    await put('.apm/skills/one/SKILL.md', skillMd('one'));
    const r = await run();
    expect(indexNotes(r.warnings, { declared: true }).shown).toEqual([
      'apm.yml: 1 dependency is not installed; declare what you need: palm install srid/agency',
    ]);
  });

  it("R1' dependencies.mcp gets one note with the command that installs each server (R10')", async () => {
    await put(
      'apm.yml',
      [
        'name: chrome',
        'dependencies:',
        '  mcp:',
        '    - name: chrome-devtools',
        '      registry: false',
        '      transport: stdio',
        '      command: .agents/skills/chrome/bin/serve',
        '    - io.github.github/github-mcp-server',
        '',
      ].join('\n'),
    );
    await put('.apm/skills/chrome/SKILL.md', skillMd('chrome'));
    const r = await run();
    expect(indexNotes(r.warnings, { declared: true }).shown).toEqual([
      "apm.yml: 2 MCP server dependencies are not installed (chrome-devtools, io.github.github/github-mcp-server); palm installs a server with: palm install mcp chrome-devtools --command .agents/skills/chrome/bin/serve; palm install mcp --snippet <the JSON from io.github.github/github-mcp-server's README>",
    ]);
  });
});

describe('S5 a link leaving a fetched source gets one note', () => {
  it('S5 a dangling link to a file outside the checkout is named at index time', async () => {
    const root = join(tmp, 'checkout');
    await put('checkout/skills/review/SKILL.md', skillMd('review'));
    await mkdir(join(root, 'skills/review/references'), { recursive: true });
    await symlink(
      '../../../../outside-secret.txt',
      join(root, 'skills/review/references/secret.md'),
    );
    await put('elsewhere/marker.txt', 'x\n');
    await symlink(join(tmp, 'elsewhere/marker.txt'), join(root, 'skills/review/marker.md'));
    const r = await run(root, { type: 'git', url: 'https://example.com/kit.git' });
    const note =
      'not copied (links leaving the source): skills/review/marker.md, skills/review/references/secret.md';
    expect(r.warnings).toEqual([note]);
    expect(indexNotes(r.warnings, { declared: false }).shown).toEqual([note]);
  });

  it('S5 the skill copy names the dangling link like any link leaving the source', async () => {
    const root = join(tmp, 'checkout');
    await put('checkout/skills/review/SKILL.md', skillMd('review'));
    await mkdir(join(root, 'skills/review/references'), { recursive: true });
    await symlink(
      '../../../../outside-secret.txt',
      join(root, 'skills/review/references/secret.md'),
    );
    await symlink('missing-inside.md', join(root, 'skills/review/broken.md'));
    const listed = await listSkillFiles(join(root, 'skills/review'), { boundary: root });
    expect(listed.symlinksOutside).toEqual(['references/secret.md']);
    expect(listed.files.map((f) => f.rel)).toEqual(['SKILL.md']);
  });
});

describe('O21 a hook-only source offers hook:<name> and shows the whole command', () => {
  it('O21 the hook row names the whole command, the plugin root read as the plugin folder', async () => {
    await put('hooks/hooks.json', {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'go run .agents/hooks/main.go' }] }],
      },
    });
    const r = await run();
    const [hook] = r.entities;
    expect(hook && hookCommandSummary(hook)).toBe('claude: Stop -> go run .agents/hooks/main.go');
    const plugin = {
      ...(hook as Entity),
      def: {
        kind: 'hook' as const,
        hooks: {
          ...((hook as Entity).def as Extract<Entity['def'], { kind: 'hook' }>).hooks,
          raw: {
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
                    },
                  ],
                },
              ],
              Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/env true' }] }],
            },
          },
        },
      },
    };
    expect(hookCommandSummary(plugin)).toBe(
      'claude: SessionStart -> hooks/run-hook.cmd session-start (+1 more)',
    );
  });

  it('O21 a source of programs only pastes hook:<name>, never --all', async () => {
    await put('hooks/hooks.json', {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'go run main.go' }] }] },
    });
    const r = await run();
    expect(pasteOffer(r.entities, r.entities, () => true)).toEqual({
      names: [`hook:${r.entities[0]?.name}`],
      all: false,
    });
    await put('skills/review/SKILL.md', skillMd('review'));
    const both = await run();
    const isHook = (e: Entity) => e.kind === 'hook';
    expect(pasteOffer(both.entities, both.entities, isHook)).toEqual({
      names: ['review'],
      all: true,
    });
  });
});

describe("R18' a suggested layout never names a file palm's lock owns", () => {
  async function apmRoot(): Promise<void> {
    await put('apm.yml', 'name: odu\n');
    await put('.apm/skills/odu/SKILL.md', skillMd('odu'));
    await put('.mcp.json', { mcpServers: { odu: { command: 'odu-mcp' } } });
  }

  it("R18' without a lock the root .mcp.json is a near miss", async () => {
    await apmRoot();
    const r = await run();
    expect(indexNotes(r.warnings, { declared: true }).shown[0]).toBe(
      '1 MCP-shaped file not indexed: .mcp.json',
    );
  });

  it("R18' the .mcp.json palm's lock lists is never suggested", async () => {
    await apmRoot();
    const lock = new Lock().upsert({
      kind: 'mcp',
      name: 'odu',
      source: 'juspay/odu',
      path: '.mcp.json',
      content: 'sha256:0',
      render: {},
      files: [],
      merged: [{ file: '.mcp.json', at: '/mcpServers', id: 'palm:mcp:odu:0', key: 'odu' }],
    });
    await lock.save(join(tmp, 'palm.lock.yaml'));
    const r = await run();
    expect(r.warnings.filter((w) => w.includes('.mcp.json'))).toEqual([]);
  });
});

describe("Y11' command files beside same-named skills", () => {
  it("Y11' a command answering to an installed skill's name is a clash in every harness folder", async () => {
    await put('.cursor/commands/abuse-block.md', '# Block abuse\n');
    await put('.cursor/commands/unrelated.md', '# Other\n');
    await put('.github/prompts/abuse-block.prompt.md', '# Block abuse\n');
    await put('.claude/commands/Commit And Push.md', '# Commit\n');
    const clashes = await commandSkillClashes(tmp, new Set(['abuse-block', 'commit-and-push']));
    expect(clashes).toEqual([
      { name: 'commit-and-push', file: '.claude/commands/Commit And Push.md' },
      { name: 'abuse-block', file: '.cursor/commands/abuse-block.md' },
      { name: 'abuse-block', file: '.github/prompts/abuse-block.prompt.md' },
    ]);
  });
});

describe('M8 references to excluded plugin members', () => {
  async function superpowers(): Promise<ScanResult> {
    await put('.claude-plugin/plugin.json', { name: 'superpowers', version: '6.4.2' });
    await put(
      'skills/writing-plans/SKILL.md',
      skillMd('writing-plans', 'REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development\n'),
    );
    await put(
      'skills/subagent-driven-development/SKILL.md',
      skillMd('subagent-driven-development'),
    );
    await put('skills/using-superpowers/SKILL.md', skillMd('using-superpowers'));
    await put('agents/planner.md', agentMd('planner', 'skills: [subagent-driven-development]\n'));
    return run();
  }

  it('M8 describe names kept members that mention or preload an excluded one', async () => {
    const r = await superpowers();
    const excluded = [find(r, 'skill', 'subagent-driven-development')];
    const kept = [find(r, 'skill', 'writing-plans'), find(r, 'agent', 'planner')];
    const refs = await excludedMentions(tmp, 'superpowers', { kept, excluded });
    expect(refs.map(excludedReferenceNote)).toEqual([
      'skill writing-plans mentions superpowers:subagent-driven-development, which palm.yaml excludes',
      'agent planner preloads skill subagent-driven-development, which palm.yaml excludes',
    ]);
  });

  it('M8 a hook whose closure reads an excluded skill gets a notice', async () => {
    const r = await superpowers();
    await put('hooks/hooks.json', {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'bash hooks/start' }] }] },
    });
    const hook = find(await run(), 'hook', 'superpowers');
    const excluded = [find(r, 'skill', 'using-superpowers')];
    const closure = { paths: ['hooks/start'], reads: ['skills/using-superpowers/SKILL.md'] };
    expect(hookReadsExcluded(hook, excluded, closure).map(excludedReferenceNote)).toEqual([
      'hook superpowers reads skills/using-superpowers/SKILL.md of the excluded skill using-superpowers; its text still reaches the model',
    ]);
    expect(hookReadsExcluded(hook, excluded, { paths: ['hooks/start'] })).toEqual([]);
  });
});

describe("R3' a layout is merged with what detection found", () => {
  it("R3' the plugin a manifest declares stays indexed beside the layout's globs", async () => {
    await put('.claude-plugin/plugin.json', { name: 'sp', version: '1.0.0' });
    await put('skills/plans/SKILL.md', skillMd('plans'));
    await put('people/reviewer.md', agentMd('reviewer'));
    const r = await run(tmp, { layout: { skills: ['skills/*'], agents: ['people/*.md'] } });
    expect(find(r, 'plugin', 'sp').kind).toBe('plugin');
    expect(find(r, 'agent', 'reviewer').kind).toBe('agent');
    expect(find(r, 'skill', 'plans').kind).toBe('skill');
    expect(r.entities.filter((e) => e.name === 'plans')).toHaveLength(1);
  });
});
