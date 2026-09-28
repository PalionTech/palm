import { describe, expect, it } from 'vitest';
import { isPalmError } from '../../src/core/errors.js';
import { parseAgentFile } from '../../src/index/agents.js';
import { parseCommandFile } from '../../src/index/commands.js';
import { detectHookDialect, mergeHooksRaw, parseHooksJson } from '../../src/index/hooks.js';
import { parseInstructionFile } from '../../src/index/instructions.js';
import { parseMcpJson } from '../../src/index/mcp.js';
import { parseSkillMd } from '../../src/index/skills.js';

describe('parseSkillMd', () => {
  it('maps spec fields and passes non-spec keys through', () => {
    const def = parseSkillMd(
      'last30days',
      [
        '---',
        'name: last30days',
        'description: Research the last 30 days.',
        'license: MIT',
        'compatibility: Requires network access',
        'version: 2.1.0',
        'argument-hint: "[topic]"',
        'allowed-tools: Bash, Read, WebSearch',
        'user-invocable: true',
        'metadata:',
        '  author: mvanhorn',
        '  openclaw:',
        '    emoji: x',
        '---',
        '',
        '# Body',
      ].join('\n'),
    );
    expect(def).toEqual({
      name: 'last30days',
      description: 'Research the last 30 days.',
      version: '2.1.0',
      license: 'MIT',
      compatibility: 'Requires network access',
      metadata: { author: 'mvanhorn', openclaw: '{"emoji":"x"}' },
      allowedTools: ['Bash', 'Read', 'WebSearch'],
      extra: { 'argument-hint': '[topic]', 'user-invocable': true },
    });
  });

  it('splits space-separated allowed-tools (spec form) without breaking parenthesised patterns', () => {
    const def = parseSkillMd(
      'x',
      '---\nname: x\ndescription: d\nallowed-tools: Read Bash(git log:*) Grep\n---\n',
    );
    expect(def.allowedTools).toEqual(['Read', 'Bash(git log:*)', 'Grep']);
  });

  it('prefers metadata.version over version', () => {
    const def = parseSkillMd(
      'x',
      '---\nname: x\ndescription: d\nversion: 1.0.0\nmetadata:\n  version: "2.0.0"\n---\n',
    );
    expect(def.version).toBe('2.0.0');
  });

  it('keeps a valid frontmatter name that differs from the directory and records dirName', () => {
    const def = parseSkillMd(
      'react-best-practices',
      '---\nname: vercel-react-best-practices\ndescription: d\n---\n',
    );
    expect(def.name).toBe('vercel-react-best-practices');
    expect(def.dirName).toBe('react-best-practices');
  });

  it('slugifies the directory name when the frontmatter name is not a slug', () => {
    const def = parseSkillMd('poteto-mode', '---\nname: Poteto Mode\ndescription: d\n---\n');
    expect(def.name).toBe('poteto-mode');
    expect(def.dirName).toBeUndefined();
  });

  it('falls back to the directory name and tolerates a missing description', () => {
    const def = parseSkillMd('My Skill', '---\nlicense: MIT\n---\n');
    expect(def.name).toBe('my-skill');
    expect(def.description).toBe('');
    expect(def.dirName).toBe('My Skill');
  });

  it('throws E_PARSE without frontmatter', () => {
    try {
      parseSkillMd('x', '# no frontmatter');
      expect.unreachable();
    } catch (e) {
      expect(isPalmError(e) && e.code).toBe('E_PARSE');
    }
  });
});

