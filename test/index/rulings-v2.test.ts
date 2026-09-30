/**
 * Rulings of the 0.2 persona rerun (FINDINGS-v2.md) on the index side: one test per ruling id.
 */
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entity, ScanResult, Source } from '../../src/core/types.js';
import { parseLayoutFlags } from '../../src/index/layout-flags.js';
import { putFile, removeDir, tempDir } from '../support/sandbox.js';
import { scanSource } from './helpers.js';

const FILL = 'Zx8kQ2mN7pL4vR9t';
const TOKEN = `ghp_${FILL.repeat(3).slice(0, 36)}`;

let tmp: string;
beforeEach(async () => {
  tmp = await tempDir('palm-rulings-');
});
afterEach(async () => removeDir(tmp));

const put = (rel: string, content: string | object) => putFile(tmp, rel, content);
const run = (extra: Partial<Source> = {}) =>
  scanSource(tmp, { name: './kit', type: 'local', path: tmp, ...extra });

const skillMd = (name: string, description = `${name} skill`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function find(r: ScanResult, kind: Entity['kind'], name: string): Entity {
  const e = r.entities.find((x) => x.kind === kind && x.name === name);
  if (!e) throw new Error(`no ${kind} ${name} in ${r.entities.map((x) => x.name).join(', ')}`);
  return e;
}

const kindNames = (r: ScanResult): string[] =>
  r.entities.map((e) => `${e.kind}:${e.name} ${e.path}`).sort();

describe('Y2 a root SKILL.md never copies harness configs and keys', () => {
  it('Y2 a literal key in a harness config of a root skill is not scanned as skill content', async () => {
    await put('SKILL.md', skillMd('inboundctl'));
    await put('.cursor/mcp.json', { mcpServers: { x: { headers: { 'x-api-key': TOKEN } } } });
    await put('.claude/settings.json', { env: { GITHUB_TOKEN: TOKEN } });
    await put('.env', `API_TOKEN=${TOKEN}\n`);
    await put('palm.lock.yaml', `token: ${TOKEN}\n`);
    await put('docs/guide.md', 'plain text\n');
    const r = await run();
    const skill = find(r, 'skill', 'inboundctl');
    expect(skill.issues).toBeUndefined();
  });

  it('Y2 every copied file of a skill is secret-scanned: a literal refuses the skill', async () => {
    await put('skills/leaky/SKILL.md', skillMd('leaky'));
    await put('skills/leaky/scripts/call.sh', `curl -H "Authorization: token ${TOKEN}" x\n`);
    const r = await run();
    const issues = find(r, 'skill', 'leaky').issues ?? [];
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'secret-literal',
        severity: 'critical',
        file: 'skills/leaky/scripts/call.sh',
      }),
    ]);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('Y2 agents and instructions are scanned as they are copied', async () => {
    await put(
      'agents/caller.md',
      `---\nname: caller\ndescription: calls\n---\nUse the key ${TOKEN}\n`,
    );
    await put('rules/keys.mdc', `---\nalwaysApply: true\n---\nexport GH=${TOKEN}\n`);
    const r = await run();
    expect(find(r, 'agent', 'caller').issues?.[0]?.severity).toBe('critical');
    expect(find(r, 'instruction', 'keys').issues?.[0]?.code).toBe('secret-literal');
  });
});

describe('C4 only the top-most SKILL.md is an entity', () => {
  it('C4 nested references/*/SKILL.md are content of their skill', async () => {
    await put('skills/react-native/SKILL.md', skillMd('react-native'));
    await put('skills/react-native/references/animations/SKILL.md', skillMd('animations'));
    await put('skills/react-native/references/svg/SKILL.md', skillMd('svg'));
    await put('skills/other/SKILL.md', skillMd('other'));
    const r = await run();
    expect(kindNames(r)).toEqual([
      'skill:other skills/other',
      'skill:react-native skills/react-native',
    ]);
  });

  it('C4 a plugin with a skills/ folder does not list nested skills either', async () => {
    await put('.claude-plugin/plugin.json', { name: 'rn' });
    await put('skills/best/SKILL.md', skillMd('best'));
    await put('skills/best/references/audio/SKILL.md', skillMd('audio'));
    const r = await run();
    expect(kindNames(r)).toEqual(['plugin:rn .', 'skill:best skills/best']);
  });

  it('C4 an output directory reached through a symlink is not scanned', async () => {
    await put('skills/own/SKILL.md', skillMd('own'));
    await put('.claude/skills/copied/SKILL.md', skillMd('copied'));
    await symlink('.claude/skills', join(tmp, 'mirror'));
    await mkdir(join(tmp, 'kit'));
    await symlink('../.claude', join(tmp, 'kit/claude'));
    const r = await run();
    expect(kindNames(r)).toEqual(['skill:own skills/own']);
  });
});

