import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Entity, LayoutDescriptor, OriginSpec, ScanResult } from '../../src/core/types.js';
import { scanOrigin } from '../../src/index/scan.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

function spec(alias: string, extra: Partial<OriginSpec> = {}): OriginSpec {
  return { alias, type: 'local', path: join(FIXTURES, alias), ...extra };
}

async function scan(fixture: string, extra: Partial<OriginSpec> = {}): Promise<ScanResult> {
  return scanOrigin(join(FIXTURES, fixture), spec(fixture.replace(/-like$/, ''), extra));
}

/** `kind:name path <plugin>` — compact, order-independent view of an index. */
function summary(r: ScanResult): string[] {
  return r.entities
    .map((e) => `${e.kind}:${e.name} ${e.path}${e.plugin ? ` <${e.plugin}>` : ''}`)
    .sort();
}

function members(r: ScanResult): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of r.entities)
    if (e.def.kind === 'plugin')
      out[e.name] = e.def.members.map((m) => `${m.kind}:${m.name}`).sort();
  return out;
}

function find(r: ScanResult, kind: Entity['kind'], name: string): Entity {
  const e = r.entities.find((x) => x.kind === kind && x.name === name);
  if (!e) throw new Error(`no ${kind} ${name} in ${summary(r).join(', ')}`);
  return e;
}

interface Case {
  fixture: string;
  extra?: Partial<OriginSpec>;
  detected: ScanResult['detected'];
  entities: string[];
  plugins?: Record<string, string[]>;
  /** Every pattern must match some warning, and the number of warnings must equal the list length. */
  warnings: RegExp[];
}