describe('parseAgentFile', () => {
  it('parses Claude agents (comma tool list, skills, mcpServers, body)', () => {
    const def = parseAgentFile(
      '/o/plugins/p/agents/verifier.md',
      '---\nname: verifier\ndescription: Verifies SDK apps\nmodel: sonnet\ntools: Read, Grep, Bash(npm test:*)\ndisallowedTools: Write\nskills: [tdd, review]\nmcpServers:\n  - context7\n  - inline: { command: npx }\ncolor: green\nmaxTurns: 20\n---\n\nYou verify.\n',
    );
    expect(def).toEqual({
      name: 'verifier',
      description: 'Verifies SDK apps',
      model: 'sonnet',
      tools: ['Read', 'Grep', 'Bash(npm test:*)'],
      disallowedTools: ['Write'],
      skills: ['tdd', 'review'],
      mcpServers: ['context7'],
      color: 'green',
      body: 'You verify.\n',
      extra: { maxTurns: 20, mcpServers: ['context7', { inline: { command: 'npx' } }] },
      sourceFormat: 'claude-md',
    });
  });

  it('keeps a valid declared name for Claude agents (namespaced names)', () => {
    const def = parseAgentFile(
      '/o/agents/debugger.md',
      '---\nname: debugging-toolkit-debugger\ndescription: d\n---\nx',
    );
    expect(def.name).toBe('debugging-toolkit-debugger');
    expect(def.displayName).toBeUndefined();
  });

  it('uses the slugified file stem and a displayName for display-string names', () => {
    const def = parseAgentFile(
      '/o/agents/comment-sicko.md',
      '---\nname: Comment Sicko\ndescription: Hates comments.\nreadonly: true\n---\n# Comment Sicko\n',
    );
    expect(def.name).toBe('comment-sicko');
    expect(def.displayName).toBe('Comment Sicko');
    expect(def.sourceFormat).toBe('cursor-md');
  });

  it('parses Copilot .agent.md: stem is the identity, mcp-servers pass through', () => {
    const def = parseAgentFile(
      '/o/agents/CSharpExpert.agent.md',
      "---\nname: \"C# Expert\"\ndescription: .NET help\ntools: ['codebase', 'search']\ntarget: vscode\nmcp-servers:\n  nuget:\n    command: dnx\n---\n\nYou are an expert.\n",
    );
    expect(def.name).toBe('c-sharp-expert');
    expect(def.displayName).toBe('C# Expert');
    expect(def.tools).toEqual(['codebase', 'search']);
    expect(def.sourceFormat).toBe('copilot-agent-md');
    expect(def.extra).toEqual({ target: 'vscode', 'mcp-servers': { nuget: { command: 'dnx' } } });
  });

  it('treats a valid declared name on .agent.md as a display label', () => {
    const def = parseAgentFile(
      '/o/agents/arm-migration.agent.md',
      '---\nname: arm-migration-agent\ndescription: d\n---\nx',
    );
    expect(def.name).toBe('arm-migration');
    expect(def.displayName).toBe('arm-migration-agent');
  });

  it('detects APM agents from their location', () => {
    expect(
      parseAgentFile('/pkg/.apm/agents/reviewer.agent.md', '---\ndescription: d\n---\nx')
        .sourceFormat,
    ).toBe('apm-agent-md');
  });

  it('parses Codex TOML agents', () => {
    const def = parseAgentFile(
      '/o/agents/reviewer.toml',
      'name = "reviewer"\ndescription = "Reviews"\nmodel = "gpt-5.4"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nReview like an owner.\n"""\n\n[mcp_servers.docs]\nurl = "https://example.com/mcp"\n',
    );
    expect(def).toEqual({
      name: 'reviewer',
      description: 'Reviews',
      model: 'gpt-5.4',
      mcpServers: ['docs'],
      body: 'Review like an owner.\n',
      extra: {
        sandbox_mode: 'read-only',
        mcp_servers: { docs: { url: 'https://example.com/mcp' } },
      },
      sourceFormat: 'codex-toml',
    });
  });

  it('throws E_PARSE on invalid TOML', () => {
    expect(() => parseAgentFile('/o/agents/bad.toml', 'name = ')).toThrowError(/invalid TOML/);
  });
});

