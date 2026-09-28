/**
 * Gemini CLI and OpenCode specifics (research R7): agent dialects, tool names, commands,
 * instruction mechanisms (GEMINI.md block, opencode.json list), hook events, MCP reference
 * syntaxes and the GEMINI_CLI_HOME / XDG_CONFIG_HOME / OPENCODE_DISABLE_EXTERNAL_SKILLS
 * environment. The deploy matrix and golden round trips cover both targets in deploy.test.ts
 * and golden.test.ts.
 */
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { fileTargetLabel } from '../../src/commands/describe.js';
import type { AgentDefinition, HookSet, McpServerConfig } from '../../src/core/types.js';
import { ScopePaths } from '../../src/domain/scope-paths.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { renderAgent } from '../../src/targets/convert-agent.js';
import { renderCommand } from '../../src/targets/convert-command.js';
import { convertHooks } from '../../src/targets/convert-hooks.js';
import { renderInstruction } from '../../src/targets/convert-instruction.js';
import { createTarget } from '../../src/targets/index.js';
import { OAUTH_NOTE, renderMcp } from '../../src/targets/mcp-config.js';
import { geminiMatcher, geminiTool, opencodePermission } from '../../src/targets/tool-names.js';
import {
  CLAUDE_HOOKS,
  cleanupTmp,
  exists,
  fakeEnv,
  makeOrigin,
  mkEntity,
  mkInput,
  mkLock,
  read,
  readJson,
  tmpDir,
  write,
} from './helpers.js';

afterEach(cleanupTmp);

const AGENT: AgentDefinition = {
  name: 'reviewer',
  displayName: 'Code Reviewer',
  description: 'Reviews code: use after edits',
  model: 'opus',
  tools: ['Read', 'Grep', 'Edit', 'MultiEdit', 'Bash(git:*)', 'Task', 'mcp__linear__search'],
  disallowedTools: ['Bash'],
  skills: ['tdd'],
  mcpServers: ['github'],
  color: 'blue',
  body: '\nYou review code.\n',
  extra: { permissionMode: 'plan', temperature: 0.2, max_turns: 5 },
};

/** Gemini's `localAgentSchema` keys (`.strict()`: any other key fails the file). */
const GEMINI_KEYS = [
  'kind',
  'name',
  'description',
  'display_name',
  'tools',
  'mcp_servers',
  'model',
  'temperature',
  'max_turns',
  'timeout_mins',
];
/** OpenCode agent keys; anything else would leak to the model provider as an option. */
const OPENCODE_KEYS = [
  'description',
  'mode',
  'model',
  'color',
  'permission',
  'temperature',
  'top_p',
  'steps',
  'variant',
  'hidden',
];

describe('tool names', () => {
  it('gemini: R7 mapping table, MCP tools, native names; no equivalent → undefined', () => {
    const table = {
      Read: 'read_file',
      Write: 'write_file',
      Edit: 'replace',
      MultiEdit: 'replace',
      Glob: 'glob',
      Grep: 'grep_search',
      LS: 'list_directory',
      Bash: 'run_shell_command',
      WebFetch: 'web_fetch',
      WebSearch: 'google_web_search',
      TodoWrite: 'write_todos',
      Skill: 'activate_skill',
      mcp__gh__search: 'mcp_gh_search',
      mcp__gh: 'mcp_gh_*',
      'mcp__gh__*': 'mcp_gh_*',
      'Bash(git:*)': 'run_shell_command',
      read_file: 'read_file',
      '*': '*',
    };
    for (const [claude, gemini] of Object.entries(table)) expect(geminiTool(claude)).toBe(gemini);
    expect(geminiTool('Task')).toBeUndefined();
    expect(geminiTool('NotebookEdit')).toBeUndefined();
  });

  it('gemini hook matchers: tool names inside a regex, merged alternatives', () => {
    expect(geminiMatcher('Edit|MultiEdit|Write')).toBe('replace|write_file');
    expect(geminiMatcher('Bash')).toBe('run_shell_command');
    expect(geminiMatcher('mcp__github__.*')).toBe('mcp_github_.*');
    expect(geminiMatcher('mcp__my_srv__tool|Read')).toBe('mcp_my_srv_tool|read_file');
    expect(geminiMatcher('startup|resume')).toBe('startup|resume');
    expect(geminiMatcher('Notebook.*')).toBe('Notebook.*');
  });

  it('opencode: permission keys, sanitized MCP names', () => {
    expect(opencodePermission('Write')).toBe('edit');
    expect(opencodePermission('LS')).toBe('list');
    expect(opencodePermission('Task')).toBe('task');
    expect(opencodePermission('mcp__my.srv__do it')).toBe('my_srv_do_it');
    expect(opencodePermission('mcp__gh')).toBe('gh_*');
    expect(opencodePermission('NotebookEdit')).toBeUndefined();
  });
});

