/**
 * Gemini CLI and OpenCode specifics (research R7): agent dialects, tool names, instruction
 * mechanisms (GEMINI.md block, opencode.json list), hook events, MCP reference syntaxes and the
 * GEMINI_CLI_HOME / XDG_CONFIG_HOME / OPENCODE_DISABLE_EXTERNAL_SKILLS environment. The golden
 * renders and round trips cover both targets in golden.test.ts.
 */
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentDefinition,
  HookSet,
  McpServerConfig,
  SourceReference,
} from '../../src/core/types.js';
import { parseFrontmatter } from '../../src/lib/frontmatter.js';
import { renderAgent } from '../../src/targets/convert-agent.js';
import { convertHooks } from '../../src/targets/convert-hooks.js';
import { renderInstruction } from '../../src/targets/convert-instruction.js';
import { createTarget } from '../../src/targets/index.js';
import { OAUTH_NOTE, renderMcp } from '../../src/targets/mcp-config.js';
import { relocateCommand } from '../../src/targets/relocate.js';
import {
  copilotTool,
  geminiTool,
  hookMatcher,
  opencodePermission,
} from '../../src/targets/tool-names.js';
import {
  CLAUDE_HOOKS,
  cleanupTmp,
  exists,
  FMT_HOOKS,
  fakeEnv,
  install,
  makeSource,
  mkEntity,
  read,
  readJson,
  tmpDir,
  write,
} from './helpers.js';

vi.mock('../../src/lib/fs.js', async (orig) => (await import('./fakes.js')).withFs(await orig()));
vi.mock('../../src/domain/scope-paths.js', async (orig) =>
  (await import('./fakes.js')).withScopePaths(await orig()),
);
vi.mock('../../src/domain/lock.js', async (orig) =>
  (await import('./fakes.js')).withLock(await orig()),
);
vi.mock('../../src/domain/merged-record.js', async (orig) =>
  (await import('./fakes.js')).withMergedRecord(await orig()),
);
vi.mock('../../src/domain/ignore.js', async (orig) =>
  (await import('./fakes.js')).withIgnore(await orig()),
);
vi.mock('../../src/core/hash.js', async (orig) =>
  (await import('./fakes.js')).withHash(await orig()),
);