describe('parseInstructionFile', () => {
  it.each([
    [
      '/r/rules/a.mdc',
      '---\ndescription: A\nglobs: "**/*.ts, **/*.tsx"\n---\nBody',
      {
        name: 'a',
        description: 'A',
        globs: ['**/*.ts', '**/*.tsx'],
        alwaysApply: false,
        body: 'Body',
        sourceFormat: 'mdc',
      },
    ],
    [
      '/r/rules/b.mdc',
      '---\nglobs: ["src/**"]\nalwaysApply: "true"\n---\nBody',
      { name: 'b', globs: ['src/**'], alwaysApply: true, body: 'Body', sourceFormat: 'mdc' },
    ],
    [
      '/r/rules/c.mdc',
      '---\ndescription: Agent decides\n---\nBody',
      {
        name: 'c',
        description: 'Agent decides',
        alwaysApply: false,
        body: 'Body',
        sourceFormat: 'mdc',
      },
    ],
    [
      '/r/instructions/a11y.instructions.md',
      "---\napplyTo: '**'\ndescription: A11y\n---\nBody",
      {
        name: 'a11y',
        description: 'A11y',
        alwaysApply: true,
        body: 'Body',
        sourceFormat: 'instructions-md',
      },
    ],
    [
      '/r/instructions/py.instructions.md',
      "---\napplyTo: '**/*.py, **/*.pyi'\n---\nBody",
      {
        name: 'py',
        globs: ['**/*.py', '**/*.pyi'],
        alwaysApply: false,
        body: 'Body',
        sourceFormat: 'instructions-md',
      },
    ],
    [
      '/r/rules/api.md',
      '---\npaths:\n  - "src/api/**/*.ts"\n---\nBody',
      {
        name: 'api',
        globs: ['src/api/**/*.ts'],
        alwaysApply: false,
        body: 'Body',
        sourceFormat: 'md',
      },
    ],
    [
      '/r/instructions/Style Guide.md',
      '# Style\n',
      { name: 'style-guide', alwaysApply: true, body: '# Style\n', sourceFormat: 'md' },
    ],
    [
      '/r/AGENTS.md',
      '# Agents\n',
      { name: 'agents', alwaysApply: true, body: '# Agents\n', sourceFormat: 'agents-md' },
    ],
  ])('%s', (path, text, expected) => {
    expect(parseInstructionFile(path, text)).toEqual(expected);
  });
});

describe('parseCommandFile', () => {
  it('restores bracketed argument hints that YAML parsed as a list', () => {
    expect(
      parseCommandFile(
        '/r/commands/new-sdk-app.md',
        '---\ndescription: Create an app\nargument-hint: [project-name]\n---\n\nDo it.\n',
      ),
    ).toEqual({
      name: 'new-sdk-app',
      description: 'Create an app',
      argumentHint: '[project-name]',
      body: 'Do it.\n',
      sourceFormat: 'claude-md',
    });
  });

  it('parses Copilot prompt files', () => {
    expect(
      parseCommandFile(
        '/r/prompts/explain.prompt.md',
        '---\ndescription: Explain\nmode: agent\n---\nExplain.',
      ),
    ).toEqual({
      name: 'explain',
      description: 'Explain',
      body: 'Explain.',
      sourceFormat: 'prompt-md',
    });
  });

  it('parses Gemini TOML commands', () => {
    expect(
      parseCommandFile(
        '/r/commands/caveman.toml',
        'description = "Switch"\nprompt = "Switch to {{args}}."\n',
      ),
    ).toEqual({
      name: 'caveman',
      description: 'Switch',
      body: 'Switch to {{args}}.',
      sourceFormat: 'gemini-toml',
    });
  });

  it('recognises OpenCode commands', () => {
    expect(
      parseCommandFile('/r/commands/t.md', '---\ndescription: Test\nagent: build\n---\nRun tests.')
        .sourceFormat,
    ).toBe('opencode-md');
  });
});

describe('hooks', () => {
  const claude = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x', timeout: 5 }] }],
    },
  };
  const cursor = { version: 1, hooks: { afterFileEdit: [{ command: 'bash x.sh' }] } };
  const copilot = {
    version: 1,
    hooks: { sessionEnd: [{ type: 'command', bash: 'x.sh', timeoutSec: 60 }] },
  };
  const gemini = {
    hooks: { BeforeTool: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'x' }] }] },
  };

  it.each([
    ['claude', claude],
    ['cursor', cursor],
    ['copilot', copilot],
    ['gemini', gemini],
    ['unknown', { hooks: {} }],
    ['unknown', { something: 'else' }],
    ['unknown', 42],
  ])('detects %s', (dialect, json) => {
    expect(detectHookDialect(json)).toBe(dialect);
  });

  it('wraps inline manifest hooks and records the plugin root', () => {
    const inline = { SessionStart: [{ hooks: [{ type: 'command', command: 'node x.js' }] }] };
    expect(parseHooksJson('caveman', inline, '.')).toEqual({
      name: 'caveman',
      dialect: 'claude',
      raw: { hooks: inline },
      pluginRootRel: '.',
    });
  });

  it('merges event arrays', () => {
    const extra = {
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [] }], Stop: [{ hooks: [] }] },
    };
    expect(mergeHooksRaw(claude, extra)).toEqual({
      hooks: {
        PreToolUse: [...claude.hooks.PreToolUse, { matcher: 'Edit', hooks: [] }],
        Stop: [{ hooks: [] }],
      },
    });
  });
});

