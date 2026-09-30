// Terminal sessions recorded by scripts/capture.mjs for the docs.
//
// REGENERATE BEFORE RELEASE. The palm 0.2 docs were rewritten before the 0.2 CLI existed, so every
// src/captures/*.txt was written by hand from the contract (DESIGN.md, PLAN.md section 4.9). Build
// the CLI and run `npm run capture` to replace them with real output, then delete this note.
// `npm run capture:check` fails until then.
//
// A spec runs in a fresh sandbox home (printed as ~) with an empty git project at ~/project:
//   name       output file: src/captures/<name>.txt (and <name>.files.txt with `files: true`)
//   sources    git repositories served as https://github.com/<repo> (see capture.mjs):
//              { fixture: '<dir in test/fixtures>', repo: 'owner/repo', tags: ['v1.2.3'] }, or
//              { repo, tags, sh: '<bash that writes the files, run in the empty repository>' }
//   setup      steps run before the shown commands (not shown)
//   commands   steps run in ~/project and shown with their real output. A step is a palm argument
//              list (an argument starting with ~/ or file://~/ is expanded as a shell would),
//              { palm: [...], exit: n } for a command expected to exit n, or { sh: '<bash>' } for
//              a shell command. In shell steps `palm` is on PATH, $FIXTURES is test/fixtures and
//              $SRC is ~/src; git commits get a fixed identity and date, so shas repeat. Every
//              step must exit 0 unless it names `exit`. `{{allow-exec}}` in a step is replaced by
//              the --allow-exec value an earlier step printed.
//   files      also record which files under ~/project the shown commands created or changed
//
// Pages include a capture with <Capture name="..." /> and its files with <CaptureTree name="..." />.
// Names: `landing`, a- for getting started, concepts and explanation, b- for guides, c- for reference.

const ALL_TARGETS = 'claude,codex,copilot,cursor,gemini,opencode';

const MATT = { fixture: 'mattpocock-like', repo: 'mattpocock/skills', tags: ['v1.2.0', 'v1.2.3'] };
const SUPERPOWERS = { fixture: 'superpowers-like', repo: 'obra/superpowers', tags: ['v4.0.3'] };
const OFFICIAL = {
  fixture: 'claude-plugins-official-like',
  repo: 'anthropics/claude-plugins-official',
};
const TEAM_KIT = {
  fixture: 'cursor-monorepo-like/team-kit',
  repo: 'acme/agent-kit',
  tags: ['v1.0.0'],
};
const CURSOR_PLUGINS = { fixture: 'cursor-monorepo-like', repo: 'cursor/plugins' };
const APM = { fixture: 'apm-like', repo: 'acme/standards', tags: ['v1.0.0'] };
const UNICODE = { fixture: 'hidden-unicode-like', repo: 'acme/unicode-demo', tags: ['v1.0.0'] };

// A plugin with two hook scripts, shaped like trailofbits/skills' gh-cli plugin (DESIGN.md section 7).
const GH_CLI = {
  repo: 'trailofbits/skills',
  tags: ['v2.1.0'],
  sh: `mkdir -p .claude-plugin plugins/gh-cli/.claude-plugin plugins/gh-cli/hooks
cat > .claude-plugin/marketplace.json <<'JSON'
{ "name": "trailofbits", "owner": { "name": "Trail of Bits" },
  "plugins": [{ "name": "gh-cli", "source": "./plugins/gh-cli", "description": "Route GitHub calls through gh" }] }
JSON
cat > plugins/gh-cli/.claude-plugin/plugin.json <<'JSON'
{ "name": "gh-cli", "version": "2.1.0", "description": "Route GitHub calls through gh" }
JSON
cat > plugins/gh-cli/hooks/hooks.json <<'JSON'
{ "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "bash $CLAUDE_PLUGIN_ROOT/hooks/persist-session-id.sh" }] }],
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash $CLAUDE_PLUGIN_ROOT/hooks/intercept-github-curl.sh" }] }] } }
JSON
printf '#!/bin/sh\\necho "$CLAUDE_SESSION_ID" > .gh-session\\n' > plugins/gh-cli/hooks/persist-session-id.sh
printf '#!/bin/sh\\ngrep -q "curl https://api.github.com" && echo "use gh api instead" >&2 && exit 2\\nexit 0\\n' > plugins/gh-cli/hooks/intercept-github-curl.sh
chmod 755 plugins/gh-cli/hooks/*.sh`,
};