describe('renderAgent: gemini', () => {
  it('writes only schema keys, Gemini tool names, and reports what it dropped', () => {
    const r = renderAgent(AGENT, 'gemini');
    expect(r.fileName).toBe('reviewer.md');
    expect(r.content).toBe(
      [
        '---',
        'name: reviewer',
        'description: "Reviews code: use after edits"',
        'kind: local',
        'display_name: Code Reviewer',
        'tools:',
        '  - read_file',
        '  - grep_search',
        '  - replace',
        '  - run_shell_command',
        '  - mcp_linear_search',
        '  - activate_skill',
        '  - mcp_github_*',
        'temperature: 0.2',
        'max_turns: 5',
        '---',
        '',
        'You review code.',
        '',
      ].join('\n'),
    );
    expect(r.dropped).toEqual([
      'model (opus)',
      'tools: Bash(git:*) restriction (all of run_shell_command)',
      'tools: Task (no Gemini CLI equivalent)',
      'disallowedTools',
      'skills',
      'color',
      'extra: permissionMode',
    ]);
    expect(r.notes).toEqual([]);
    const keys = Object.keys(parseFrontmatter(r.content).data);
    expect(keys.filter((k) => !GEMINI_KEYS.includes(k))).toEqual([]);
    expect(keys).not.toContain('mcpServers');
  });

  it('no tools: inherits every tool (no key); Gemini models kept; names slugged', () => {
    const r = renderAgent(
      {
        name: 'My.Agent',
        description: 'd',
        model: 'gemini-2.5-pro',
        mcpServers: ['gh'],
        body: 'x',
      },
      'gemini',
    );
    expect(parseFrontmatter(r.content).data).toEqual({
      name: 'my-agent',
      description: 'd',
      kind: 'local',
      model: 'gemini-2.5-pro',
    });
    expect(r.fileName).toBe('My.Agent.md');
    expect(r.notes).toEqual([
      'name "My.Agent" written as "my-agent" (Gemini agent names are [a-z0-9-_])',
    ]);
    for (const model of ['inherit', 'sonnet', 'claude-sonnet-4-5'])
      expect(renderAgent({ ...AGENT, model }, 'gemini').dropped).toContain(`model (${model})`);
  });
});

