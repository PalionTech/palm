/**
 * Rulings of the 0.2 persona rerun (FINDINGS-v2.md) on the index side: one test per ruling id.
 */
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entity, ScanResult, Source } from '../../src/core/types.js';
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