// palm 0.1 files for the migration captures: an old palm.yaml, a version 2 lockfile, the old
// ~/.palm/config.yaml and the generated skill files, for mattpocock/skills at v1.2.3.
const PALM_01_PROJECT = `sha=$(git -C "$SRC/mattpocock/skills" rev-parse HEAD)
mkdir -p ~/.palm .claude/skills .agents/skills
cat > ~/.palm/config.yaml <<'YAML'
origins:
  - alias: mattpocock
    type: git
    url: https://github.com/mattpocock/skills.git
YAML
cat > palm.yaml <<'YAML'
targets: [claude, codex]
skills:
  - tdd@mattpocock
  - handoff@mattpocock
  - grill-me@mattpocock#v1.2.0
YAML
{
  echo "version: 2"
  echo "entries:"
  for s in engineering/tdd productivity/handoff engineering/grill-me; do
    n=\${s#*/}
    cp -R "$SRC/mattpocock/skills/skills/$s" .claude/skills/
    cp -R "$SRC/mattpocock/skills/skills/$s" .agents/skills/
    ref=v1.2.3; [ "$n" = grill-me ] && ref=v1.2.0
    echo "  - { kind: skill, name: $n, origin: mattpocock, ref: $ref, sha: $sha, path: skills/$s, targets: [claude, codex] }"
  done
} > palm.lock.yaml
printf 'node_modules/\\n.palm/\\n' > .gitignore
git add -A && git commit -qm "palm 0.1 setup"`;

