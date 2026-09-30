import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPalmError } from '../../src/core/errors.js';
import { putFile } from '../support/sandbox.js';
import { writeSyntheticOrigin } from '../support/synthetic.js';
import { scanSource } from './helpers.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'palm-scan-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const put = (rel: string, content: string | object): Promise<void> => putFile(tmp, rel, content);

const skillMd = (name: string, description = `${name} skill`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const run = (root = join(tmp, 'repo')) =>
  scanSource(root, { name: './repo', type: 'local', path: root });

const kindNames = (r: Awaited<ReturnType<typeof run>>): string[] =>
  r.entities.map((e) => `${e.kind}:${e.name} ${e.path}`).sort();

describe('scanSource filesystem edge cases', () => {
  it('reports an empty source', async () => {
    await mkdir(join(tmp, 'repo'));
    expect(await run()).toEqual({ entities: [], warnings: [], detected: 'empty' });
  });

  it('throws E_IO for a missing root', async () => {
    const err = await run(join(tmp, 'nope')).catch((e: unknown) => e);
    expect(isPalmError(err) && err.code).toBe('E_IO');
  });

  it('follows in-repo symlinks once, skips links leaving the source, and survives loops', async () => {
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
    expect(r.warnings).toEqual(['skipped symlink skills/escape: points outside the source']);
  });

  it('indexes a marketplace plugin that lives in an ignored directory', async () => {
    await put('repo/.claude-plugin/marketplace.json', {
      name: 'm',
      plugins: [{ name: 'demo', source: './examples/demo' }],
    });
    await put('repo/examples/demo/.claude-plugin/plugin.json', { name: 'demo', version: '0.0.1' });
    await put('repo/examples/demo/skills/hello/SKILL.md', skillMd('hello'));
    await put('repo/examples/other/SKILL.md', skillMd('other'));
    const r = await run();
    expect(
      r.entities
        .map((e) => `${e.kind}:${e.name} ${e.path}${e.plugin ? ` <${e.plugin}>` : ''}`)
        .sort(),
    ).toEqual(['plugin:demo examples/demo', 'skill:hello examples/demo/skills/hello <demo>']);
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
    expect(r.entities.map((e) => `${e.kind}:${e.name}`).sort()).toEqual([
      'plugin:fallback',
      'skill:a',
    ]);
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
    await put(
      'repo/custom/reviewer.md',
      '---\nname: reviewer\ndescription: Reviews\n---\nReview.\n',
    );
    await put(
      'repo/agents/unlisted.md',
      '---\nname: unlisted\ndescription: Not declared\n---\nx\n',
    );
    await put('repo/cmds/go.md', '---\ndescription: Go\n---\nGo.\n');
    await put('repo/commands/default-cmd.md', '---\ndescription: default\n---\nNot used.\n');
    await put('repo/hooks/hooks.json', {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }] },
    });
    await put('repo/.mcp.json', { mcpServers: { file: { url: 'https://example.com/mcp' } } });
    const r = await run();
    const plugin = r.entities.find((e) => e.kind === 'plugin');
    expect(
      plugin?.def.kind === 'plugin' && plugin.def.members.map((m) => `${m.kind}:${m.name}`).sort(),
    ).toEqual([
      'agent:reviewer',
      'hook:p',
      'mcp:file',
      'mcp:inline',
      'skill:default',
      'skill:go',
      'skill:x',
    ]);
    const hook = r.entities.find((e) => e.kind === 'hook');
    expect(
      hook?.def.kind === 'hook' &&
        Object.keys((hook.def.hooks.raw as { hooks: object }).hooks).sort(),
    ).toEqual(['SessionStart', 'Stop']);
    expect(r.entities.find((e) => e.name === 'unlisted')?.plugin).toBeUndefined();
    expect(r.warnings).toEqual([
      expect.stringMatching(
        /plugin "p" at \. does not declare 1 agent \(unlisted\), 1 skill \(default-cmd\); indexed standalone/,
      ),
    ]);
  });

  it('indexes commands/x.md, commands/x.toml and prompts/x.prompt.md as skills with a note', async () => {
    await put(
      'repo/commands/review.md',
      '---\ndescription: Review a PR\nargument-hint: [pr]\n---\nReview $ARGUMENTS.\n',
    );
    await put('repo/commands/deploy.toml', 'description = "Deploy"\nprompt = "Deploy {{args}}."\n');
    await put('repo/prompts/explain.prompt.md', '---\ndescription: Explain\n---\nExplain it.\n');
    const r = await run();
    expect(kindNames(r)).toEqual([
      'skill:deploy commands/deploy.toml',
      'skill:explain prompts/explain.prompt.md',
      'skill:review commands/review.md',
    ]);
    expect(r.entities.find((e) => e.name === 'review')).toEqual({
      kind: 'skill',
      name: 'review',
      description: 'Review a PR',
      path: 'commands/review.md',
      source: './repo',
      def: {
        kind: 'skill',
        skill: {
          name: 'review',
          description: 'Review a PR',
          fromCommand: {
            body: 'Review $ARGUMENTS.\n',
            argumentHint: '[pr]',
            sourceFormat: 'claude-md',
          },
        },
      },
      notes: ['from command review.md'],
    });
    expect(r.entities.some((e) => (e.kind as string) === 'command')).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('a skill wins over a command with the same name, whichever is found first', async () => {
    await put('repo/plugins/p/.claude-plugin/plugin.json', { name: 'p' });
    await put('repo/plugins/p/commands/review.md', '---\ndescription: cmd\n---\nReview.\n');
    await put('repo/skills/review/SKILL.md', skillMd('review'));
    await put('repo/commands/lint.md', '---\ndescription: cmd\n---\nLint.\n');
    await put('repo/extra/lint/SKILL.md', skillMd('lint'));
    const r = await run();
    expect(kindNames(r)).toEqual([
      'plugin:p plugins/p',
      'skill:lint extra/lint',
      'skill:review skills/review',
    ]);
    expect(r.warnings.sort()).toEqual([
      'command commands/lint.md dropped: skill "lint" at extra/lint has the same name',
      'command plugins/p/commands/review.md dropped: skill "review" at skills/review has the same name',
    ]);
  });

  it('resolves a server script in an unindexed directory (dist/) and lists it in the closure', async () => {
    await put('repo/.claude-plugin/plugin.json', { name: 'srv' });
    await put('repo/.mcp.json', {
      mcpServers: {
        srv: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.js'], cwd: './bin' },
      },
    });
    await put('repo/dist/server.js', 'console.log(1)\n');
    await put('repo/bin/run.sh', 'echo\n');
    const r = await run();
    const srv = r.entities.find((e) => e.kind === 'mcp');
    expect(srv?.def).toMatchObject({
      references: [
        {
          raw: '${CLAUDE_PLUGIN_ROOT}/dist/server.js',
          form: 'plugin-root',
          site: 'args',
          rel: 'dist/server.js',
        },
        { raw: './bin', form: 'relative', site: 'cwd', rel: 'bin' },
      ],
      closure: { paths: ['bin', 'dist/server.js'] },
    });
    expect(srv).not.toHaveProperty('issues');
  });

  it('falls back to the other rules when apm.yml has no primitives', async () => {
    await put('repo/apm.yml', 'name: empty-pkg\nversion: 1.0.0\n');
    await put('repo/.apm/README.md', '# nothing here\n');
    await put('repo/skills/a/SKILL.md', skillMd('a'));
    const r = await run();
    expect(r.detected).toBe('convention');
    expect(r.entities.map((e) => `${e.kind}:${e.name}`)).toEqual(['skill:a']);
    expect(r.warnings).toEqual([
      'apm.yml: APM package has no primitives under .apm/; scanning the repository instead',
    ]);
  });

  it('keeps one hooks dialect per plugin and warns about the other', async () => {
    await put('repo/.claude-plugin/plugin.json', {
      name: 'mixed',
      hooks: './hooks/hooks-cursor.json',
    });
    await put('repo/hooks/hooks-cursor.json', {
      version: 1,
      hooks: { stop: [{ command: 'echo cursor' }] },
    });
    await put('repo/hooks/hooks.json', {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo claude' }] }] },
    });
    const r = await run();
    const hook = r.entities.find((e) => e.kind === 'hook');
    expect(hook).toMatchObject({
      name: 'mixed',
      path: 'hooks/hooks-cursor.json',
      def: { hooks: { dialect: 'cursor' } },
    });
    expect(r.warnings).toEqual([
      'plugin mixed: hooks in hooks/hooks.json use the claude dialect (primary cursor); ignored',
    ]);
  });

  // Wall-clock time is measured by `npm run bench` (scripts/bench-scan.mjs), not asserted here.
  it('scans a cursor/plugins-sized repository (~4k files)', async () => {
    await writeSyntheticOrigin(join(tmp, 'repo'), 100);
    const r = await run();
    const count = (k: string) => r.entities.filter((e) => e.kind === k).length;
    expect({
      plugins: count('plugin'),
      skills: count('skill'),
      agents: count('agent'),
      mcp: count('mcp'),
      rules: count('instruction'),
    }).toEqual({
      plugins: 100,
      skills: 500,
      agents: 300,
      mcp: 100,
      rules: 100,
    });
  });
});