describe('renderAgent: opencode', () => {
  it('mode subagent, permission block from the tool lists, every other key stripped', () => {
    const r = renderAgent(AGENT, 'opencode');
    expect(r.fileName).toBe('reviewer.md');
    const fm = parseFrontmatter(r.content);
    expect(fm.data).toEqual({
      description: 'Reviews code: use after edits',
      mode: 'subagent',
      permission: {
        '*': 'deny',
        read: 'allow',
        grep: 'allow',
        edit: 'allow',
        bash: 'deny', // disallowedTools win over the Bash(git:*) allow
        task: 'allow',
        linear_search: 'allow',
        'github_*': 'allow',
        skill: { tdd: 'allow' },
      },
      temperature: 0.2,
    });
    expect(Object.keys(fm.data).filter((k) => !OPENCODE_KEYS.includes(k))).toEqual([]);
    expect(fm.body).toBe('You review code.\n');
    expect(r.dropped).toEqual([
      'model (opus)',
      'color (blue)',
      'tools: Bash(git:*) restriction (all of bash)',
      'skills',
      'extra: permissionMode',
      'extra: max_turns',
    ]);
  });

  it('keeps provider/model ids and hex or theme colors; no tools and no denials: no permission', () => {
    const base = { name: 'a', description: 'd', body: 'x' };
    const r = renderAgent(
      { ...base, model: 'anthropic/claude-sonnet-4-5', color: '#FF8800' },
      'opencode',
    );
    expect(parseFrontmatter(r.content).data).toEqual({
      description: 'd',
      mode: 'subagent',
      model: 'anthropic/claude-sonnet-4-5',
      color: '#FF8800',
    });
    expect(r.dropped).toEqual([]);
    const themed = renderAgent({ ...base, color: 'accent', model: 'claude-opus-4-1' }, 'opencode');
    expect(parseFrontmatter(themed.content).data.color).toBe('accent');
    expect(themed.dropped).toEqual(['model (claude-opus-4-1)']);
    const denied = renderAgent({ ...base, disallowedTools: ['Write', 'WebFetch'] }, 'opencode');
    expect(parseFrontmatter(denied.content).data.permission).toEqual({
      edit: 'deny',
      webfetch: 'deny',
    });
  });
});

describe('renderCommand', () => {
  const CMD = {
    name: 'fix',
    description: 'Fix "it"',
    argumentHint: '[file]',
    body: 'Fix $ARGUMENTS in @src/a.ts and @./notes.md.\n!`git status`\nMail a@b.com, ping @team.\n',
  };

  it('gemini: TOML description + prompt, Claude syntax converted', () => {
    const r = renderCommand(CMD, 'gemini');
    expect(r.fileName).toBe('fix.toml');
    expect(parseToml(r.content)).toEqual({
      description: 'Fix "it"',
      prompt:
        'Fix {{args}} in @{src/a.ts} and @{./notes.md}.\n!{git status}\nMail a@b.com, ping @team.\n',
    });
    expect(r.notes).toEqual([]);
    const positional = renderCommand({ name: 'p', body: 'Use $1 then $2\n' }, 'gemini');
    expect(parseToml(positional.content)).toEqual({ prompt: 'Use $1 then $2\n' });
    expect(positional.notes).toEqual([
      'positional arguments ($1, $2, …) have no Gemini CLI equivalent; {{args}} holds all of them',
    ]);
  });

  it('opencode: markdown with description only; placeholders unchanged', () => {
    const r = renderCommand(CMD, 'opencode');
    expect(r.fileName).toBe('fix.md');
    expect(r.content).toBe(`---\ndescription: Fix "it"\n---\n\n${CMD.body}`);
  });
});

describe('renderInstruction', () => {
  const INSTR = { name: 'ts', globs: ['src/**/*.ts'], alwaysApply: false, body: 'Strict.\n' };

  it('gemini: a managed block for GEMINI.md; opencode: a plain markdown file', () => {
    expect(renderInstruction(INSTR, 'gemini')).toEqual({
      managedBlock: 'Applies to: src/**/*.ts\n\nStrict.\n',
    });
    expect(renderInstruction(INSTR, 'opencode')).toEqual({
      fileName: 'ts.md',
      content: 'Applies to: src/**/*.ts\n\nStrict.\n',
    });
  });
});