const CASES: Case[] = [
  {
    fixture: 'mattpocock-like',
    detected: 'marketplace',
    entities: [
      'plugin:mattpocock-skills .',
      'skill:git-guardrails skills/misc/git-guardrails',
      'skill:grill-me skills/engineering/grill-me <mattpocock-skills>',
      'skill:handoff skills/productivity/handoff <mattpocock-skills>',
      'skill:old-thing skills/deprecated/old-thing',
      'skill:tdd skills/engineering/tdd <mattpocock-skills>',
    ],
    plugins: { 'mattpocock-skills': ['skill:grill-me', 'skill:handoff', 'skill:tdd'] },
    warnings: [
      /plugin "mattpocock-skills" at \. does not declare 2 skills \(old-thing, git-guardrails\); indexed standalone/,
    ],
  },
  {
    fixture: 'superpowers-like',
    detected: 'marketplace',
    entities: [
      'hook:superpowers hooks/hooks.json <superpowers>',
      'plugin:superpowers .',
      'skill:brainstorming skills/brainstorming <superpowers>',
      'skill:test-driven-development skills/test-driven-development <superpowers>',
      'skill:writing-skills skills/writing-skills <superpowers>',
    ],
    plugins: {
      superpowers: [
        'hook:superpowers',
        'skill:brainstorming',
        'skill:test-driven-development',
        'skill:writing-skills',
      ],
    },
    warnings: [],
  },
  {
    fixture: 'cursor-monorepo-like',
    detected: 'marketplace',
    entities: [
      'agent:ci-watcher team-kit/agents/ci-watcher.md <cursor-team-kit>',
      'agent:comment-sicko pstack/agents/comment-sicko.md <pstack>',
      'hook:cursor-team-kit team-kit/hooks/hooks.json <cursor-team-kit>',
      'instruction:no-inline-imports team-kit/rules/no-inline-imports.mdc <cursor-team-kit>',
      'instruction:typescript team-kit/rules/typescript.mdc <cursor-team-kit>',
      'mcp:ahrefs third_party/ahrefs/mcp.json <ahrefs>',
      'plugin:ahrefs third_party/ahrefs',
      'plugin:cursor-team-kit team-kit',
      'plugin:pstack pstack',
      'skill:ci-watch team-kit/skills/ci-watch <cursor-team-kit>',
      'skill:poteto-mode pstack/skills/poteto-mode <pstack>',
      'skill:setup-benny pstack/automations/benny/skills/setup-benny',
      'skill:tdd pstack/skills/tdd <pstack>',
    ],
    plugins: {
      pstack: ['agent:comment-sicko', 'skill:poteto-mode', 'skill:tdd'],
      ahrefs: ['mcp:ahrefs'],
      // The duplicate `tdd` resolves to the first one indexed (pstack's).
      'cursor-team-kit': [
        'agent:ci-watcher',
        'hook:cursor-team-kit',
        'instruction:no-inline-imports',
        'instruction:typescript',
        'skill:ci-watch',
        'skill:tdd',
      ],
    },
    warnings: [
      /poteto-mode\/SKILL\.md: frontmatter name "Poteto Mode" is not a valid slug; using "poteto-mode"/,
      /duplicate skill "tdd" at team-kit\/skills\/tdd ignored \(already indexed from pstack\/skills\/tdd\)/,
      /remote plugin "far-away" \(github:acme\/far-away#v1\.0\.0\) not fetched → add it as an origin: palm install origin acme\/far-away#v1\.0\.0/,
      /plugin "missing-dir": source directory does-not-exist not found; skipped/,
      /plugin "pstack" at pstack does not declare 1 skill \(setup-benny\)/,
    ],
  },
  {
    fixture: 'anthropics-skills-like',
    detected: 'marketplace',
    entities: [
      'plugin:document-skills .',
      'plugin:example-skills .',
      'skill:canvas-design skills/canvas-design <example-skills>',
      'skill:internal-only skills/internal-only',
      'skill:pdf skills/pdf <document-skills>',
      'skill:xlsx skills/xlsx <document-skills>',
    ],
    plugins: {
      'document-skills': ['skill:pdf', 'skill:xlsx'],
      'example-skills': ['skill:canvas-design'],
    },
    warnings: [
      /skipped skills\/skeleton\/SKILL\.md: skill template/,
      /plugins "document-skills", "example-skills" at \. do not declare 1 skill \(internal-only\)/,
    ],
  },
  {
    fixture: 'claude-plugins-official-like',
    detected: 'marketplace',
    entities: [
      'agent:agent-sdk-verifier-py plugins/agent-sdk-dev/agents/agent-sdk-verifier-py.md <agent-sdk-dev>',
      'command:new-sdk-app plugins/agent-sdk-dev/commands/new-sdk-app.md <agent-sdk-dev>',
      'hook:agent-sdk-dev plugins/agent-sdk-dev/hooks/hooks.json <agent-sdk-dev>',
      'mcp:context7 external_plugins/context7/.mcp.json <context7>',
      'mcp:fs external_plugins/context7/.mcp.json <context7>',
      'mcp:github external_plugins/github/.mcp.json <github>',
      'plugin:agent-sdk-dev plugins/agent-sdk-dev',
      'plugin:context7 external_plugins/context7',
      'plugin:github external_plugins/github',
      'skill:sdk-helper plugins/agent-sdk-dev/skills/sdk-helper <agent-sdk-dev>',
    ],
    plugins: {
      'agent-sdk-dev': [
        'agent:agent-sdk-verifier-py',
        'command:new-sdk-app',
        'hook:agent-sdk-dev',
        'skill:sdk-helper',
      ],
      github: ['mcp:github'],
      context7: ['mcp:context7', 'mcp:fs'],
    },
    warnings: [
      /plugin clangd-lsp: lspServers not supported by palm \(ignored\)/,
      /plugin "clangd-lsp" at plugins\/clangd-lsp has no installable components; skipped/,
      /remote plugin "42crunch" \(https:\/\/github\.com\/42Crunch-AI\/claude-plugins\.git \(plugins\/api-security-testing\)@faf5305385de\) not fetched/,
      /remote plugin "agentforce-adlc" .* palm install origin https:\/\/github\.com\/SalesforceAIResearch\/agentforce-adlc\.git$/,
      /plugin "npm-plugin": unsupported source npm:@acme\/plugin; skipped/,
    ],
  },
  {
    fixture: 'awesome-copilot-like',
    detected: 'marketplace',
    entities: [
      'agent:c-sharp-expert agents/CSharpExpert.agent.md',
      'agent:meta-agentic-project-scaffold agents/meta-agentic-project-scaffold.agent.md <awesome-copilot>',
      'hook:license-checker hooks/license-checker/hooks.json',
      'instruction:a11y instructions/a11y.instructions.md',
      'instruction:python instructions/python.instructions.md',
      'mcp:awesome-copilot plugins/awesome-copilot/mcp.json <awesome-copilot>',
      'plugin:awesome-copilot plugins/awesome-copilot',
      'skill:qdrant-horizontal-scaling skills/qdrant-scaling/scaling-data-volume/horizontal-scaling',
      'skill:qdrant-scaling skills/qdrant-scaling',
      'skill:suggest-awesome-github-copilot-agents skills/suggest-awesome-github-copilot-agents <awesome-copilot>',
    ],
    plugins: {
      'awesome-copilot': [
        'agent:meta-agentic-project-scaffold',
        'mcp:awesome-copilot',
        'skill:suggest-awesome-github-copilot-agents',
      ],
    },
    warnings: [
      /remote plugin "agent-council" \(github:Avyayalaya\/agent-council#v0\.1\.3\)/,
      /remote plugin "anarlog" \(github:fastrepl\/anarlog\/agent-plugins\/anarlog@259b68866a7d\)/,
      /horizontal-scaling\/SKILL\.md: frontmatter name "qdrant-horizontal-scaling" differs from directory "horizontal-scaling"/,
    ],
  },
  {
    fixture: 'openai-like',
    detected: 'convention',
    entities: [
      'skill:beta-thing skills/.experimental/beta-thing',
      'skill:gh-fix-ci skills/.curated/gh-fix-ci',
      'skill:notion-spec skills/.curated/notion-spec',
      'skill:skill-creator skills/.system/skill-creator',
    ],
    warnings: [],
  },
  {
    fixture: 'vercel-like',
    detected: 'convention',
    entities: [
      'skill:deploy-to-vercel skills/Deploy To Vercel',
      'skill:vercel-react-best-practices skills/react-best-practices',
      'skill:web-design-guidelines skills/web-design-guidelines',
    ],
    warnings: [
      /Deploy To Vercel\/SKILL\.md: frontmatter name "Deploy To Vercel" is not a valid slug; using "deploy-to-vercel"/,
      /react-best-practices\/SKILL\.md: frontmatter name "vercel-react-best-practices" differs from directory "react-best-practices"; keeping "vercel-react-best-practices"/,
    ],
  },
  {
    fixture: 'apm-like',
    detected: 'apm',
    entities: [
      'agent:reviewer .apm/agents/reviewer.agent.md <my-apm-pkg>',
      'command:release .apm/prompts/release.prompt.md <my-apm-pkg>',
      'hook:format-on-save .apm/hooks/format-on-save.json <my-apm-pkg>',
      'instruction:typescript .apm/instructions/typescript.instructions.md <my-apm-pkg>',
      'plugin:my-apm-pkg .',
      'skill:lint-fix .apm/skills/lint-fix <my-apm-pkg>',
    ],
    plugins: {
      'my-apm-pkg': [
        'agent:reviewer',
        'command:release',
        'hook:format-on-save',
        'instruction:typescript',
        'skill:lint-fix',
      ],
    },
    warnings: [],
  },
  {
    fixture: 'codex-agent-like',
    detected: 'convention',
    entities: [
      'agent:reviewer agents/reviewer.toml',
      'command:explain prompts/explain.prompt.md',
      'command:review commands/review.toml',
      'command:ship commands/ship.md',
      'hook:codex-agent hooks/hooks.json',
      'instruction:style rules/style.mdc',
      'mcp:local-fs .mcp.json',
    ],
    warnings: [/skipped agents\/partial\.md: agent file without name\/description frontmatter/],
  },
  {
    fixture: 'caveman-like',
    detected: 'marketplace',
    entities: [
      'agent:cavecrew-builder agents/cavecrew-builder.md <caveman>',
      'command:caveman commands/caveman.toml <caveman>',
      'command:caveman-init commands/caveman-init.md <caveman>',
      'hook:caveman .claude-plugin/plugin.json <caveman>',
      'plugin:caveman .',
      'skill:caveman skills/caveman <caveman>',
      'skill:caveman-commit skills/caveman-commit <caveman>',
    ],
    plugins: {
      caveman: [
        'agent:cavecrew-builder',
        'command:caveman',
        'command:caveman-init',
        'hook:caveman',
        'skill:caveman',
        'skill:caveman-commit',
      ],
    },
    warnings: [
      /duplicate command "caveman-init" at commands\/caveman-init\.toml ignored \(already indexed from commands\/caveman-init\.md\)/,
      /duplicate skill "caveman" at plugins\/caveman\/skills\/caveman ignored \(already indexed from skills\/caveman\)/,
    ],
  },
  {
    fixture: 'voltagent-like',
    detected: 'marketplace',
    entities: [
      'agent:api-designer categories/01-core-development/api-designer.md <voltagent-core-dev>',
      'agent:backend-developer categories/01-core-development/backend-developer.md <voltagent-core-dev>',
      'plugin:voltagent-core-dev categories/01-core-development',
    ],
    plugins: { 'voltagent-core-dev': ['agent:api-designer', 'agent:backend-developer'] },
    warnings: [/plugin voltagent-core-dev: declared agent path "\.\/missing\.md" not found/],
  },
  {
    fixture: 'nested-plugins-like',
    detected: 'plugin-manifest',
    entities: [
      'command:go plugins/alpha/commands/go.md <alpha>',
      'command:hello plugins/beta/commands/hello.toml <beta>',
      'mcp:beta-server plugins/beta/gemini-extension.json <beta>',
      'plugin:alpha plugins/alpha',
      'plugin:beta plugins/beta',
      'skill:alpha-skill plugins/alpha/skills/alpha-skill <alpha>',
      'skill:loose skills/loose',
    ],
    plugins: {
      alpha: ['command:go', 'skill:alpha-skill'],
      beta: ['command:hello', 'mcp:beta-server'],
    },
    warnings: [],
  },
  {
    fixture: 'root-skill-like',
    detected: 'convention',
    entities: ['skill:last30days .'],
    warnings: [],
  },
  {
    fixture: 'descriptor-like',
    extra: {
      layout: {
        skills: ['catalog/skills/*'],
        agents: ['catalog/people/*.md', 'catalog/tests/*.md'],
        exclude: ['catalog/skills/gamma'],
      },
    },
    detected: 'descriptor',
    entities: [
      'agent:helper catalog/tests/helper.md',
      'agent:reviewer catalog/people/reviewer.md',
      'skill:alpha catalog/skills/alpha',
      'skill:beta-renamed catalog/skills/beta',
    ],
    warnings: [
      /catalog\/skills\/beta\/SKILL\.md: frontmatter name "beta-renamed" differs from directory "beta"/,
    ],
  },
];

describe('scanOrigin fixtures', () => {
  it.each(CASES.map((c) => [c.fixture + (c.extra ? ' (descriptor)' : ''), c] as const))(
    '%s',
    async (_label, c) => {
      const r = await scan(c.fixture, c.extra);
      expect(r.detected).toBe(c.detected);
      expect(summary(r)).toEqual([...c.entities].sort());
      if (c.plugins) expect(members(r)).toEqual(c.plugins);
      else expect(members(r)).toEqual({});
      for (const re of c.warnings)
        expect(
          r.warnings.some((w) => re.test(w)),
          `no warning matches ${re}\n${r.warnings.join('\n')}`,
        ).toBe(true);
      expect(r.warnings, r.warnings.join('\n')).toHaveLength(c.warnings.length);
      for (const e of r.entities) {
        expect(e.origin).toBe(c.fixture.replace(/-like$/, ''));
        expect(e.def.kind).toBe(e.kind);
      }
    },
  );
});

describe('scanOrigin definitions', () => {
  it('mattpocock-like: skills carry the plugin version and never index agents/openai.yaml', async () => {
    const r = await scan('mattpocock-like');
    expect(r.entities.some((e) => e.kind === 'agent')).toBe(false);
    expect(find(r, 'skill', 'tdd')).toMatchObject({
      version: '1.2.3',
      description: 'Test-driven development with red-green-refactor.',
    });
    expect(find(r, 'skill', 'git-guardrails').version).toBeUndefined();
    expect(find(r, 'plugin', 'mattpocock-skills')).toMatchObject({
      version: '1.2.3',
      description: "Matt Pocock's agent skills for real engineering.",
      def: { manifestPath: '.claude-plugin/plugin.json' },
    });
  });

  it('superpowers-like: picks the Claude manifest and its hooks dialect', async () => {
    const r = await scan('superpowers-like');
    const hook = find(r, 'hook', 'superpowers');
    expect(hook.def).toEqual({
      kind: 'hook',
      hooks: {
        name: 'superpowers',
        dialect: 'claude',
        pluginRootRel: '.',
        raw: {
          hooks: {
            SessionStart: [
              {
                matcher: 'startup|clear|compact',
                hooks: [
                  {
                    type: 'command',
                    command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
                    async: false,
                  },
                ],
              },
            ],
          },
        },
      },
    });
    expect(find(r, 'skill', 'test-driven-development').description).toBe(
      'Use when implementing any feature or bugfix, before writing implementation code.',
    );
    expect(find(r, 'plugin', 'superpowers').version).toBe('6.4.2');
  });

  it('cursor-monorepo-like: display-name agents, Cursor formats, rules and hooks', async () => {
    const r = await scan('cursor-monorepo-like');
    expect(find(r, 'agent', 'comment-sicko').def).toEqual({
      kind: 'agent',
      agent: {
        name: 'comment-sicko',
        displayName: 'Comment Sicko',
        description: 'A deranged comment-hater that savors deletion.',
        body: '# Comment Sicko\n\nI hate comments.\n',
        sourceFormat: 'cursor-md',
      },
    });
    expect(find(r, 'agent', 'ci-watcher').def).toMatchObject({
      agent: { model: 'fast', extra: { readonly: true }, sourceFormat: 'cursor-md' },
    });
    expect(find(r, 'instruction', 'typescript').def).toEqual({
      kind: 'instruction',
      instruction: {
        name: 'typescript',
        description: 'TypeScript conventions',
        globs: ['**/*.ts', '**/*.tsx'],
        alwaysApply: false,
        body: 'Use exhaustive switches.\n',
        sourceFormat: 'mdc',
      },
    });
    expect(find(r, 'instruction', 'no-inline-imports').def).toMatchObject({
      instruction: { alwaysApply: true },
    });
    expect(find(r, 'hook', 'cursor-team-kit').def).toMatchObject({
      hooks: { dialect: 'cursor', pluginRootRel: 'team-kit' },
    });
    expect(find(r, 'mcp', 'ahrefs').def).toEqual({
      kind: 'mcp',
      mcp: {
        name: 'ahrefs',
        transport: 'http',
        url: 'https://api.ahrefs.com/mcp/mcp',
        source: { type: 'origin', ref: 'cursor-monorepo', version: '1.0.0' },
      },
    });
    expect(find(r, 'plugin', 'pstack').def).toMatchObject({
      manifestPath: 'pstack/.cursor-plugin/plugin.json',
    });
    // .cursor/rules is maintainer config, not content.
    expect(r.entities.some((e) => e.path.startsWith('.cursor/'))).toBe(false);
  });

  it('anthropics-skills-like: strict:false subsets share the root; license passes through', async () => {
    const r = await scan('anthropics-skills-like');
    expect(find(r, 'plugin', 'document-skills')).toMatchObject({
      path: '.',
      description: 'Document processing suite',
      def: { manifestPath: '.claude-plugin/marketplace.json' },
    });
    expect(find(r, 'skill', 'xlsx').def).toMatchObject({
      skill: { license: 'Proprietary. LICENSE.txt has complete terms' },
    });
    expect(r.entities.some((e) => e.name === 'template-skill')).toBe(false);
  });

  it('claude-plugins-official-like: commands, agents, flat and wrapped .mcp.json', async () => {
    const r = await scan('claude-plugins-official-like');
    expect(find(r, 'command', 'new-sdk-app').def).toEqual({
      kind: 'command',
      command: {
        name: 'new-sdk-app',
        description: 'Create and setup a new Claude Agent SDK application',
        argumentHint: '[project-name]',
        body: 'You are tasked with helping the user create a new Claude Agent SDK application.\n',
        sourceFormat: 'claude-md',
      },
    });
    expect(find(r, 'agent', 'agent-sdk-verifier-py').def).toMatchObject({
      agent: {
        description:
          'Use this agent to verify a Python Agent SDK app. Examples: <example>Context: user created an app</example>',
        model: 'sonnet',
        tools: ['Read', 'Grep', 'Glob', 'Bash(python -m pytest:*)'],
        skills: ['sdk-helper'],
        mcpServers: ['context7'],
        color: 'green',
        sourceFormat: 'claude-md',
      },
    });
    expect(find(r, 'hook', 'agent-sdk-dev').def).toMatchObject({
      hooks: { dialect: 'claude', pluginRootRel: 'plugins/agent-sdk-dev' },
    });
    expect(find(r, 'mcp', 'github').def).toMatchObject({
      mcp: {
        transport: 'http',
        secrets: [
          {
            name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
            in: 'header',
            header: 'Authorization',
            required: true,
            format: 'Bearer {value}',
          },
        ],
      },
    });
    expect(find(r, 'mcp', 'fs').def).toMatchObject({
      mcp: {
        transport: 'stdio',
        command: 'npx',
        secrets: [{ name: 'FS_TOKEN', in: 'env', required: true }],
      },
    });
    expect(find(r, 'skill', 'sdk-helper')).toMatchObject({
      version: '1.10',
      def: {
        skill: {
          allowedTools: ['Read', 'Grep', 'WebFetch'],
          metadata: { version: '1.10', author: 'anthropic' },
        },
      },
    });
  });

  it('awesome-copilot-like: materialized agent paths, instructions, Copilot hooks, sub-skills', async () => {
    const r = await scan('awesome-copilot-like');
    expect(find(r, 'agent', 'meta-agentic-project-scaffold').def).toMatchObject({
      agent: {
        displayName: 'Meta Agentic Project Scaffold',
        tools: ['changes', 'codebase', 'fetch'],
        model: 'GPT-4.1',
        sourceFormat: 'copilot-agent-md',
      },
    });
    expect(find(r, 'agent', 'c-sharp-expert').def).toMatchObject({
      agent: { displayName: 'C# Expert', extra: { 'mcp-servers': { nuget: { command: 'dnx' } } } },
    });
    expect(find(r, 'instruction', 'a11y').def).toMatchObject({
      instruction: { alwaysApply: true, sourceFormat: 'instructions-md' },
    });
    expect(find(r, 'instruction', 'python').def).toMatchObject({
      instruction: { globs: ['**/*.py', '**/*.pyi'], alwaysApply: false },
    });
    expect(find(r, 'hook', 'license-checker').def).toMatchObject({
      hooks: { dialect: 'copilot', pluginRootRel: 'hooks/license-checker' },
    });
    expect(find(r, 'skill', 'qdrant-horizontal-scaling').def).toMatchObject({
      skill: {
        parent: 'qdrant-scaling',
        dirName: 'horizontal-scaling',
        description: "Diagnoses horizontal scaling: 'vertical or horizontal?', 'how many nodes?'",
      },
    });
    expect(find(r, 'skill', 'qdrant-scaling').def).not.toHaveProperty('skill.parent');
    // .github/{skills,agents}, .vscode/mcp.json are install output / dev config.
    expect(
      r.entities.some((e) => e.path.startsWith('.github/') || e.path.startsWith('.vscode/')),
    ).toBe(false);
  });

  it('apm-like: APM sources win and install outputs are ignored', async () => {
    const r = await scan('apm-like');
    expect(find(r, 'agent', 'reviewer').def).toMatchObject({
      agent: { sourceFormat: 'apm-agent-md', tools: ['read', 'search'] },
    });
    expect(find(r, 'plugin', 'my-apm-pkg')).toMatchObject({
      version: '1.0.0',
      description: 'A sample APM package',
      def: { manifestPath: 'apm.yml' },
    });
    expect(find(r, 'hook', 'format-on-save').def).toMatchObject({
      hooks: { dialect: 'claude', pluginRootRel: '.' },
    });
  });

  it('codex-agent-like: Codex TOML agent, Gemini command and Gemini hooks', async () => {
    const r = await scan('codex-agent-like');
    expect(find(r, 'agent', 'reviewer').def).toMatchObject({
      agent: {
        description: 'PR reviewer focused on correctness and security.',
        model: 'gpt-5.4',
        mcpServers: ['docs'],
        body: 'Review code like an owner.\nPrioritize correctness, security, behavior regressions.\n',
        sourceFormat: 'codex-toml',
        extra: { model_reasoning_effort: 'high', sandbox_mode: 'read-only' },
      },
    });
    expect(find(r, 'command', 'review').def).toMatchObject({
      command: { body: 'Review {{args}} carefully.', sourceFormat: 'gemini-toml' },
    });
    expect(find(r, 'command', 'ship').def).toMatchObject({
      command: { argumentHint: '[--dry-run]' },
    });
    expect(find(r, 'hook', 'codex-agent').def).toMatchObject({
      hooks: { dialect: 'gemini', pluginRootRel: '.' },
    });
    expect(find(r, 'instruction', 'style').def).toMatchObject({
      instruction: { globs: ['src/**/*.ts'], alwaysApply: false },
    });
  });

  it('caveman-like: inline manifest hooks are wrapped', async () => {
    const r = await scan('caveman-like');
    expect(find(r, 'hook', 'caveman').def).toMatchObject({
      hooks: {
        dialect: 'claude',
        pluginRootRel: '.',
        raw: { hooks: { SessionStart: [{ hooks: [{ type: 'command', timeout: 30 }] }] } },
      },
    });
  });

  it('nested-plugins-like: one manifest per plugin (Claude beats Codex), Gemini inline MCP', async () => {
    const r = await scan('nested-plugins-like');
    expect(find(r, 'plugin', 'alpha')).toMatchObject({
      version: '0.1.0',
      def: { manifestPath: 'plugins/alpha/.claude-plugin/plugin.json' },
    });
    expect(find(r, 'mcp', 'beta-server').def).toMatchObject({
      mcp: { transport: 'http', url: 'https://beta.example.com/mcp' },
    });
  });

  it('root-skill-like: the whole origin is one skill, non-spec keys pass through', async () => {
    const r = await scan('root-skill-like');
    expect(find(r, 'skill', 'last30days')).toMatchObject({
      version: '2.1.0',
      def: {
        skill: {
          allowedTools: ['Bash', 'Read', 'WebSearch'],
          extra: { 'argument-hint': '[topic]', 'user-invocable': true },
          metadata: { openclaw: expect.stringContaining('emoji') },
        },
      },
    });
  });

  it('vercel-like: records dirName for renamed skills', async () => {
    const r = await scan('vercel-like');
    expect(find(r, 'skill', 'vercel-react-best-practices')).toMatchObject({
      version: '1.0.0',
      def: { skill: { dirName: 'react-best-practices', license: 'MIT' } },
    });
  });
});

describe('scanOrigin layout options', () => {
  const layoutScan = (fixture: string, layout: LayoutDescriptor, extra: Partial<OriginSpec> = {}) =>
    scan(fixture, { layout, ...extra });

  it('descriptor include restricts to canonical names', async () => {
    const r = await layoutScan('descriptor-like', {
      skills: 'catalog/skills/*',
      include: ['alpha'],
    });
    expect(summary(r)).toEqual(['skill:alpha catalog/skills/alpha']);
  });

  it('nameFrom: dirname uses directory names', async () => {
    const r = await layoutScan('descriptor-like', {
      skills: ['catalog/skills/*'],
      nameFrom: 'dirname',
      exclude: ['catalog/skills/gamma'],
    });
    expect(summary(r)).toEqual([
      'skill:alpha catalog/skills/alpha',
      'skill:beta catalog/skills/beta',
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('descriptor globs match dot directories', async () => {
    const r = await layoutScan('openai-like', { skills: ['skills/.curated/*'] });
    expect(r.detected).toBe('descriptor');
    expect(summary(r)).toEqual([
      'skill:gh-fix-ci skills/.curated/gh-fix-ci',
      'skill:notion-spec skills/.curated/notion-spec',
    ]);
  });

  it('include/exclude without kind globs keep auto-detection', async () => {
    const r = await layoutScan('vercel-like', { include: ['web-design-guidelines'] });
    expect(r.detected).toBe('convention');
    expect(summary(r)).toEqual(['skill:web-design-guidelines skills/web-design-guidelines']);
    const ex = await layoutScan('openai-like', {
      exclude: ['skills/.system', 'skills/.experimental/**'],
    });
    expect(summary(ex)).toEqual([
      'skill:gh-fix-ci skills/.curated/gh-fix-ci',
      'skill:notion-spec skills/.curated/notion-spec',
    ]);
  });

  it('include also filters plugin members', async () => {
    const r = await layoutScan('mattpocock-like', { include: ['mattpocock-skills', 'tdd'] });
    expect(members(r)).toEqual({ 'mattpocock-skills': ['skill:tdd'] });
  });

  it('a semver ref supplies the version when nothing else does', async () => {
    const r = await scan('openai-like', { ref: 'v2.3.4' });
    expect(r.entities.every((e) => e.version === '2.3.4')).toBe(true);
    const branch = await scan('openai-like', { ref: 'main' });
    expect(branch.entities.every((e) => e.version === undefined)).toBe(true);
  });
});