describe('B13 rules/*.md and skipped skills under ignored names', () => {
  it('B13 rules/*.md files are instructions by convention', async () => {
    await put('rules/style.md', '---\ndescription: house style\npaths: ["src/**"]\n---\nTabs.\n');
    await put('rules/README.md', '# Rules\n');
    const r = await run();
    expect(kindNames(r)).toEqual(['instruction:style rules/style.md']);
  });

  it('B13 a SKILL.md under an ignored name is listed with the layout that indexes it', async () => {
    await put('skills/lint/SKILL.md', skillMd('lint'));
    await put('skills/test/SKILL.md', skillMd('test'));
    const r = await run();
    expect(kindNames(r)).toEqual(['skill:lint skills/lint']);
    expect(r.warnings).toEqual([
      'skipped skills/test/SKILL.md (ignored name "test"; add layout: { skills: [skills/*] })',
    ]);
    const withLayout = await run({ layout: { skills: ['skills/*'] } });
    expect(kindNames(withLayout)).toEqual(['skill:lint skills/lint', 'skill:test skills/test']);
  });
});

describe('K2 near-miss lines and layout globs', () => {
  const agent = (name: string) =>
    `---\nname: ${name}\ndescription: ${name} agent\nmodel: sonnet\nskills: [review]\n---\nBody.\n`;

  it('K2 agent- and MCP-shaped files outside scanned folders get a pasteable layout', async () => {
    await put('packages/review/SKILL.md', skillMd('review'));
    await put('rules/style.mdc', '---\nalwaysApply: true\n---\nStyle.\n');
    await put('people/reviewer.md', agent('reviewer'));
    await put('people/oncall.md', agent('oncall'));
    await put('mcp/servers.json', { mcpServers: { docs: { url: 'https://example.com/mcp' } } });
    await put('notes/plain.md', '---\ntitle: notes\n---\nNot an agent.\n');
    await put('crew/lead.md', agent('lead'));
    await put('crew/README.md', '# Crew\n');
    const r = await run();
    const layout =
      'add layout: { skills: [packages/*], agents: [crew/lead.md, people/*.md], instructions: [rules/style.mdc], mcp: [mcp/servers.json] }';
    expect(r.warnings).toEqual([
      `3 agent-shaped files not indexed: crew/lead.md, people/*.md; ${layout}`,
      `1 MCP-shaped file not indexed: mcp/servers.json; ${layout}`,
    ]);
    const pasted = await run({
      layout: {
        skills: ['packages/*'],
        agents: ['crew/lead.md', 'people/*.md'],
        instructions: ['rules/style.mdc'],
        mcp: ['mcp/servers.json'],
      },
    });
    expect(kindNames(pasted)).toEqual([
      'agent:lead crew/lead.md',
      'agent:oncall people/oncall.md',
      'agent:reviewer people/reviewer.md',
      'instruction:style rules/style.mdc',
      'mcp:docs mcp/servers.json',
      'skill:review packages/review',
    ]);
    expect(pasted.warnings).toEqual([]);
  });

  it('K2 a hook-shaped JSON outside hooks/ is a near miss; a twin inside hooks/ is not', async () => {
    const hooks = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } };
    await put('hooks/hooks.json', hooks);
    await put('hooks/hooks-cursor.json', { version: 1, hooks: { stop: [{ command: 'echo' }] } });
    await put('ci/guard.json', hooks);
    const r = await run();
    expect(r.warnings).toEqual([
      '1 hook-shaped file not indexed: ci/guard.json; add layout: { hooks: [ci/guard.json, hooks/hooks.json] }',
    ]);
  });

  it('K2 --layout kind=glob values become a layout descriptor', () => {
    expect(
      parseLayoutFlags([
        'agents=people/*.md',
        'skills=packages/*',
        'agent=crew/*.md',
        'rules=rules/*.mdc,more/*.md',
      ]),
    ).toEqual({
      agents: ['people/*.md', 'crew/*.md'],
      skills: ['packages/*'],
      instructions: ['rules/*.mdc', 'more/*.md'],
    });
    for (const bad of ['people/*.md', 'people=x/*.md', 'agents=', '=x'])
      expect(() => parseLayoutFlags([bad])).toThrow(/expected kind=glob/);
  });

  it('K2 a layout glob that matches nothing is a warning', async () => {
    await put('skills/a/SKILL.md', skillMd('a'));
    const r = await run({ layout: { skills: ['skills/*'], agents: ['people/*.md', 'crew/*.md'] } });
    expect(kindNames(r)).toEqual(['skill:a skills/a']);
    expect(r.warnings).toEqual([
      'layout agents: "people/*.md" matches nothing in the source',
      'layout agents: "crew/*.md" matches nothing in the source',
    ]);
  });
});