describe('convertHooks: gemini', () => {
  const PROJECT = ScopePaths.at('project', '/proj', { HOME: '/home/u' });
  const GLOBAL = ScopePaths.at('global', '/home/u', {});
  const claudeSet: HookSet = { name: 'fmt', dialect: 'claude', raw: CLAUDE_HOOKS };

  it('renames events, maps matchers, converts timeouts to ms, roots commands at $GEMINI_PROJECT_DIR', () => {
    const raw = {
      hooks: {
        ...CLAUDE_HOOKS.hooks,
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'ask' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'done', timeout: 5 }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: 'pack' }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'x' }] }],
        PostToolUseFailure: [{ hooks: [{ type: 'command', command: 'x' }] }],
      },
    };
    const r = convertHooks({ ...claudeSet, raw }, 'gemini', PROJECT.hooksAssetDir('fmt'), PROJECT);
    const root = '$GEMINI_PROJECT_DIR/.palm/hooks/fmt';
    expect(r.hooks).toEqual({
      hooks: {
        AfterTool: [
          {
            matcher: 'replace|write_file',
            hooks: [
              {
                type: 'command',
                command: `CLAUDE_PLUGIN_ROOT="${root}" "${root}/hooks/format.sh"`,
                timeout: 30000,
              },
            ],
          },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        BeforeTool: [
          { matcher: 'run_shell_command', hooks: [{ type: 'command', command: 'guard' }] },
        ],
        BeforeAgent: [{ hooks: [{ type: 'command', command: 'ask' }] }],
        AfterAgent: [{ hooks: [{ type: 'command', command: 'done', timeout: 5000 }] }],
        PreCompress: [{ hooks: [{ type: 'command', command: 'pack' }] }],
      },
    });
    expect(r.dropped).toEqual([
      'SubagentStop: not supported by gemini',
      'PostToolUseFailure: not supported by gemini',
    ]);
  });

  it('global: the absolute asset dir; Gemini-dialect sources stay verbatim (native events too)', () => {
    const asset = GLOBAL.hooksAssetDir('fmt');
    const g = convertHooks(claudeSet, 'gemini', asset, GLOBAL);
    expect(JSON.stringify(g.hooks)).toContain(`${asset}/hooks/format.sh`);
    const native = {
      hooks: {
        BeforeModel: [{ hooks: [{ type: 'command', command: 'm', timeout: 1500 }] }],
        AfterTool: [{ matcher: 'write_file', sequential: true, hooks: [{ command: 'w' }] }],
      },
    };
    const r = convertHooks({ name: 'g', dialect: 'gemini', raw: native }, 'gemini', asset, GLOBAL);
    expect(r).toEqual({ hooks: native, dropped: [] });
    // to Claude: canonical events and seconds
    const claude = convertHooks(
      { name: 'g', dialect: 'gemini', raw: native },
      'claude',
      asset,
      GLOBAL,
    );
    expect(claude.hooks).toEqual({
      hooks: {
        PostToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'w' }] }],
      },
    });
    expect(claude.dropped).toEqual(['BeforeModel: no equivalent event']);
  });
});

describe('renderMcp: gemini and opencode', () => {
  const STDIO: McpServerConfig = {
    name: 'gh',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '${PKG:-@x/gh}'],
    env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', LOG: 'debug' },
    cwd: '/work',
    secrets: [{ name: 'GH_OPT', in: 'env', required: false }],
  };
  const HTTP: McpServerConfig = {
    name: 'docs',
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
  };

  it('env-ref: gemini ${VAR} (optional ${VAR:-}), opencode {env:VAR}', () => {
    const g = renderMcp(STDIO, 'gemini', 'env-ref');
    expect(g.entry).toEqual({
      command: 'npx',
      args: ['-y', '${PKG:-@x/gh}'],
      env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', LOG: 'debug', GH_OPT: '${GH_OPT:-}' },
      cwd: '/work',
    });
    expect(g.notes).toEqual([]);
    const o = renderMcp(STDIO, 'opencode', 'env-ref');
    expect(o.entry).toEqual({
      type: 'local',
      command: ['npx', '-y', '{env:PKG}'],
      cwd: '/work',
      environment: { GITHUB_TOKEN: '{env:GITHUB_TOKEN}', LOG: 'debug', GH_OPT: '{env:GH_OPT}' },
      enabled: true,
    });
    expect(o.notes).toEqual([
      'OpenCode has no default syntax: PKG is empty when unset (default "@x/gh" dropped)',
    ]);
    expect(o.envRefs).toEqual(['PKG', 'GITHUB_TOKEN', 'GH_OPT']);
  });

  it('literal: values substituted; an optional secret without a value is left out', () => {
    const values = { GITHUB_TOKEN: 'ghp_1', PKG: '@y/gh' };
    const g = renderMcp(STDIO, 'gemini', 'literal', { values });
    expect(g.entry).toMatchObject({
      args: ['-y', '@y/gh'],
      env: { GITHUB_TOKEN: 'ghp_1', LOG: 'debug' },
    });
    const o = renderMcp(STDIO, 'opencode', 'literal', { values });
    expect(o.entry).toMatchObject({
      command: ['npx', '-y', '@y/gh'],
      environment: { GITHUB_TOKEN: 'ghp_1', LOG: 'debug' },
    });
    expect(o.notes).toEqual(['optional GH_OPT not set; env GH_OPT left out']);
  });

  it('http/sse: gemini {url, type}, opencode remote with oauth off for header auth', () => {
    expect(renderMcp(HTTP, 'gemini', 'env-ref').entry).toEqual({
      url: 'https://example.com/mcp',
      type: 'http',
      headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
    });
    expect(renderMcp({ ...HTTP, transport: 'sse' }, 'gemini', 'env-ref').entry).toMatchObject({
      type: 'sse',
    });
    expect(renderMcp(HTTP, 'opencode', 'env-ref').entry).toEqual({
      type: 'remote',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer {env:DOCS_TOKEN}' },
      oauth: false,
      enabled: true,
    });
    const open = renderMcp(
      { ...HTTP, transport: 'sse', headers: undefined },
      'opencode',
      'env-ref',
    );
    expect(open.entry).toEqual({ type: 'remote', url: 'https://example.com/mcp', enabled: true });
    expect(open.notes).toEqual([OAUTH_NOTE]);
    expect(renderMcp({ ...HTTP, cwd: '/w' }, 'gemini', 'env-ref').notes).toContain(
      'cwd (/w) is not supported in gemini MCP config; dropped',
    );
  });
});

