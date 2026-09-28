// Terminal sessions recorded by scripts/capture.mjs for the docs.
//
// A spec runs in a fresh sandbox home (printed as ~) with an empty project at ~/project:
//   name       output file: src/captures/<name>.txt (and <name>.files.txt with `files: true`)
//   origins    fixture origins: test/fixtures/<fixture> is copied to ~/src/<dir> and added with
//              `palm origin add ~/src/<dir> --alias <alias>` before the shown commands (not shown)
//   setup      steps run after the origins and before the shown commands (not shown)
//   commands   steps run in ~/project and shown with their real output. A step is a palm argument
//              list (an argument starting with ~/ or file://~/ is expanded as a shell would),
//              { palm: [...], exit: n } for a command expected to exit n, or { sh: '<bash>' } for
//              a shell command ($FIXTURES is test/fixtures; git commits get a fixed identity and
//              date, so their shas repeat). Every step must exit 0 unless it names `exit`.
//   files      also record which files under ~/project the shown commands created or changed
//
// Pages include a capture with <Capture name="..." /> and its files with <CaptureTree name="..." />.

export const specs = [
  {
    name: 'palm-help',
    commands: [['--help']],
  },
  {
    name: 'landing',
    origins: [
      { fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' },
      { fixture: 'cursor-monorepo-like/pstack', dir: 'pstack', alias: 'pstack' },
    ],
    commands: [
      [
        'install',
        'agent',
        'comment-sicko',
        '--target',
        'claude,codex,copilot,cursor,gemini,opencode',
      ],
      ['install', 'skill', 'tdd@mattpocock'],
    ],
    files: true,
  },
  // Section A: landing, getting started, concepts and explanation pages. Names start with a-.
  {
    name: 'a-ambiguity',
    origins: [
      { fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' },
      { fixture: 'cursor-monorepo-like/pstack', dir: 'pstack', alias: 'pstack' },
    ],
    commands: [
      ['search', 'skill', 'tdd'],
      ['install', 'skill', 'tdd@mattpocock', '--target', 'claude,cursor'],
    ],
  },
  {
    name: 'a-quick-start',
    origins: [{ fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' }],
    commands: [
      ['init', '--target', 'claude,codex'],
      ['get', 'skills', '--available'],
      ['install', 'skill', 'grill-me'],
    ],
    files: true,
  },
  {
    name: 'a-quick-start-remove',
    origins: [{ fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' }],
    commands: [
      ['install', 'skill', 'grill-me', '--target', 'claude,codex'],
      ['uninstall', 'skill', 'grill-me'],
      ['get'],
    ],
    files: true,
  },
  {
    name: 'a-targets',
    origins: [{ fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' }],
    commands: [
      ['install', 'skill', 'tdd', '--target', 'claude,codex'],
      ['get', 'targets'],
    ],
  },
  {
    name: 'a-describe-target',
    commands: [['describe', 'target', 'codex']],
  },
  {
    name: 'a-scopes',
    origins: [{ fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' }],
    commands: [
      ['install', 'skill', 'tdd', '--target', 'claude'],
      ['install', 'skill', 'tdd', '-g', '--target', 'claude'],
    ],
  },
  {
    name: 'a-lockfile',
    origins: [{ fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' }],
    commands: [
      ['install', 'skill', 'tdd', '--target', 'claude,codex'],
      ['install'],
      ['install', '--frozen'],
    ],
  },
  {
    name: 'a-dependencies',
    origins: [{ fixture: 'claude-plugins-official-like', dir: 'official', alias: 'official' }],
    commands: [
      ['install', 'agent', 'agent-sdk-verifier-py', '--target', 'claude,copilot'],
      ['why', 'skill', 'sdk-helper'],
    ],
  },
  {
    name: 'a-dependencies-remove',
    origins: [{ fixture: 'claude-plugins-official-like', dir: 'official', alias: 'official' }],
    commands: [
      ['install', 'agent', 'agent-sdk-verifier-py', '--target', 'claude,copilot'],
      ['install', 'skill', 'sdk-helper'],
      ['uninstall', 'agent', 'agent-sdk-verifier-py'],
      ['get'],
    ],
  },
  {
    name: 'a-scan-marketplace',
    // The fixture is registered once more under another alias before the session, because the
    // runner copies fixtures only through `origins`; the output is the same as a first add.
    origins: [
      { fixture: 'claude-plugins-official-like', dir: 'claude-plugins-official', alias: 'copy' },
    ],
    commands: [
      ['install', 'origin', '~/src/claude-plugins-official', '--alias', 'official'],
      ['get', '--available', '-o', 'official'],
    ],
  },
  {
    name: 'a-scan-layout',
    origins: [{ fixture: 'openai-like', dir: 'openai-skills', alias: 'openai' }],
    commands: [
      ['get', 'skills', '--available', '-o', 'openai'],
      [
        'install',
        'origin',
        '~/src/openai-skills',
        '--alias',
        'curated',
        '--layout',
        'skills=skills/.curated/*',
      ],
      ['get', 'skills', '--available', '-o', 'curated'],
    ],
  },
  {
    name: 'a-mcp-secrets',
    commands: [
      [
        'install',
        'mcp',
        'docs',
        '--url',
        'https://example.com/mcp',
        '--header',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: palm placeholder syntax, not a template
        'Authorization=Bearer ${DOCS_TOKEN}',
        '--target',
        'claude,codex,copilot,cursor,gemini,opencode',
      ],
    ],
    files: true,
  },
  {
    name: 'a-consent',
    origins: [{ fixture: 'superpowers-like', dir: 'superpowers', alias: 'superpowers' }],
    commands: [
      ['install', 'plugin', 'superpowers', '--target', 'claude,codex', '--dry-run'],
      ['install', 'plugin', 'superpowers', '--target', 'claude,codex', '--yes'],
    ],
  },
  {
    name: 'a-audit',
    origins: [{ fixture: 'hidden-unicode-like', dir: 'unicode-demo', alias: 'demo' }],
    commands: [
      ['install', 'skill', 'zero-width', '--target', 'claude'],
      ['audit'],
      ['audit', '--strip'],
      ['audit'],
    ],
  },
  // Section C: reference pages. Names start with c-. (c-help-* and c-cli-options.json are
  // written by scripts/cli-reference.mjs, not by these specs.)
  {
    name: 'c-install',
    origins: [
      { fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' },
      { fixture: 'cursor-monorepo-like/pstack', dir: 'pstack', alias: 'pstack' },
    ],
    commands: [
      ['install', 'skill', 'tdd@mattpocock', '--target', 'claude,codex'],
      ['install', 'agent', 'comment-sicko'],
      ['install'],
    ],
    files: true,
  },
  {
    name: 'c-uninstall',
    origins: [{ fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' }],
    setup: [['install', 'skill', 'tdd', '--target', 'claude,codex']],
    commands: [
      ['uninstall', 'skill', 'tdd', '--dry-run'],
      ['uninstall', 'skill', 'tdd'],
    ],
  },
  {
    name: 'c-get',
    origins: [
      { fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' },
      { fixture: 'cursor-monorepo-like/pstack', dir: 'pstack', alias: 'pstack' },
    ],
    setup: [['install', 'skill', 'tdd@mattpocock', '--target', 'claude,codex']],
    commands: [['get'], ['get', 'skills', '--available', '-o', 'mattpocock']],
  },
  {
    name: 'c-describe',
    origins: [{ fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' }],
    setup: [['install', 'skill', 'tdd', '--target', 'claude,codex']],
    commands: [['describe', 'skill', 'tdd']],
  },
  {
    name: 'c-update',
    setup: [
      {
        sh: 'cp -R "$FIXTURES/mattpocock-like" ~/src/skills && cd ~/src/skills && git init -q && git add -A && git commit -qm v1.0.0 && git tag v1.0.0',
      },
      ['install', 'origin', 'file://~/src/skills', '--alias', 'mattpocock'],
      ['install', 'skill', 'tdd', '--target', 'claude'],
      {
        sh: 'cd ~/src/skills && printf "\\nRefactor after each green test.\\n" >> skills/engineering/tdd/SKILL.md && git commit -qam v1.1.0 && git tag v1.1.0',
      },
    ],
    commands: [
      ['update', '--dry-run'],
      ['update', '--yes'],
    ],
  },
  {
    name: 'c-outdated',
    setup: [
      {
        sh: 'cp -R "$FIXTURES/mattpocock-like" ~/src/skills && cd ~/src/skills && git init -q && git add -A && git commit -qm v1.0.0 && git tag v1.0.0',
      },
      ['install', 'origin', 'file://~/src/skills', '--alias', 'mattpocock'],
      ['install', 'skill', 'tdd', '--target', 'claude'],
      ['install', 'skill', 'grill-me#v1.0.0'],
      {
        sh: 'cd ~/src/skills && printf "\\nRefactor after each green test.\\n" >> skills/engineering/tdd/SKILL.md && git commit -qam v1.1.0 && git tag v1.1.0',
      },
    ],
    commands: [['outdated']],
  },
  {
    name: 'c-search',
    origins: [
      { fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' },
      { fixture: 'cursor-monorepo-like/pstack', dir: 'pstack', alias: 'pstack' },
    ],
    commands: [['search', 'skill', 'tdd']],
  },
  {
    name: 'c-init',
    setup: [{ sh: 'printf "node_modules/\\n" > .gitignore' }],
    commands: [['init', '--target', 'claude,codex'], { sh: 'cat palm.yaml .gitignore' }],
  },
  {
    name: 'c-config',
    origins: [{ fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' }],
    commands: [
      ['config', 'set', 'targets', 'claude,codex'],
      ['config', 'get'],
      { sh: 'cat ~/.palm/config.yaml' },
    ],
  },
  {
    name: 'c-why',
    origins: [{ fixture: 'superpowers-like', dir: 'superpowers', alias: 'superpowers' }],
    setup: [['install', 'plugin', 'superpowers', '--target', 'claude', '--yes']],
    commands: [['why', 'skill', 'brainstorming']],
  },
  {
    name: 'c-find',
    origins: [{ fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' }],
    setup: [
      ['install', 'skill', 'tdd', '--target', 'claude,codex'],
      ['install', 'mcp', 'docs', '--url', 'https://example.com/mcp'],
    ],
    commands: [
      ['find', '.claude/skills/tdd/SKILL.md'],
      ['find', '.mcp.json'],
      { palm: ['find', 'README.md'], exit: 1 },
    ],
  },
  {
    name: 'c-audit',
    origins: [{ fixture: 'hidden-unicode-like', dir: 'unicode-demo', alias: 'demo' }],
    setup: [['install', 'skill', 'bidi-override', '--target', 'claude', '--force']],
    commands: [{ palm: ['audit'], exit: 1 }, ['audit', '--strip'], ['audit']],
  },
  {
    name: 'c-lockfile',
    setup: [
      {
        sh: 'cp -R "$FIXTURES/mattpocock-like" ~/src/skills && cd ~/src/skills && git init -q && git add -A && git commit -qm v1.2.0 && git tag v1.2.0',
      },
      ['install', 'origin', 'file://~/src/skills', '--alias', 'mattpocock'],
    ],
    commands: [
      ['install', 'skill', 'grill-me', '--target', 'claude,codex'],
      { sh: 'cat palm.yaml' },
      { sh: 'cat palm.lock.yaml' },
    ],
  },
  {
    name: 'c-manifest',
    origins: [{ fixture: 'cursor-monorepo-like/pstack', dir: 'pstack', alias: 'pstack' }],
    setup: [
      {
        sh: 'cp -R "$FIXTURES/mattpocock-like" ~/src/skills && cd ~/src/skills && git init -q && git add -A && git commit -qm v1.2.0 && git tag v1.2.0',
      },
      ['install', 'origin', 'file://~/src/skills', '--alias', 'mattpocock'],
      ['install', 'skill', 'tdd@mattpocock', '--target', 'claude,codex'],
      ['install', 'skill', 'grill-me#^1.2'],
      ['install', 'agent', 'comment-sicko'],
      [
        'install',
        'mcp',
        'docs',
        '--url',
        'https://example.com/mcp',
        '--header',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: palm placeholder syntax, not a template
        'Authorization=Bearer ${DOCS_TOKEN}',
      ],
      [
        'install',
        'mcp',
        'fs',
        '--yes',
        '--',
        'npx',
        '-y',
        '@modelcontextprotocol/server-filesystem',
        '.',
      ],
    ],
    commands: [{ sh: 'cat palm.yaml' }],
  },
  {
    name: 'c-lockfile-deps',
    origins: [{ fixture: 'claude-plugins-official-like', dir: 'official', alias: 'official' }],
    setup: [
      ['install', 'agent', 'agent-sdk-verifier-py', '--target', 'claude'],
      ['install', 'mcp', 'docs', '--url', 'https://example.com/mcp'],
    ],
    commands: [{ sh: 'cat palm.lock.yaml' }],
  },
  {
    name: 'c-json',
    origins: [{ fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' }],
    commands: [
      ['get', 'skills', '--json'],
      ['config', 'get', 'targets', '--json'],
      { palm: ['install', 'skill', 'nope', '--json'], exit: 1 },
    ],
  },
  {
    name: 'c-errors',
    origins: [
      { fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' },
      { fixture: 'cursor-monorepo-like/pstack', dir: 'pstack', alias: 'pstack' },
    ],
    setup: [['init', '--target', 'claude']],
    commands: [
      { palm: ['install', 'target', 'claude'], exit: 2 },
      { palm: ['install', 'skill', 'tdd'], exit: 1 },
      {
        palm: [
          'install',
          'mcp',
          'fs',
          '--',
          'npx',
          '-y',
          '@modelcontextprotocol/server-filesystem',
          '.',
        ],
        exit: 1,
      },
    ],
  },
  // Section B: guides. Names start with b-.
  {
    name: 'b-new-project',
    origins: [
      { fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' },
      {
        fixture: 'claude-plugins-official-like',
        dir: 'claude-plugins-official',
        alias: 'official',
      },
    ],
    setup: [{ sh: "printf 'node_modules/\\n' > .gitignore" }],
    commands: [
      ['init', '--target', 'claude,codex'],
      ['install', 'skill', 'tdd@mattpocock'],
      ['install', 'agent', 'agent-sdk-verifier-py'],
      ['install', 'mcp', 'docs', '--url', 'https://docs.example.com/mcp'],
    ],
    files: true,
  },
  {
    name: 'b-new-project-result',
    origins: [
      { fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' },
      {
        fixture: 'claude-plugins-official-like',
        dir: 'claude-plugins-official',
        alias: 'official',
      },
    ],
    setup: [
      { sh: "printf 'node_modules/\\n' > .gitignore" },
      ['init', '--target', 'claude,codex'],
      ['install', 'skill', 'tdd@mattpocock'],
      ['install', 'agent', 'agent-sdk-verifier-py'],
      ['install', 'mcp', 'docs', '--url', 'https://docs.example.com/mcp'],
    ],
    commands: [{ sh: 'cat palm.yaml' }, { sh: 'cat .gitignore' }, ['get']],
  },
  {
    name: 'b-six-install',
    origins: [
      {
        fixture: 'claude-plugins-official-like',
        dir: 'claude-plugins-official',
        alias: 'official',
      },
    ],
    commands: [
      [
        'install',
        'agent',
        'agent-sdk-verifier-py',
        '--target',
        'claude,codex,copilot,cursor,gemini,opencode',
      ],
    ],
    files: true,
  },
  {
    name: 'b-six-files',
    origins: [
      {
        fixture: 'claude-plugins-official-like',
        dir: 'claude-plugins-official',
        alias: 'official',
      },
    ],
    setup: [
      [
        'install',
        'agent',
        'agent-sdk-verifier-py',
        '--target',
        'claude,codex,copilot,cursor,gemini,opencode',
      ],
    ],
    commands: [
      { sh: 'cat .claude/agents/agent-sdk-verifier-py.md' },
      { sh: 'cat .codex/agents/agent-sdk-verifier-py.toml' },
      { sh: 'cat .github/agents/agent-sdk-verifier-py.agent.md' },
      { sh: 'cat .gemini/agents/agent-sdk-verifier-py.md' },
      { sh: 'cat .opencode/agents/agent-sdk-verifier-py.md' },
    ],
  },
  {
    name: 'b-six-skips',
    origins: [
      {
        fixture: 'claude-plugins-official-like',
        dir: 'claude-plugins-official',
        alias: 'official',
      },
    ],
    setup: [['init', '--target', 'claude,codex,copilot,cursor,gemini,opencode']],
    commands: [
      ['install', 'command', 'new-sdk-app'],
      ['install', 'hook', 'agent-sdk-dev', '--yes'],
    ],
  },
  {
    name: 'b-team-setup',
    setup: [
      {
        sh: 'cp -R "$FIXTURES/cursor-monorepo-like/team-kit" ~/src/team-kit && cd ~/src/team-kit && git init -q -b main && git add -A && git commit -qm "team kit 1.0.0" && git tag v1.0.0',
      },
    ],
    commands: [
      ['init', '--target', 'claude,codex'],
      ['install', 'origin', 'file://~/src/team-kit', '--alias', 'team', '--project'],
      ['install', 'skill', 'ci-watch@team'],
      ['install', 'agent', 'ci-watcher@team'],
      { sh: 'cat palm.yaml' },
    ],
  },
  {
    name: 'b-team-clone',
    setup: [
      {
        sh: 'cp -R "$FIXTURES/cursor-monorepo-like/team-kit" ~/src/team-kit && cd ~/src/team-kit && git init -q -b main && git add -A && git commit -qm "team kit 1.0.0" && git tag v1.0.0',
      },
      ['init', '--target', 'claude,codex'],
      ['install', 'origin', 'file://~/src/team-kit', '--alias', 'team', '--project'],
      ['install', 'skill', 'ci-watch@team'],
      ['install', 'agent', 'ci-watcher@team'],
      {
        sh: 'git add palm.yaml palm.lock.yaml && git commit -qm "Add the palm baseline" && git clean -fdxq && rm -rf ~/.palm',
      },
      {
        sh: "cd ~/src/team-kit && printf '\\nAlso report flaky tests.\\n' >> skills/ci-watch/SKILL.md && git commit -qam 'team kit 1.1.0' && git tag v1.1.0",
      },
    ],
    commands: [['install'], ['get'], ['outdated']],
  },
  {
    name: 'b-team-update',
    setup: [
      {
        sh: 'cp -R "$FIXTURES/cursor-monorepo-like/team-kit" ~/src/team-kit && cd ~/src/team-kit && git init -q -b main && git add -A && git commit -qm "team kit 1.0.0" && git tag v1.0.0',
      },
      ['init', '--target', 'claude,codex'],
      ['install', 'origin', 'file://~/src/team-kit', '--alias', 'team', '--project'],
      ['install', 'skill', 'ci-watch@team'],
      ['install', 'agent', 'ci-watcher@team'],
      {
        sh: "cd ~/src/team-kit && printf '\\nAlso report flaky tests.\\n' >> skills/ci-watch/SKILL.md && git commit -qam 'team kit 1.1.0' && git tag v1.1.0",
      },
    ],
    commands: [['update', '--dry-run'], ['update', '--yes'], ['get']],
  },
  {
    name: 'b-publish-teammate',
    setup: [
      {
        sh: `mkdir -p ~/src/mine/skills/release-notes && cd ~/src/mine && cat > skills/release-notes/SKILL.md <<'SKILL'
---
name: release-notes
description: Use when the user asks for release notes. Reads merged pull requests and writes a changelog entry.
---

# Release Notes

## When to use

Describe the situations and requests this skill is for, and when not to use it.

## Steps

1. First step.
2. Second step.

## Notes

- Gotchas, constraints, and pointers to files in references/ or scripts/.
SKILL
git init -q -b main && git add -A && git commit -qm "release-notes skill" && git tag v1.0.0`,
      },
    ],
    commands: [
      ['install', 'origin', 'file://~/src/mine', '--alias', 'ana'],
      ['install', 'skill', 'release-notes@ana', '--target', 'claude,codex'],
      ['get', 'skills'],
    ],
  },
  {
    name: 'b-mcp-http',
    setup: [['init', '--target', 'claude,codex,copilot,cursor,gemini,opencode']],
    commands: [
      [
        'install',
        'mcp',
        'docs',
        '--url',
        'https://docs.example.com/mcp',
        '--header',
        `Authorization=Bearer \${DOCS_TOKEN}`,
      ],
      {
        sh: 'grep -n DOCS_TOKEN .mcp.json .codex/config.toml .vscode/mcp.json .cursor/mcp.json .gemini/settings.json opencode.json palm.yaml',
      },
    ],
  },
  {
    name: 'b-mcp-args',
    setup: [['init', '--target', 'claude,codex']],
    commands: [
      [
        'install',
        'mcp',
        'db',
        '--yes',
        '--',
        'npx',
        '-y',
        '@acme/db-mcp',
        '--token',
        `\${DB_TOKEN}`,
      ],
      { sh: 'cat .codex/config.toml' },
    ],
  },
  {
    name: 'b-apm',
    setup: [
      { sh: 'cp -R "$FIXTURES/apm-like" ~/src/standards' },
      ['init', '--target', 'claude,copilot'],
    ],
    commands: [
      ['install', 'origin', '~/src/standards'],
      ['install', 'plugin', 'my-apm-pkg', '--yes'],
    ],
    files: true,
  },
  {
    name: 'b-adopt',
    origins: [
      { fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' },
      { fixture: 'cursor-monorepo-like/pstack', dir: 'pstack', alias: 'pstack' },
    ],
    setup: [
      {
        sh: 'mkdir -p .claude/agents .cursor/agents .claude/skills/tdd && cp ~/src/pstack/agents/comment-sicko.md .claude/agents/ && cp ~/src/pstack/agents/comment-sicko.md .cursor/agents/ && cp ~/src/skills/skills/engineering/tdd/SKILL.md .claude/skills/tdd/',
      },
    ],
    commands: [
      { sh: 'find .claude .cursor -type f | sort' },
      { palm: ['install', 'agent', 'comment-sicko'], exit: 1 },
      ['install', 'agent', 'comment-sicko', '--force'],
      ['install', 'skill', 'tdd@mattpocock'],
      ['find', '.claude/agents/comment-sicko.md'],
    ],
  },
  {
    name: 'b-agent-bundle',
    origins: [
      {
        fixture: 'claude-plugins-official-like',
        dir: 'claude-plugins-official',
        alias: 'official',
      },
    ],
    setup: [
      {
        sh: `mkdir -p ~/.palm/mine/agents && cat > ~/.palm/mine/agents/sdk-reviewer.md <<'AGENT'
---
name: sdk-reviewer
description: Use after changes to an Agent SDK app. Reviews the code and runs the tests.
model: sonnet
tools: Read, Grep
skills:
  - sdk-helper
mcpServers:
  - context7
---

You review Agent SDK apps. Run the tests, then report failures first.
AGENT`,
      },
      ['install', 'origin', '~/.palm/mine', '--alias', 'mine'],
      ['init', '--target', 'claude,copilot'],
    ],
    commands: [
      ['install', 'agent', 'sdk-reviewer@mine'],
      ['why', 'mcp', 'context7'],
      ['install', 'skill', 'sdk-helper'],
      ['uninstall', 'agent', 'sdk-reviewer'],
      ['get'],
    ],
  },
  {
    name: 'b-marketplace',
    setup: [
      {
        sh: `mkdir -p ~/src/catalog/.claude-plugin ~/src/catalog/plugins && cp -R "$FIXTURES/superpowers-like" ~/src/catalog/plugins/superpowers && cp -R "$FIXTURES/caveman-like" ~/src/catalog/plugins/caveman && cat > ~/src/catalog/.claude-plugin/marketplace.json <<'JSON'
{
  "name": "team-catalog",
  "owner": { "name": "Platform team" },
  "plugins": [
    { "name": "superpowers", "source": "./plugins/superpowers", "description": "Core skills library" },
    { "name": "caveman", "source": "./plugins/caveman", "description": "Talk like caveman." }
  ]
}
JSON`,
      },
    ],
    commands: [
      ['install', 'origin', '~/src/catalog/.claude-plugin/marketplace.json'],
      ['get', 'plugins', '--available'],
    ],
  },
  {
    name: 'b-plugin-consent',
    origins: [{ fixture: 'superpowers-like', dir: 'superpowers', alias: 'superpowers' }],
    setup: [['init', '--target', 'claude,codex']],
    commands: [
      { palm: ['install', 'plugin', 'superpowers'], exit: 1 },
      ['install', 'plugin', 'superpowers', '--yes'],
    ],
    files: true,
  },
  {
    name: 'b-plugin-remote',
    setup: [{ sh: 'cp -R "$FIXTURES/claude-plugins-official-like" ~/src/claude-plugins-official' }],
    commands: [['install', 'origin', '~/src/claude-plugins-official', '--alias', 'official']],
  },
  {
    name: 'b-ci-errors',
    origins: [
      { fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' },
      { fixture: 'cursor-monorepo-like/pstack', dir: 'pstack', alias: 'pstack' },
      { fixture: 'superpowers-like', dir: 'superpowers', alias: 'superpowers' },
    ],
    setup: [['init', '--target', 'claude']],
    commands: [
      { palm: ['install', 'skill', 'tdd'], exit: 1 },
      { palm: ['install', 'plugin', 'superpowers'], exit: 1 },
      { palm: ['install', 'skill', 'tdd', '--json'], exit: 1 },
    ],
  },
  {
    name: 'b-ci-frozen',
    origins: [{ fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' }],
    setup: [
      ['init', '--target', 'claude,codex'],
      ['install', 'skill', 'tdd@mattpocock'],
      { sh: 'rm -rf .claude .agents' },
    ],
    commands: [
      ['install', '--frozen', '--yes'],
      { sh: "printf 'local edit\\n' >> .claude/skills/tdd/SKILL.md" },
      { palm: ['install', '--frozen', '--yes'], exit: 1 },
      ['audit'],
    ],
  },
  {
    name: 'b-author',
    setup: [
      { sh: 'cp -R "$FIXTURES/cursor-monorepo-like/pstack" ~/src/pstack' },
      { sh: 'cp -R "$FIXTURES/hidden-unicode-like" ~/src/unicode-demo' },
    ],
    commands: [
      ['install', 'origin', '~/src/pstack'],
      ['get', '--available', '-o', 'pstack'],
      ['install', 'origin', '~/src/unicode-demo'],
    ],
  },
  {
    name: 'b-six-check',
    origins: [
      {
        fixture: 'claude-plugins-official-like',
        dir: 'claude-plugins-official',
        alias: 'official',
      },
    ],
    setup: [
      [
        'install',
        'agent',
        'agent-sdk-verifier-py',
        '--target',
        'claude,codex,copilot,cursor,gemini,opencode',
      ],
    ],
    commands: [['describe', 'agent', 'agent-sdk-verifier-py']],
  },
  {
    name: 'b-adopt-result',
    origins: [
      { fixture: 'mattpocock-like', dir: 'skills', alias: 'mattpocock' },
      { fixture: 'cursor-monorepo-like/pstack', dir: 'pstack', alias: 'pstack' },
    ],
    setup: [
      {
        sh: 'mkdir -p .claude/agents .cursor/agents .claude/skills/tdd && cp ~/src/pstack/agents/comment-sicko.md .claude/agents/ && cp ~/src/pstack/agents/comment-sicko.md .cursor/agents/ && cp ~/src/skills/skills/engineering/tdd/SKILL.md .claude/skills/tdd/',
      },
      ['install', 'agent', 'comment-sicko', '--force'],
      ['install', 'skill', 'tdd@mattpocock'],
    ],
    commands: [['find', '.cursor/agents/comment-sicko.md'], ['get']],
  },
  {
    name: 'b-agent-bundle-install',
    origins: [
      {
        fixture: 'claude-plugins-official-like',
        dir: 'claude-plugins-official',
        alias: 'official',
      },
    ],
    setup: [
      {
        sh: `mkdir -p ~/.palm/mine/agents && cat > ~/.palm/mine/agents/sdk-reviewer.md <<'AGENT'
---
name: sdk-reviewer
description: Use after changes to an Agent SDK app. Reviews the code and runs the tests.
model: sonnet
tools: Read, Grep
skills:
  - sdk-helper
mcpServers:
  - context7
---

You review Agent SDK apps. Run the tests, then report failures first.
AGENT`,
      },
      ['install', 'origin', '~/.palm/mine', '--alias', 'mine'],
      ['init', '--target', 'claude,copilot'],
    ],
    commands: [['install', 'agent', 'sdk-reviewer@mine']],
    files: true,
  },
  {
    name: 'b-author-clean',
    setup: [{ sh: 'cp -R "$FIXTURES/superpowers-like" ~/src/superpowers' }],
    commands: [
      ['install', 'origin', '~/src/superpowers'],
      ['get', '--available', '-o', 'superpowers'],
    ],
  },
  // End of section B.
];