const geminiMatcher = (m: string): string => hookMatcher(m, 'claude', 'gemini');

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

  it('hook matchers into Claude names and between dialects (R8 M8)', () => {
    expect(hookMatcher('run_shell_command|replace', 'gemini', 'claude')).toBe('Bash|Edit');
    expect(hookMatcher('mcp_github_.*', 'gemini', 'claude')).toBe('mcp__github__.*');
    expect(hookMatcher('Shell', 'cursor', 'claude')).toBe('Bash');
    expect(hookMatcher('Write', 'cursor', 'claude')).toBe('Write|Edit|MultiEdit|NotebookEdit');
    expect(hookMatcher('Write.*', 'cursor', 'claude')).toBe(
      '(?:Write|Edit|MultiEdit|NotebookEdit).*',
    );
    expect(hookMatcher('MCP:search', 'cursor', 'claude')).toBe('mcp__.*__search');
    expect(hookMatcher('view|powershell', 'copilot', 'claude')).toBe('Read|Bash');
    expect(hookMatcher('Edit|MultiEdit|Write', 'claude', 'cursor')).toBe('Write');
    expect(hookMatcher('mcp__gh__.*', 'claude', 'cursor')).toBe('MCP:.*');
    expect(hookMatcher('Bash|Read', 'claude', 'copilot')).toBe('bash|view');
    expect(hookMatcher('write_file', 'gemini', 'cursor')).toBe('Write');
    expect(hookMatcher('constructor|toString', 'gemini', 'claude')).toBe('constructor|toString');
    expect(hookMatcher('*', 'cursor', 'gemini')).toBe('*');
  });

  it('copilot agent tools: aliases, MCP server/tool, native names (R8 M9)', () => {
    const table: Record<string, string | undefined> = {
      Bash: 'execute',
      'Bash(git:*)': 'execute',
      Read: 'read',
      Write: 'edit',
      MultiEdit: 'edit',
      Glob: 'search',
      Task: 'agent',
      WebFetch: 'web',
      TodoWrite: 'todo',
      mcp__docs__search: 'docs/search',
      mcp__docs: 'docs/*',
      'github/*': 'github/*',
      read: 'read',
      Skill: undefined,
      constructor: undefined,
    };
    for (const [claude, copilot] of Object.entries(table))
      expect(copilotTool(claude)).toBe(copilot);
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

describe('renderInstruction', () => {
  const INSTR = {
    name: 'ts',
    globs: ['src/**/*.ts'],
    alwaysApply: false,
    activation: 'paths' as const,
    body: 'Strict.\n',
  };

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
  const relocate = (refs: SourceReference[], scope: 'project' | 'global') => (command: string) =>
    relocateCommand(command, refs, 'gemini', {
      assetsRoot: `${scope === 'project' ? '.palm' : '<palm>'}/assets/acme__kit/fmt`,
      scope,
      env: { HOME: '/home/u' },
    });

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
    const set = { ...FMT_HOOKS, raw };
    const r = convertHooks(set, 'gemini', relocate(FMT_HOOKS.references, 'project'));
    const dir = '.palm/assets/acme__kit/fmt/plugins/fmt';
    expect(r.hooks).toEqual({
      hooks: {
        AfterTool: [
          {
            matcher: 'replace|write_file',
            hooks: [
              {
                type: 'command',
                command: `CLAUDE_PLUGIN_ROOT="$GEMINI_PROJECT_DIR"/${dir} "$GEMINI_PROJECT_DIR/${dir}/hooks/format.sh"`,
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

  it('global: a "$HOME"-relative asset dir; Gemini-dialect sources stay verbatim (native events too)', () => {
    const g = convertHooks(FMT_HOOKS, 'gemini', relocate(FMT_HOOKS.references, 'global'));
    expect(JSON.stringify(g.hooks)).toContain(
      '$HOME/.palm/assets/acme__kit/fmt/plugins/fmt/hooks/format.sh',
    );
    const native = {
      hooks: {
        BeforeModel: [{ hooks: [{ type: 'command', command: 'm', timeout: 1500 }] }],
        AfterTool: [{ matcher: 'write_file', sequential: true, hooks: [{ command: 'w' }] }],
      },
    };
    const set: HookSet = { ...FMT_HOOKS, dialect: 'gemini', raw: native, references: [] };
    const r = convertHooks(set, 'gemini', relocate([], 'global'));
    expect(r.hooks).toEqual(native);
    expect(r.dropped).toEqual([]);
    // to Claude: canonical events, seconds and Claude tool names (R8 M8)
    const claude = convertHooks(set, 'claude', relocate([], 'global'));
    expect(claude.hooks).toEqual({
      hooks: {
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'w' }] }],
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
    {
      kind: 'instruction',
      instruction: { name, alwaysApply: true, activation: 'always', body: `Rule ${name}.\n` },
    },
    name,
  );

/** A render case for `entity` at a scope root (the source is irrelevant for instructions). */
function at(entity: ReturnType<typeof mkEntity>, scopeRoot: string, scope: 'project' | 'global') {
  return { entity, absPath: scopeRoot, sourceRoot: scopeRoot, scope, scopeRoot };
}

describe('instruction merge / unmerge', () => {
  it('gemini: one managed block per instruction in GEMINI.md; user text survives', async () => {
    const root = await tmpDir();
    const USER = '# Project context\n\nWe use pnpm.\n';
    await write(path.join(root, 'GEMINI.md'), USER);
    const t = createTarget('gemini', fakeEnv(root));
    const a = await install(t, at(INSTR('a'), root, 'project'));
    const b = await install(t, at(INSTR('b'), root, 'project'));
    expect(a.result.merged).toEqual([
      {
        file: 'GEMINI.md',
        at: 'block:instruction:a',
        id: 'palm:instruction:a:0',
        key: 'instruction:a',
      },
    ]);
    expect(await read(path.join(root, 'GEMINI.md'))).toBe(
      `${USER}\n<!-- palm:begin instruction:a -->\nRule a.\n<!-- palm:end instruction:a -->\n\n` +
        '<!-- palm:begin instruction:b -->\nRule b.\n<!-- palm:end instruction:b -->\n',
    );
    await t.undeploy(a.entry, 'project', root, false);
    expect(await read(path.join(root, 'GEMINI.md'))).not.toContain('instruction:a');
    await t.undeploy(b.entry, 'project', root, false);
    expect(await read(path.join(root, 'GEMINI.md'))).toBe(USER);
  });

  it('opencode: a file per instruction listed in opencode.json; user entries survive', async () => {
    const root = await tmpDir();
    const USER = { $schema: 'https://opencode.ai/config.json', instructions: ['docs/*.md'] };
    await write(path.join(root, 'opencode.json'), JSON.stringify(USER));
    const t = createTarget('opencode', fakeEnv(root));
    const a = await install(t, at(INSTR('a'), root, 'project'));
    const b = await install(t, at(INSTR('b'), root, 'project'));
    expect(a.result.files).toEqual(['.opencode/instructions/a.md']);
    expect(await read(path.join(root, '.opencode/instructions/a.md'))).toBe('Rule a.\n');
    expect(await readJson(path.join(root, 'opencode.json'))).toEqual({
      ...USER,
      instructions: ['docs/*.md', '.opencode/instructions/a.md', '.opencode/instructions/b.md'],
    });
    await t.undeploy(a.entry, 'project', root, false);
    expect(await readJson(path.join(root, 'opencode.json'))).toEqual({
      ...USER,
      instructions: ['docs/*.md', '.opencode/instructions/b.md'],
    });
    await t.undeploy(b.entry, 'project', root, false);
    expect(await readJson(path.join(root, 'opencode.json'))).toEqual(USER);
    expect(await exists(path.join(root, '.opencode/instructions'))).toBe(false);
    expect(await exists(path.join(root, '.opencode'))).toBe(true); // a stop dir
  });

  it('opencode global: the listed path is home-relative; the lock names tokens', async () => {
    const home = await tmpDir();
    const t = createTarget('opencode', fakeEnv(home));
    const r = await install(t, at(INSTR('a'), home, 'global'));
    expect(r.result.files).toEqual(['<opencode>/instructions/a.md']);
    expect(r.result.merged?.[0]?.file).toBe('<opencode>/opencode.json');
    expect(await readJson(path.join(home, '.config/opencode/opencode.json'))).toEqual({
      instructions: ['~/.config/opencode/instructions/a.md'],
    });
    await t.undeploy(r.entry, 'global', home, false);
    expect(await exists(path.join(home, '.config/opencode/opencode.json'))).toBe(false);
    expect(await exists(path.join(home, '.config/opencode/instructions/a.md'))).toBe(false);
  });
});

describe('environment (global scope)', () => {
  it('GEMINI_CLI_HOME: $GEMINI_CLI_HOME/.gemini for every kind, skills included', async () => {
    const src = await makeSource();
    const home = await tmpDir();
    const alt = path.join(home, 'alt');
    const t = createTarget('gemini', fakeEnv(home, { GEMINI_CLI_HOME: alt }));
    const inSource = (entity: ReturnType<typeof mkEntity>, absPath = src.root) => ({
      ...at(entity, home, 'global'),
      absPath,
      sourceRoot: src.root,
    });
    const skill = mkEntity({ kind: 'skill', skill: { name: 'demo', description: 'd' } });
    const s = await install(t, inSource(skill, src.skillDir));
    expect(s.result.files[0]).toBe('<gemini>/skills/demo/SKILL.md');
    expect(await exists(path.join(alt, '.gemini/skills/demo/SKILL.md'))).toBe(true);
    const agentDef = { name: 'demo', description: 'd', body: 'x' };
    const agent = await install(t, inSource(mkEntity({ kind: 'agent', agent: agentDef })));
    expect(agent.result.files).toEqual(['<gemini>/agents/demo.md']);
    const instr = await install(t, inSource(INSTR('a')));
    expect(instr.result.merged?.[0]?.file).toBe('<gemini>/GEMINI.md');
    const server = { name: 'x', transport: 'stdio' as const, command: 'x' };
    const mcp = mkEntity({ kind: 'mcp', mcp: server, references: [], closure: { paths: [] } }, 'x');
    const m = await install(t, inSource(mcp));
    expect(m.result.merged?.[0]).toMatchObject({
      file: '<gemini>/settings.json',
      at: '/mcpServers/x',
    });
    expect(await readJson(path.join(alt, '.gemini/settings.json'))).toEqual({
      mcpServers: { x: { command: 'x' } },
    });
    // undeploy follows the override, and keeps the harness dir
    await t.undeploy(s.entry, 'global', home, false);
    expect(await exists(path.join(alt, '.gemini/skills'))).toBe(false);
    expect(await exists(path.join(alt, '.gemini'))).toBe(true);
    // project scope ignores it: the shared .agents/skills
    const project = await tmpDir();
    const p = await install(t, {
      ...inSource(skill, src.skillDir),
      scope: 'project',
      scopeRoot: project,
    });
    expect(p.result.files[0]).toBe('.agents/skills/demo/SKILL.md');
  });

  it('XDG_CONFIG_HOME: $XDG_CONFIG_HOME/opencode; OPENCODE_DISABLE_EXTERNAL_SKILLS: own skills dir', async () => {
    const src = await makeSource();
    const home = await tmpDir();
    const xdg = path.join(home, 'xdg');
    const skill = mkEntity({ kind: 'skill', skill: { name: 'demo', description: 'd' } });
    const skillAt = (scope: 'global' | 'project', scopeRoot: string) => ({
      ...at(skill, scopeRoot, scope),
      absPath: src.skillDir,
      sourceRoot: src.root,
    });
    const env = fakeEnv(home, { XDG_CONFIG_HOME: xdg });
    const t = createTarget('opencode', env);
    const firstFile = async (
      target: ReturnType<typeof createTarget>,
      scope: 'global' | 'project',
      root: string,
    ) => (await install(target, skillAt(scope, root))).result.files[0];
    const agentDef = { name: 'demo', description: 'd', body: 'x' };
    const agent = await install(
      t,
      at(mkEntity({ kind: 'agent', agent: agentDef }), home, 'global'),
    );
    expect(agent.result.files).toEqual(['<opencode>/agents/demo.md']);
    expect(await exists(path.join(xdg, 'opencode/agents/demo.md'))).toBe(true);
    await install(t, at(INSTR('a'), home, 'global'));
    expect(await readJson(path.join(xdg, 'opencode/opencode.json'))).toEqual({
      instructions: ['~/xdg/opencode/instructions/a.md'],
    });
    // skills: shared unless OpenCode ignores external skill dirs
    expect(await firstFile(t, 'global', home)).toBe('<agents>/skills/demo/SKILL.md');
    const own = createTarget('opencode', { ...env, OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true' });
    expect(await firstFile(own, 'global', home)).toBe('<opencode>/skills/demo/SKILL.md');
    const project = await tmpDir();
    const flag = (v: string) =>
      createTarget('opencode', fakeEnv(project, { OPENCODE_DISABLE_EXTERNAL_SKILLS: v }));
    expect(await firstFile(flag('1'), 'project', project)).toBe('.opencode/skills/demo/SKILL.md');
    expect(await firstFile(flag('0'), 'project', project)).toBe('.agents/skills/demo/SKILL.md');
  });

  it('the shared .agents/skills is written once for gemini + opencode + codex', async () => {
    const src = await makeSource();
    const root = await tmpDir();
    const env = fakeEnv(root);
    const skill = mkEntity({ kind: 'skill', skill: { name: 'demo', description: 'd' } });
    const c = { ...at(skill, root, 'project'), absPath: src.skillDir, sourceRoot: src.root };
    const results = [];
    for (const id of ['gemini', 'opencode', 'codex'] as const)
      results.push(await install(createTarget(id, env), c));
    const [first, second, third] = results;
    expect(first?.result.adopted).toEqual([]);
    // the later targets find identical files and adopt them: one copy on disk
    expect(second?.result.files).toEqual(first?.result.files);
    expect(second?.result.adopted).toEqual(first?.result.files);
    expect(third?.rendered.hash).toBe(first?.rendered.hash);
    await createTarget('opencode', env).undeploy(first!.entry, 'project', root, false);
    expect(await exists(path.join(root, '.agents/skills/demo'))).toBe(false);
  });
});