const INSTR = (name: string) =>
  mkEntity(
    { kind: 'instruction', instruction: { name, alwaysApply: true, body: `Rule ${name}.\n` } },
    name,
  );

describe('instruction merge / unmerge', () => {
  it('gemini: one managed block per instruction in GEMINI.md; user text survives', async () => {
    const root = await tmpDir();
    const USER = '# Project context\n\nWe use pnpm.\n';
    await write(path.join(root, 'GEMINI.md'), USER);
    const t = createTarget('gemini', fakeEnv(root));
    const a = await t.deploy(mkInput({ entity: INSTR('a'), scopeRoot: root }));
    const b = await t.deploy(mkInput({ entity: INSTR('b'), scopeRoot: root }));
    expect(a.merged).toEqual([
      { file: 'GEMINI.md', pointer: 'block:instruction:a', value: 'Rule a.\n' },
    ]);
    expect(await read(path.join(root, 'GEMINI.md'))).toBe(
      `${USER}\n<!-- palm:begin instruction:a -->\nRule a.\n<!-- palm:end instruction:a -->\n\n` +
        '<!-- palm:begin instruction:b -->\nRule b.\n<!-- palm:end instruction:b -->\n',
    );
    await t.undeploy(mkLock(INSTR('a'), ['gemini'], a.files, a.merged), 'project', root, false);
    expect(await read(path.join(root, 'GEMINI.md'))).not.toContain('instruction:a');
    await t.undeploy(mkLock(INSTR('b'), ['gemini'], b.files, b.merged), 'project', root, false);
    expect(await read(path.join(root, 'GEMINI.md'))).toBe(USER);
  });

  it('opencode: a file per instruction listed in opencode.json; user entries survive', async () => {
    const root = await tmpDir();
    const USER = { $schema: 'https://opencode.ai/config.json', instructions: ['docs/*.md'] };
    await write(path.join(root, 'opencode.json'), JSON.stringify(USER));
    const t = createTarget('opencode', fakeEnv(root));
    const a = await t.deploy(mkInput({ entity: INSTR('a'), scopeRoot: root }));
    const b = await t.deploy(mkInput({ entity: INSTR('b'), scopeRoot: root }));
    expect(a.files).toEqual(['.opencode/instructions/a.md']);
    expect(await read(path.join(root, '.opencode/instructions/a.md'))).toBe('Rule a.\n');
    expect(await readJson(path.join(root, 'opencode.json'))).toEqual({
      ...USER,
      instructions: ['docs/*.md', '.opencode/instructions/a.md', '.opencode/instructions/b.md'],
    });
    await t.undeploy(mkLock(INSTR('a'), ['opencode'], a.files, a.merged), 'project', root, false);
    expect(await readJson(path.join(root, 'opencode.json'))).toEqual({
      ...USER,
      instructions: ['docs/*.md', '.opencode/instructions/b.md'],
    });
    await t.undeploy(mkLock(INSTR('b'), ['opencode'], b.files, b.merged), 'project', root, false);
    expect(await readJson(path.join(root, 'opencode.json'))).toEqual(USER);
    expect(await exists(path.join(root, '.opencode/instructions'))).toBe(false);
    expect(await exists(path.join(root, '.opencode'))).toBe(true); // a stop dir
  });

  it('opencode global: the listed path is absolute', async () => {
    const home = await tmpDir();
    const t = createTarget('opencode', fakeEnv(home));
    const r = await t.deploy(mkInput({ entity: INSTR('a'), scope: 'global', scopeRoot: home }));
    const file = path.join(home, '.config/opencode/instructions/a.md');
    expect(await readJson(path.join(home, '.config/opencode/opencode.json'))).toEqual({
      instructions: [file],
    });
    await t.undeploy(mkLock(INSTR('a'), ['opencode'], r.files, r.merged), 'global', home, false);
    expect(await exists(path.join(home, '.config/opencode/opencode.json'))).toBe(false);
    expect(await exists(file)).toBe(false);
  });
});

