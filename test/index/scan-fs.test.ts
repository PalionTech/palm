import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPalmError } from '../../src/core/errors.js';
import { scanOrigin } from '../../src/index/scan.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'palm-scan-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function put(rel: string, content: string | object): Promise<void> {
  const file = join(tmp, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

const skillMd = (name: string, description = `${name} skill`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const run = (root = join(tmp, 'repo')) => scanOrigin(root, { alias: 'repo', type: 'local', path: root });

describe('scanOrigin filesystem edge cases', () => {
  it('reports an empty origin', async () => {
    await mkdir(join(tmp, 'repo'));
    expect(await run()).toEqual({ entities: [], warnings: [], detected: 'empty' });
  });

  it('throws E_IO for a missing root', async () => {
    const err = await run(join(tmp, 'nope')).catch((e: unknown) => e);
    expect(isPalmError(err) && err.code).toBe('E_IO');
  });

  it('follows in-repo symlinks once, skips links leaving the origin, and survives loops', async () => {
    await put('repo/skills/real/SKILL.md', skillMd('real'));
    await put('outside/escape/SKILL.md', skillMd('escape'));
    await put('repo/examples/shared/SKILL.md', skillMd('shared'));
    await mkdir(join(tmp, 'repo/linked'), { recursive: true });
    await symlink('../skills/real', join(tmp, 'repo/linked/alias'));
    await symlink(join(tmp, 'outside/escape'), join(tmp, 'repo/skills/escape'));
    await symlink('..', join(tmp, 'repo/skills/loop'));
    await symlink('../examples/shared', join(tmp, 'repo/skills/shared'));
    await put('repo/agents/real.md', '---\nname: real-agent\ndescription: d\n---\nbody\n');
    await symlink('real.md', join(tmp, 'repo/agents/alias.md'));

    const r = await run();
    expect(r.entities.map((e) => `${e.kind}:${e.name} ${e.path}`).sort()).toEqual([
      'agent:real-agent agents/real.md',
      'skill:real skills/real',
      // examples/ is ignored, but a link from a scanned directory into it is followed.
      'skill:shared skills/shared',
    ]);
    expect(r.warnings).toEqual(['skipped symlink skills/escape: points outside the origin']);
  });

  it('indexes a marketplace plugin that lives in an ignored directory', async () => {
    await put('repo/.claude-plugin/marketplace.json', { name: 'm', plugins: [{ name: 'demo', source: './examples/demo' }] });
    await put('repo/examples/demo/.claude-plugin/plugin.json', { name: 'demo', version: '0.0.1' });
    await put('repo/examples/demo/skills/hello/SKILL.md', skillMd('hello'));
    await put('repo/examples/other/SKILL.md', skillMd('other'));
    const r = await run();
    expect(r.entities.map((e) => `${e.kind}:${e.name} ${e.path}${e.plugin ? ` <${e.plugin}>` : ''}`).sort()).toEqual([
      'plugin:demo examples/demo',
      'skill:hello examples/demo/skills/hello <demo>',
    ]);
  });

  it('warns about invalid manifests and marketplaces instead of failing', async () => {
    await put('repo/.claude-plugin/marketplace.json', '{ not json');
    await put('repo/.claude-plugin/plugin.json', '{ also not json');
    await put('repo/.cursor-plugin/plugin.json', { name: 'fallback', skills: './skills/' });
    await put('repo/skills/a/SKILL.md', skillMd('a'));
    await put('repo/skills/b/SKILL.md', '# no frontmatter\n');
    await put('repo/.mcp.json', '{ broken');
    const r = await run();
    expect(r.detected).toBe('plugin-manifest');
    expect(r.entities.map((e) => `${e.kind}:${e.name}`).sort()).toEqual(['plugin:fallback', 'skill:a']);
    expect(r.warnings).toEqual([
      expect.stringMatching(/^invalid JSON in \.claude-plugin\/plugin\.json/),
      expect.stringMatching(/^ignored marketplace: invalid JSON in marketplace/),
      'skipped skills/b/SKILL.md: SKILL.md in "b" has no YAML frontmatter',
      expect.stringMatching(/^skipped \.mcp\.json: invalid JSON/),
    ]);
  });

  it('a Claude plugin: declared agents replace the default directory, declared skills add to it', async () => {
    await put('repo/.claude-plugin/plugin.json', {
      name: 'p',
      skills: ['./extra-skills/x'],
      agents: ['./custom/reviewer.md'],
      commands: './cmds/',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
      mcpServers: { inline: { command: 'npx', args: ['inline-server'] } },
    });
    await put('repo/skills/default/SKILL.md', skillMd('default'));
    await put('repo/extra-skills/x/SKILL.md', skillMd('x'));
    await put('repo/custom/reviewer.md', '---\nname: reviewer\ndescription: Reviews\n---\nReview.\n');
    await put('repo/agents/unlisted.md', '---\nname: unlisted\ndescription: Not declared\n---\nx\n');
    await put('repo/cmds/go.md', '---\ndescription: Go\n---\nGo.\n');
    await put('repo/commands/default-cmd.md', '---\ndescription: default\n---\nNot used.\n');
    await put('repo/hooks/hooks.json', { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }] } });
    await put('repo/.mcp.json', { mcpServers: { file: { url: 'https://example.com/mcp' } } });
    const r = await run();
    const plugin = r.entities.find((e) => e.kind === 'plugin');
    expect(plugin?.def.kind === 'plugin' && plugin.def.members.map((m) => `${m.kind}:${m.name}`).sort()).toEqual([
      'agent:reviewer',
      'command:go',
      'hook:p',
      'mcp:file',
      'mcp:inline',
      'skill:default',
      'skill:x',
    ]);
    const hook = r.entities.find((e) => e.kind === 'hook');
    expect(hook?.def.kind === 'hook' && Object.keys((hook.def.hooks.raw as { hooks: object }).hooks).sort()).toEqual(['SessionStart', 'Stop']);
    expect(r.entities.find((e) => e.name === 'unlisted')?.plugin).toBeUndefined();
    expect(r.warnings).toEqual([expect.stringMatching(/plugin "p" at \. does not declare 1 agent \(unlisted\), 1 command \(default-cmd\); indexed standalone/)]);
  });

  it('falls back to the other rules when apm.yml has no primitives', async () => {
    await put('repo/apm.yml', 'name: empty-pkg\nversion: 1.0.0\n');
    await put('repo/.apm/README.md', '# nothing here\n');
    await put('repo/skills/a/SKILL.md', skillMd('a'));
    const r = await run();
    expect(r.detected).toBe('convention');
    expect(r.entities.map((e) => `${e.kind}:${e.name}`)).toEqual(['skill:a']);
    expect(r.warnings).toEqual(['apm.yml: APM package has no primitives under .apm/; scanning the repository instead']);
  });

  it('keeps one hooks dialect per plugin and warns about the other', async () => {
    await put('repo/.claude-plugin/plugin.json', { name: 'mixed', hooks: './hooks/hooks-cursor.json' });
    await put('repo/hooks/hooks-cursor.json', { version: 1, hooks: { stop: [{ command: 'echo cursor' }] } });
    await put('repo/hooks/hooks.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo claude' }] }] } });
    const r = await run();
    const hook = r.entities.find((e) => e.kind === 'hook');
    expect(hook).toMatchObject({ name: 'mixed', path: 'hooks/hooks-cursor.json', def: { hooks: { dialect: 'cursor' } } });
    expect(r.warnings).toEqual(['plugin mixed: hooks in hooks/hooks.json use the claude dialect (primary cursor); ignored']);
  });

  it('scans a cursor/plugins-sized repository (~4k files) in under 2 seconds', async () => {
    const plugins = 100;
    const writes: Array<Promise<void>> = [];
    const entries: Array<{ name: string; source: string }> = [];
    for (let p = 0; p < plugins; p++) {
      const dir = `repo/plugin-${p}`;
      entries.push({ name: `plugin-${p}`, source: `plugin-${p}` });
      writes.push(put(`${dir}/.cursor-plugin/plugin.json`, { name: `plugin-${p}`, version: '1.0.0', skills: './skills/', agents: './agents/' }));
      writes.push(put(`${dir}/mcp.json`, { mcpServers: { [`server-${p}`]: { type: 'http', url: `https://s${p}.example.com/mcp` } } }));
      writes.push(put(`${dir}/README.md`, '# readme\n'));
      for (let s = 0; s < 5; s++) {
        const sd = `${dir}/skills/skill-${p}-${s}`;
        writes.push(put(`${sd}/SKILL.md`, skillMd(`skill-${p}-${s}`)));
        for (let f = 0; f < 5; f++) writes.push(put(`${sd}/references/ref-${f}.md`, `# ref ${f}\n`));
        writes.push(put(`${sd}/scripts/run.py`, 'print(1)\n'));
      }
      for (let a = 0; a < 3; a++) writes.push(put(`${dir}/agents/agent-${p}-${a}.md`, `---\nname: agent-${p}-${a}\ndescription: d\n---\nbody\n`));
      writes.push(put(`${dir}/rules/rule-${p}.mdc`, '---\nalwaysApply: true\n---\nrule\n'));
      writes.push(put(`${dir}/assets/logo.svg`, '<svg/>'));
    }
    writes.push(put('repo/.cursor-plugin/marketplace.json', { name: 'big', plugins: entries }));
    await Promise.all(writes);

    const started = performance.now();
    const r = await run();
    const elapsed = performance.now() - started;
    const count = (k: string) => r.entities.filter((e) => e.kind === k).length;
    expect({ plugins: count('plugin'), skills: count('skill'), agents: count('agent'), mcp: count('mcp'), rules: count('instruction') }).toEqual({
      plugins: 100,
      skills: 500,
      agents: 300,
      mcp: 100,
      rules: 100,
    });
    expect(elapsed).toBeLessThan(2000);
  });
});