describe('C21 a marketplace entry naming its own repository', () => {
  const url = 'https://github.com/Acme/skills.git';

  it('C21 is scanned as a local plugin, with no remote-plugin warning', async () => {
    await put('.claude-plugin/marketplace.json', {
      name: 'acme',
      plugins: [
        { name: 'skills', source: { source: 'github', repo: 'acme/skills' } },
        { name: 'extra', source: { source: 'url', url: 'https://github.com/acme/skills' } },
        { name: 'other', source: { source: 'github', repo: 'acme/other' } },
      ],
    });
    await put('skills/lint/SKILL.md', skillMd('lint'));
    const r = await run({ name: 'acme/skills', type: 'git', url, path: undefined });
    expect(kindNames(r)).toEqual(['plugin:extra .', 'plugin:skills .', 'skill:lint skills/lint']);
    expect(r.warnings).toEqual([
      expect.stringMatching(/^remote plugin "other" \(github:acme\/other\) not fetched/),
    ]);
  });

  it('C21 a path inside the repository is rebased onto the source root', async () => {
    await put('.claude-plugin/marketplace.json', {
      name: 'acme',
      plugins: [
        {
          name: 'fmt',
          source: { source: 'git-subdir', url, path: 'kit/plugins/fmt' },
        },
      ],
    });
    await put('plugins/fmt/skills/fmt/SKILL.md', skillMd('fmt'));
    const r = await run({
      name: 'acme/skills/kit',
      type: 'git',
      url,
      root: 'kit',
      path: undefined,
    });
    expect(kindNames(r)).toEqual(['plugin:fmt plugins/fmt', 'skill:fmt plugins/fmt/skills/fmt']);
    expect(r.warnings).toEqual([]);
  });
});

describe('B12 and Y3 on the index side', () => {
  it('B12 a Claude rule is claude-md and keeps its file name; Cursor keys make it md', async () => {
    await put('rules/React-Rules.md', '---\ndescription: React\npaths: ["src/**"]\n---\nHooks.\n');
    await put('rules/legacy.md', '---\nglobs: src/**\nalwaysApply: false\n---\nOld.\n');
    const r = await run();
    expect(find(r, 'instruction', 'react-rules').def).toMatchObject({
      instruction: { sourceFormat: 'claude-md', fileName: 'React-Rules.md', activation: 'paths' },
    });
    expect(find(r, 'instruction', 'legacy').def).toMatchObject({
      instruction: { sourceFormat: 'md', activation: 'paths' },
    });
  });

  it('Y3 the index carries the activation describe shows', async () => {
    await put('rules/review.mdc', '---\ndescription: Use when reviewing\n---\nReview.\n');
    const r = await run();
    expect(find(r, 'instruction', 'review').def).toMatchObject({
      instruction: { activation: 'on-request' },
    });
  });
});