describe('parseMcpJson', () => {
  it('parses the wrapped form with secrets from env and headers', () => {
    const cfgs = parseMcpJson({
      mcpServers: {
        context7: {
          type: 'http',
          url: 'https://mcp.context7.com/mcp',
          headers: { Authorization: '${CONTEXT7_API_KEY:-}' },
        },
        fs: {
          command: 'npx',
          args: ['-y', 'server-fs', '.'],
          env: { TOKEN: '${FS_TOKEN}', ROOT: '${CLAUDE_PLUGIN_ROOT}' },
        },
      },
    });
    expect(cfgs).toEqual([
      {
        name: 'context7',
        transport: 'http',
        url: 'https://mcp.context7.com/mcp',
        headers: { Authorization: '${CONTEXT7_API_KEY:-}' },
        secrets: [
          { name: 'CONTEXT7_API_KEY', in: 'header', header: 'Authorization', required: false },
        ],
        source: { type: 'origin' },
      },
      {
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'server-fs', '.'],
        env: { TOKEN: '${FS_TOKEN}', ROOT: '${CLAUDE_PLUGIN_ROOT}' },
        secrets: [{ name: 'FS_TOKEN', in: 'env', required: true }],
        source: { type: 'origin' },
      },
    ]);
  });

  it('parses the flat form and bearer header formats', () => {
    expect(
      parseMcpJson({
        github: {
          type: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          headers: { Authorization: 'Bearer ${GITHUB_PAT}' },
        },
      }),
    ).toEqual([
      {
        name: 'github',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer ${GITHUB_PAT}' },
        secrets: [
          {
            name: 'GITHUB_PAT',
            in: 'header',
            header: 'Authorization',
            required: true,
            format: 'Bearer {value}',
          },
        ],
        source: { type: 'origin' },
      },
    ]);
  });

  it('parses VS Code servers, sse, Gemini httpUrl and skips junk', () => {
    const cfgs = parseMcpJson({
      servers: {
        a: { type: 'sse', url: 'https://a/sse' },
        b: { httpUrl: 'https://b/mcp' },
        c: { url: 'https://c/sse' },
        d: { type: 'stdio' },
        e: 'nope',
      },
    });
    expect(cfgs.map((c) => [c.name, c.transport, c.url])).toEqual([
      ['a', 'sse', 'https://a/sse'],
      ['b', 'http', 'https://b/mcp'],
      ['c', 'sse', 'https://c/sse'],
    ]);
    expect(parseMcpJson({ name: 'not-mcp', version: '1' })).toEqual([]);
    expect(parseMcpJson([1, 2])).toEqual([]);
  });

  it('finds secrets in the URL and args and merges a name used in env and a header', () => {
    const [remote, local] = parseMcpJson({
      remote: {
        type: 'http',
        url: 'https://x/${REGION}/mcp?k=${URL_KEY:-}',
        env: { T: '${TOK:-x}' },
        headers: { Authorization: 'Bearer ${TOK}', 'X-Two': '${A1}:${PLUGIN_ROOT}' },
      },
      local: { command: 'x', args: ['--key=${ARG_KEY}', '${HOME}/x'] },
    });
    expect(remote?.secrets).toEqual([
      {
        name: 'TOK',
        in: 'header',
        header: 'Authorization',
        required: true,
        format: 'Bearer {value}',
      },
      { name: 'A1', in: 'header', header: 'X-Two', required: true },
      { name: 'REGION', in: 'env', required: true },
      { name: 'URL_KEY', in: 'env', required: false },
    ]);
    expect(local?.secrets).toEqual([{ name: 'ARG_KEY', in: 'env', required: true }]);
  });

  it('flags empty and placeholder env values as secrets', () => {
    const [cfg] = parseMcpJson({
      x: { command: 'x', env: { API_KEY: '', OTHER: '<your key>', PLAIN: 'value' } },
    });
    expect(cfg?.secrets).toEqual([
      { name: 'API_KEY', in: 'env', required: true },
      { name: 'OTHER', in: 'env', required: true },
    ]);
  });
});
