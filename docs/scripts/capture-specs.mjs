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
    commands: [['update', '--dry-run'], ['update', '--yes']],
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
        palm: ['install', 'mcp', 'fs', '--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '.'],
        exit: 1,
      },
    ],
  },
];