describe('environment (global scope)', () => {
  it('GEMINI_CLI_HOME: $GEMINI_CLI_HOME/.gemini for every kind, skills included', async () => {
    const origin = await makeOrigin();
    const home = await tmpDir();
    const alt = path.join(home, 'alt');
    const env = fakeEnv(home, { GEMINI_CLI_HOME: alt });
    const t = createTarget('gemini', env);
    const deploy = (entity: ReturnType<typeof mkEntity>, absPath = origin.root) =>
      t.deploy(
        mkInput({ entity, absPath, originRoot: origin.root, scope: 'global', scopeRoot: home }),
      );
    const skill = mkEntity({ kind: 'skill', skill: { name: 'demo', description: 'd' } });
    const s = await deploy(skill, origin.skillDir);
    expect(s.files[0]).toBe(path.join(alt, '.gemini/skills/demo/SKILL.md'));
    const agent = await deploy(
      mkEntity({ kind: 'agent', agent: { name: 'demo', description: 'd', body: 'x' } }),
    );
    expect(agent.files).toEqual([path.join(alt, '.gemini/agents/demo.md')]);
    const instr = await deploy(INSTR('a'));
    expect(instr.merged![0]!.file).toBe(path.join(alt, '.gemini/GEMINI.md'));
    const mcp = mkEntity(
      { kind: 'mcp', mcp: { name: 'x', transport: 'stdio', command: 'x' } },
      'x',
    );
    const m = await deploy(mcp);
    expect(m.merged![0]).toMatchObject({
      file: path.join(alt, '.gemini/settings.json'),
      pointer: '/mcpServers/x',
    });
    // the override is a scope boundary (uninstall may delete there) and undeploy follows it
    expect(ScopePaths.at('global', home, env).contains(s.files[0]!)).toBe(true);
    await t.undeploy(mkLock(skill, ['gemini'], s.files), 'global', home, false);
    expect(await exists(path.join(alt, '.gemini/skills'))).toBe(false);
    expect(await exists(path.join(alt, '.gemini'))).toBe(true);
    // project scope ignores it: the shared .agents/skills
    const project = await tmpDir();
    const p = await t.deploy(
      mkInput({
        entity: skill,
        absPath: origin.skillDir,
        originRoot: origin.root,
        scopeRoot: project,
      }),
    );
    expect(p.files[0]).toBe('.agents/skills/demo/SKILL.md');
  });

  it('XDG_CONFIG_HOME: $XDG_CONFIG_HOME/opencode; OPENCODE_DISABLE_EXTERNAL_SKILLS: own skills dir', async () => {
    const origin = await makeOrigin();
    const home = await tmpDir();
    const xdg = path.join(home, 'xdg');
    const skill = mkEntity({ kind: 'skill', skill: { name: 'demo', description: 'd' } });
    const input = (scope: 'global' | 'project', scopeRoot: string) =>
      mkInput({
        entity: skill,
        absPath: origin.skillDir,
        originRoot: origin.root,
        scope,
        scopeRoot,
      });
    const env = fakeEnv(home, { XDG_CONFIG_HOME: xdg });
    const t = createTarget('opencode', env);
    const agent = await t.deploy(
      mkInput({
        entity: mkEntity({ kind: 'agent', agent: { name: 'demo', description: 'd', body: 'x' } }),
        scope: 'global',
        scopeRoot: home,
      }),
    );
    expect(agent.files).toEqual([path.join(xdg, 'opencode/agents/demo.md')]);
    const instr = await t.deploy(mkInput({ entity: INSTR('a'), scope: 'global', scopeRoot: home }));
    expect(await readJson(path.join(xdg, 'opencode/opencode.json'))).toEqual({
      instructions: [path.join(xdg, 'opencode/instructions/a.md')],
    });
    expect(instr.merged![0]!.file).toBe(path.join(xdg, 'opencode/opencode.json'));
    expect(ScopePaths.at('global', home, env).contains(agent.files[0]!)).toBe(true);
    // skills: shared unless OpenCode ignores external skill dirs
    expect((await t.deploy(input('global', home))).files[0]).toBe(
      path.join(home, '.agents/skills/demo/SKILL.md'),
    );
    const own = createTarget('opencode', { ...env, OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true' });
    expect((await own.deploy(input('global', home))).files[0]).toBe(
      path.join(xdg, 'opencode/skills/demo/SKILL.md'),
    );
    const project = await tmpDir();
    const ownProject = createTarget(
      'opencode',
      fakeEnv(project, { OPENCODE_DISABLE_EXTERNAL_SKILLS: '1' }),
    );
    expect((await ownProject.deploy(input('project', project))).files[0]).toBe(
      '.opencode/skills/demo/SKILL.md',
    );
    const off = createTarget(
      'opencode',
      fakeEnv(project, { OPENCODE_DISABLE_EXTERNAL_SKILLS: '0' }),
    );
    expect((await off.deploy(input('project', project))).files[0]).toBe(
      '.agents/skills/demo/SKILL.md',
    );
  });

  it('the shared .agents/skills is written once for gemini + opencode + codex', async () => {
    const origin = await makeOrigin();
    const root = await tmpDir();
    const env = fakeEnv(root);
    const skill = mkEntity({ kind: 'skill', skill: { name: 'demo', description: 'd' } });
    const input = mkInput({
      entity: skill,
      absPath: origin.skillDir,
      originRoot: origin.root,
      scopeRoot: root,
    });
    const results = [];
    for (const id of ['gemini', 'opencode', 'codex'] as const)
      results.push(await createTarget(id, env).deploy(input));
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    await createTarget('opencode', env).undeploy(
      mkLock(skill, ['gemini', 'opencode', 'codex'], results[0]!.files),
      'project',
      root,
      false,
    );
    expect(await exists(path.join(root, '.agents/skills/demo'))).toBe(false);
  });
});

describe('describe: installed files attributed to the harness', () => {
  it('gemini and opencode paths', () => {
    expect(fileTargetLabel('.gemini/agents/x.md')).toBe('gemini');
    expect(fileTargetLabel('GEMINI.md')).toBe('gemini');
    expect(fileTargetLabel('/home/u/alt/.gemini/settings.json')).toBe('gemini');
    expect(fileTargetLabel('.opencode/commands/x.md')).toBe('opencode');
    expect(fileTargetLabel('opencode.json')).toBe('opencode');
    expect(fileTargetLabel('/home/u/.config/opencode/agents/x.md')).toBe('opencode');
  });
});