export const specs = [
  // Landing page and "What is palm".
  {
    name: 'landing',
    sources: [MATT, OFFICIAL],
    commands: [
      ['init', '--target', ALL_TARGETS],
      ['install', 'anthropics/claude-plugins-official', 'agent-sdk-verifier-py'],
      ['install', 'mattpocock/skills', 'tdd'],
    ],
    files: true,
  },

  // Section A: getting started, concepts and explanation pages.
  {
    // PLAN.md section 4.9, Nora: Claude Code only, an empty project with .claude/.
    name: 'a-onboarding-nora',
    sources: [SUPERPOWERS],
    setup: [{ sh: 'mkdir .claude' }],
    commands: [
      { palm: ['install', 'superpowers'], exit: 2 },
      ['install', 'obra/superpowers'],
      ['install', 'obra/superpowers', '--all'],
    ],
  },
  {
    // PLAN.md section 4.9, Lena: Cursor only, typed a skill name first.
    name: 'a-onboarding-lena',
    sources: [MATT],
    setup: [{ sh: 'mkdir .cursor' }],
    commands: [{ palm: ['install', 'tdd'], exit: 2 }, ['install', 'mattpocock/skills', 'tdd']],
  },
  {
    name: 'a-quick-start',
    sources: [MATT],
    commands: [
      ['init', '--target', 'claude,codex'],
      ['install', 'mattpocock/skills'],
      ['install', 'mattpocock/skills', 'grill-me'],
    ],
    files: true,
  },
  {
    name: 'a-quick-start-remove',
    sources: [MATT],
    setup: [
      ['init', '--target', 'claude,codex'],
      ['install', 'mattpocock/skills', 'grill-me'],
    ],
    commands: [['check'], ['remove', 'grill-me'], ['get']],
    files: true,
  },
  {
    name: 'a-sources',
    sources: [MATT],
    setup: [['init', '--target', 'claude']],
    commands: [
      ['install', 'mattpocock/skills', 'tdd'],
      ['get', 'sources'],
      { sh: 'cat palm.yaml' },
    ],
  },
  {
    name: 'a-entities',
    sources: [OFFICIAL],
    commands: [['install', 'anthropics/claude-plugins-official']],
  },
  {
    name: 'a-targets',
    setup: [{ sh: 'mkdir .claude .cursor' }],
    commands: [
      ['get', 'targets'],
      ['describe', 'target', 'cursor'],
    ],
  },
  {
    name: 'a-scopes',
    sources: [MATT],
    setup: [['init', '--target', 'claude'], { sh: 'mkdir ~/.claude' }],
    commands: [
      ['install', 'mattpocock/skills', 'tdd'],
      ['install', 'mattpocock/skills', 'handoff', '-g'],
      ['get', '-g'],
    ],
  },
  {
    name: 'a-lock',
    sources: [MATT],
    setup: [
      ['init', '--target', 'claude,codex'],
      ['install', 'mattpocock/skills', 'tdd'],
      { sh: 'git add -A && git commit -qm "Add palm setup"' },
    ],
    commands: [{ sh: 'cat palm.lock.yaml' }, ['install'], ['check']],
  },
  {
    name: 'a-consent',
    sources: [GH_CLI],
    setup: [['init', '--target', 'claude,cursor']],
    commands: [
      { palm: ['install', 'trailofbits/skills', 'plugin:gh-cli'], exit: 1 },
      ['install', 'trailofbits/skills', 'plugin:gh-cli', '--allow-exec', '{{allow-exec}}'],
      { sh: "grep -n -A 8 'exec:' palm.lock.yaml" },
    ],
  },
  {
    name: 'a-consent-dry-run',
    sources: [GH_CLI],
    setup: [['init', '--target', 'claude,cursor']],
    commands: [['install', 'trailofbits/skills', 'plugin:gh-cli', '--dry-run']],
  },
  {
    name: 'a-secrets',
    setup: [['init', '--target', 'claude,cursor']],
    commands: [
      {
        sh: `palm install mcp --snippet - <<'JSON'
{ "mcpServers": { "inbound": {
    "url": "https://mcp.inbound.example/v1",
    "headers": { "x-inbound-api-key": "inbound-live-Zx8kQ2mN7pL4vR9tW3yB6cF1" } } } }
JSON`,
      },
      { sh: 'grep -n INBOUND .mcp.json .cursor/mcp.json palm.yaml' },
    ],
  },
  {
    name: 'a-scan',
    sources: [OFFICIAL],
    setup: [
      ['init', '--target', 'claude'],
      ['install', 'anthropics/claude-plugins-official', 'sdk-helper'],
    ],
    commands: [['describe', 'source', 'anthropics/claude-plugins-official']],
  },
  {
    name: 'a-hidden-unicode',
    sources: [UNICODE],
    setup: [['init', '--target', 'claude']],
    commands: [{ palm: ['install', 'acme/unicode-demo', 'bidi-override'], exit: 1 }],
  },

  // Section B: guides.
  {
    name: 'b-new-project',
    sources: [MATT, OFFICIAL],
    setup: [{ sh: "printf 'node_modules/\\n' > .gitignore" }],
    commands: [
      ['init', '--target', 'claude,codex'],
      ['install', 'mattpocock/skills', 'tdd', 'grill-me'],
      ['install', 'anthropics/claude-plugins-official', 'agent-sdk-verifier-py'],
      [
        'install',
        'mcp',
        'docs',
        '--url',
        'https://docs.example.com/mcp',
        '--header',
        'Authorization=Bearer ${DOCS_TOKEN}',
      ],
    ],
    files: true,
  },
  {
    name: 'b-new-project-result',
    sources: [MATT, OFFICIAL],
    setup: [
      { sh: "printf 'node_modules/\\n' > .gitignore" },
      ['init', '--target', 'claude,codex'],
      ['install', 'mattpocock/skills', 'tdd', 'grill-me'],
      ['install', 'anthropics/claude-plugins-official', 'agent-sdk-verifier-py'],
      [
        'install',
        'mcp',
        'docs',
        '--url',
        'https://docs.example.com/mcp',
        '--header',
        'Authorization=Bearer ${DOCS_TOKEN}',
      ],
    ],
    commands: [{ sh: 'cat palm.yaml' }, ['check']],
  },
  {
    name: 'b-team-setup',
    sources: [TEAM_KIT],
    setup: [['init', '--target', 'claude,codex']],
    commands: [
      ['install', 'acme/agent-kit', 'ci-watch', 'ci-watcher', 'typescript'],
      {
        sh: 'git add -A && git commit -qm "Add the team agent setup" && git show --stat --format=%s HEAD',
      },
    ],
  },
  {
    name: 'b-team-clone',
    sources: [TEAM_KIT],
    setup: [
      ['init', '--target', 'claude,codex'],
      ['install', 'acme/agent-kit', 'ci-watch', 'ci-watcher', 'typescript'],
      { sh: 'git add -A && git commit -qm "Add the team agent setup"' },
      { sh: 'git clone -q . ~/teammate && rm -rf ~/.palm' },
    ],
    commands: [
      { sh: 'cd ~/teammate && ls -a .claude .agents' },
      { sh: 'cd ~/teammate && palm check' },
      { sh: 'cd ~/teammate && palm install' },
    ],
  },
  {
    name: 'b-team-update',
    sources: [TEAM_KIT],
    setup: [
      ['init', '--target', 'claude,codex'],
      ['install', 'acme/agent-kit', 'ci-watch', 'ci-watcher', 'typescript'],
      { sh: 'git add -A && git commit -qm "Add the team agent setup"' },
      {
        sh: "cd $SRC/acme/agent-kit && printf '\\nAlso report flaky tests.\\n' >> skills/ci-watch/SKILL.md && git commit -qam 'team kit 1.1.0' && git tag v1.1.0",
      },
    ],
    commands: [['update', '--dry-run'], ['update', '--yes'], { sh: 'git status --short' }],
  },
  {
    name: 'b-team-remove',
    sources: [TEAM_KIT],
    setup: [
      ['init', '--target', 'claude,codex'],
      ['install', 'acme/agent-kit', 'ci-watch', 'ci-watcher', 'typescript'],
      { sh: 'git add -A && git commit -qm "Add the team agent setup"' },
    ],
    commands: [['remove', 'ci-watcher'], { sh: 'git status --short' }],
  },
  {
    name: 'b-ci-check',
    sources: [MATT],
    setup: [
      ['init', '--target', 'claude,codex'],
      ['install', 'mattpocock/skills', 'tdd'],
      { sh: 'git add -A && git commit -qm "Add palm setup"' },
    ],
    commands: [
      ['check'],
      { sh: "printf 'Skip the tests when in a hurry.\\n' >> .claude/skills/tdd/SKILL.md" },
      { palm: ['check'], exit: 1 },
    ],
  },
  {
    name: 'b-ci-errors',
    sources: [GH_CLI, MATT],
    setup: [
      ['init', '--target', 'claude'],
      {
        sh: "printf 'sources:\\n  trailofbits/skills:\\n    ref: ^2.1\\n    plugins: [gh-cli]\\n' >> palm.yaml",
      },
    ],
    commands: [
      { palm: ['install'], exit: 1 },
      { palm: ['install', 'mattpocock/skills', 'tdd-coach', '--json'], exit: 1 },
    ],
  },
  {
    name: 'b-migrate',
    sources: [MATT],
    setup: [{ sh: PALM_01_PROJECT }],
    commands: [
      { palm: ['install'], exit: 2 },
      ['migrate', '--dry-run'],
      ['migrate'],
      { sh: 'git status --short' },
    ],
  },
  {
    name: 'b-apm',
    sources: [APM],
    setup: [['init', '--target', 'claude,copilot']],
    commands: [
      ['install', 'acme/standards'],
      ['install', 'acme/standards', '--all'],
      { palm: ['install', 'acme/standards', 'format-on-save'], exit: 1 },
      ['install', 'acme/standards', 'format-on-save', '--allow-exec', '{{allow-exec}}'],
    ],
    files: true,
  },
  {
    name: 'b-mcp-snippet',
    setup: [['init', '--target', ALL_TARGETS]],
    commands: [
      {
        sh: `palm install mcp --snippet - <<'JSON'
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer \${GITHUB_PAT}" }
    }
  }
}
JSON`,
      },
      ['get', 'mcp'],
    ],
  },
  {
    name: 'b-mcp-flags',
    setup: [['init', '--target', 'claude,codex,cursor']],
    commands: [
      [
        'install',
        'mcp',
        'docs',
        '--url',
        'https://docs.example.com/mcp',
        '--header',
        'Authorization=Bearer ${DOCS_TOKEN}',
      ],
      {
        palm: [
          'install',
          'mcp',
          'xcodebuild',
          '--command',
          'npx',
          '--arg',
          '-y',
          '--arg',
          'xcodebuildmcp@latest',
        ],
        exit: 1,
      },
      [
        'install',
        'mcp',
        'xcodebuild',
        '--command',
        'npx',
        '--arg',
        '-y',
        '--arg',
        'xcodebuildmcp@latest',
        '--allow-exec',
        '{{allow-exec}}',
      ],
    ],
  },
  {
    name: 'b-mcp-describe',
    setup: [
      ['init', '--target', 'claude,codex,cursor'],
      [
        'install',
        'mcp',
        'docs',
        '--url',
        'https://docs.example.com/mcp',
        '--header',
        'Authorization=Bearer ${DOCS_TOKEN}',
      ],
    ],
    commands: [['describe', 'mcp', 'docs']],
  },
  {
    name: 'b-adopt',
    sources: [MATT, CURSOR_PLUGINS],
    setup: [
      {
        sh: 'mkdir -p .claude/skills .cursor/agents && cp -R $SRC/mattpocock/skills/skills/engineering/tdd .claude/skills/ && cp $SRC/cursor/plugins/pstack/agents/comment-sicko.md .cursor/agents/ && printf "\\nAlways cite the line.\\n" >> .cursor/agents/comment-sicko.md && git add -A && git commit -qm "hand-copied agent files"',
      },
      ['init', '--target', 'claude,cursor'],
    ],
    commands: [
      ['install', 'mattpocock/skills', 'tdd'],
      { palm: ['install', 'cursor/plugins/pstack', 'comment-sicko'], exit: 1 },
      ['install', 'cursor/plugins/pstack', 'comment-sicko', '--force'],
      { sh: 'git status --short' },
    ],
  },
  {
    name: 'b-plugin',
    sources: [SUPERPOWERS],
    setup: [['init', '--target', 'claude,codex']],
    commands: [
      { palm: ['install', 'obra/superpowers', 'plugin:superpowers'], exit: 1 },
      ['install', 'obra/superpowers', 'plugin:superpowers', '--allow-exec', '{{allow-exec}}'],
      { palm: ['remove', 'brainstorming'], exit: 1 },
      ['remove', 'obra/superpowers', 'brainstorming', '--exclude'],
      { sh: 'cat palm.yaml' },
    ],
    files: true,
  },
  {
    name: 'b-create',
    setup: [['init', '--target', 'claude,codex']],
    commands: [
      [
        'create',
        'skill',
        'release-notes',
        '--description',
        'Write release notes from the pull requests merged since the last tag.',
      ],
      { sh: 'cat agent-kit/skills/release-notes/SKILL.md' },
      {
        sh: "printf '\\n4. Group the entries by label.\\n' >> agent-kit/skills/release-notes/SKILL.md",
      },
      { palm: ['check'], exit: 1 },
      ['install'],
    ],
    files: true,
  },
  {
    name: 'b-publish-teammate',
    sources: [
      {
        repo: 'acme/agent-kit',
        tags: ['v1.0.0'],
        sh: `mkdir -p skills/release-notes && cat > skills/release-notes/SKILL.md <<'SKILL'
---
name: release-notes
description: Write release notes from the pull requests merged since the last tag.
---

# release-notes

1. List the pull requests merged since the last tag.
2. Write one line per user-visible change.
3. Group the lines under Added, Changed and Fixed.
SKILL`,
      },
    ],
    setup: [['init', '--target', 'claude,codex']],
    commands: [['install', 'acme/agent-kit', 'release-notes'], ['get']],
  },
  {
    name: 'b-six-install',
    sources: [OFFICIAL],
    setup: [['init', '--target', ALL_TARGETS]],
    commands: [
      ['install', 'anthropics/claude-plugins-official', 'agent-sdk-verifier-py', 'sdk-helper'],
    ],
    files: true,
  },
  {
    name: 'b-six-files',
    sources: [OFFICIAL],
    setup: [
      ['init', '--target', ALL_TARGETS],
      ['install', 'anthropics/claude-plugins-official', 'agent-sdk-verifier-py'],
    ],
    commands: [
      { sh: 'cat .claude/agents/agent-sdk-verifier-py.md' },
      { sh: 'cat .codex/agents/agent-sdk-verifier-py.toml' },
      { sh: 'cat .github/agents/agent-sdk-verifier-py.agent.md' },
    ],
  },
  {
    name: 'b-six-skips',
    sources: [OFFICIAL],
    setup: [['init', '--target', ALL_TARGETS]],
    commands: [
      ['install', 'anthropics/claude-plugins-official', 'new-sdk-app'],
      ['install', 'anthropics/claude-plugins-official', 'hook:agent-sdk-dev', '--dry-run'],
    ],
  },

  // Section C: reference pages. (c-help-* and c-cli-options.json are written by
  // scripts/cli-reference.mjs, not by these specs.)
  {
    name: 'c-init',
    setup: [{ sh: "printf 'node_modules/\\n' > .gitignore && mkdir .claude .cursor" }],
    commands: [['init'], { sh: 'cat palm.yaml .gitignore' }],
  },
  {
    name: 'c-init-nested',
    setup: [['init', '--target', 'claude'], { sh: 'mkdir -p packages/jobs' }],
    commands: [
      { sh: 'cd packages/jobs && palm init', exit: 2 },
      { sh: 'cd packages/jobs && palm init --here --target claude' },
    ],
  },
  {
    name: 'c-install',
    sources: [MATT, SUPERPOWERS],
    setup: [['init', '--target', 'claude,codex']],
    commands: [
      ['install', 'mattpocock/skills', 'tdd', 'handoff'],
      ['install', 'obra/superpowers', 'plugin:superpowers', '--dry-run'],
      { sh: 'rm -r .claude/skills/handoff' },
      ['install'],
    ],
  },
  {
    name: 'c-remove',
    sources: [MATT],
    setup: [
      ['init', '--target', 'claude,codex'],
      ['install', 'mattpocock/skills', 'tdd', 'grill-me'],
      { sh: "printf 'my note\\n' >> .claude/skills/tdd/SKILL.md" },
    ],
    commands: [
      ['remove', 'grill-me'],
      ['remove', 'grill-me'],
      { palm: ['remove', 'tdd'], exit: 1 },
      ['remove', 'mattpocock/skills', 'tdd', '--force'],
    ],
  },
  {
    name: 'c-update',
    sources: [MATT],
    setup: [
      ['init', '--target', 'claude,codex'],
      ['install', 'mattpocock/skills', 'tdd', 'grill-me'],
      { sh: 'git add -A && git commit -qm "Add palm setup"' },
      {
        sh: "cd $SRC/mattpocock/skills && printf '\\nRefactor after each green test.\\n' >> skills/engineering/tdd/SKILL.md && git commit -qam v1.3.0 && git tag v1.3.0",
      },
    ],
    commands: [
      ['update', '--dry-run'],
      ['update', '--yes'],
    ],
  },
  {
    name: 'c-check',
    sources: [MATT],
    setup: [
      ['init', '--target', 'claude,codex'],
      ['install', 'mattpocock/skills', 'tdd'],
      [
        'install',
        'mcp',
        'docs',
        '--url',
        'https://docs.example.com/mcp',
        '--header',
        'Authorization=Bearer ${DOCS_TOKEN}',
      ],
      { sh: 'git add -A && git commit -qm "Add palm setup"' },
      { sh: 'rm .agents/skills/tdd/references/mocking.md' },
    ],
    commands: [{ palm: ['check'], exit: 1 }, ['install'], ['check']],
  },
  {
    name: 'c-check-json',
    sources: [MATT],
    setup: [
      ['init', '--target', 'claude,codex'],
      ['install', 'mattpocock/skills', 'tdd'],
      [
        'install',
        'mcp',
        'docs',
        '--url',
        'https://docs.example.com/mcp',
        '--header',
        'Authorization=Bearer ${DOCS_TOKEN}',
      ],
      { sh: 'git add -A && git commit -qm "Add palm setup"' },
      { sh: 'rm .agents/skills/tdd/references/mocking.md' },
    ],
    commands: [{ palm: ['check', '--json'], exit: 1 }],
  },
  {
    name: 'c-get',
    sources: [MATT, OFFICIAL],
    setup: [
      ['init', '--target', 'claude,codex'],
      ['install', 'mattpocock/skills', 'tdd'],
      ['install', 'anthropics/claude-plugins-official', 'agent-sdk-verifier-py'],
    ],
    commands: [['get'], ['get', 'sources'], ['get', 'skills', '--files']],
  },
  {
    name: 'c-describe',
    sources: [MATT, GH_CLI],
    setup: [
      ['init', '--target', 'claude,codex'],
      ['install', 'mattpocock/skills', 'tdd'],
      { palm: ['install', 'trailofbits/skills', 'plugin:gh-cli'], exit: 1 },
      ['install', 'trailofbits/skills', 'plugin:gh-cli', '--allow-exec', '{{allow-exec}}'],
    ],
    commands: [
      ['describe', 'tdd'],
      ['describe', 'hook:gh-cli'],
      ['describe', '.claude/settings.json'],
    ],
  },
  {
    name: 'c-create',
    setup: [['init', '--target', 'claude']],
    commands: [
      ['create', 'agent', 'reviewer', '--description', 'Review a diff for bugs before merge.'],
      ['create', 'instruction', 'commit-style'],
      { sh: 'find agent-kit -type f | sort' },
      { sh: 'cat palm.yaml' },
    ],
  },
  {
    name: 'c-cache',
    sources: [MATT],
    setup: [
      ['init', '--target', 'claude'],
      ['install', 'mattpocock/skills', 'tdd'],
    ],
    commands: [
      ['cache', 'clean', '--yes'],
      { palm: ['install', '--offline'], exit: 1 },
      ['install'],
    ],
  },
  {
    name: 'c-errors',
    sources: [MATT],
    setup: [['init', '--target', 'claude']],
    commands: [
      { palm: ['install', 'tdd'], exit: 2 },
      { palm: ['install', 'mattpocock/skills', 'tdd-coach'], exit: 1 },
      { palm: ['doctor'], exit: 2 },
    ],
  },
  {
    name: 'c-json',
    sources: [MATT],
    setup: [
      ['init', '--target', 'claude'],
      ['install', 'mattpocock/skills', 'tdd'],
    ],
    commands: [
      ['get', 'skills', '--json'],
      { palm: ['install', 'mattpocock/skills', 'tdd-coach', '--json'], exit: 1 },
    ],
  },
  {
    name: 'c-manifest',
    sources: [MATT, SUPERPOWERS],
    setup: [
      ['init', '--target', 'claude,cursor'],
      ['install', 'mattpocock/skills', 'tdd', 'handoff'],
      { palm: ['install', 'obra/superpowers', 'plugin:superpowers'], exit: 1 },
      ['install', 'obra/superpowers', 'plugin:superpowers', '--allow-exec', '{{allow-exec}}'],
      ['remove', 'obra/superpowers', 'brainstorming', '--exclude'],
      [
        'install',
        'mcp',
        'docs',
        '--url',
        'https://docs.example.com/mcp',
        '--header',
        'Authorization=Bearer ${DOCS_TOKEN}',
      ],
    ],
    commands: [{ sh: 'cat palm.yaml' }],
  },
  {
    name: 'c-lock',
    sources: [MATT, GH_CLI],
    setup: [
      ['init', '--target', 'claude,cursor'],
      ['install', 'mattpocock/skills', 'tdd'],
      { palm: ['install', 'trailofbits/skills', 'plugin:gh-cli'], exit: 1 },
      ['install', 'trailofbits/skills', 'plugin:gh-cli', '--allow-exec', '{{allow-exec}}'],
    ],
    commands: [{ sh: 'cat palm.lock.yaml' }],
  },
  {
    name: 'c-legacy',
    sources: [MATT],
    setup: [['init', '--target', 'claude']],
    commands: [
      ['install', 'origin', 'mattpocock/skills'],
      { palm: ['outdated'], exit: 2 },
      { palm: ['search', 'tdd'], exit: 2 },
    ],
  },
];
