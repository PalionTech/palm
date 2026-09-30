/**
 * Help text shown after the generated help of each command: the forms a verb takes and real
 * examples. Plain strings only (loaded by `palm --help`). No exit codes here; the docs list them.
 */
import type { Verb } from './grammar.js';

export const ROOT_DESCRIPTION =
  'palm installs agent configuration from git repositories into Claude Code, Codex, GitHub Copilot, Cursor, Gemini CLI and OpenCode.';

export const ROOT_HELP = `
Kinds: skill (sk), agent (ag), instruction (ins), hook (hk), mcp, plugin (pl),
       source (src), target (tg), all. Plurals work too: palm get skills.

Examples:
  palm install obra/superpowers               list what a source offers
  palm install mattpocock/skills tdd          install one skill and record it in palm.yaml
  palm install                                make the disk match palm.yaml (a clone, CI)
  palm check                                  fail when the files drift from the lock`;

export const VERB_HELP: Readonly<Record<Verb, string>> = {
  init: `
Refuses inside a directory that has a palm.yaml above it in the same repository, unless --here.

Examples:
  palm init                                   targets found here (.claude/, .cursor/, ...)
  palm init --target claude,cursor            these targets
  palm init --here                            a separate project inside a larger one`,

  install: `
Forms:
  palm install <source>                       list what the source offers; saves nothing
  palm install <source> [kind:]name...        install those and record them in palm.yaml
  palm install <source> --all                 everything the source offers
  palm install                                make the disk match palm.yaml and the lock
  palm install mcp <name> --url <url> [--header K=V]...
  palm install mcp <name> --command <cmd> [--arg a]... [--env K=V]...
  palm install mcp --snippet <file or ->      the mcpServers block from a README

A source is owner/repo, owner/repo/sub/dir, a git URL (#ref pins it), a directory in this
project, or the name or alias of a source in palm.yaml.

Examples:
  palm install obra/superpowers
  palm install mattpocock/skills tdd handoff
  palm install obra/superpowers --all -g
  palm install mcp docs --url https://example.com/mcp --header 'Authorization=Bearer \${DOCS_TOKEN}'
  pbpaste | palm install mcp --snippet -`,

  remove: `
A file you changed since palm wrote it keeps the entity installed (exit 1); --force removes it.
Removing something that is not installed is not an error.

Examples:
  palm remove tdd
  palm remove mattpocock/skills tdd handoff
  palm remove obra/superpowers brainstorming --exclude
  palm rm mcp:docs -g`,

  update: `
Prints the plan, every new or changed program, and the files you changed, then asks
(default no). Without a terminal it needs --yes; --yes never consents to programs.

Examples:
  palm update
  palm update mattpocock/skills
  palm update acme-kit --to ^2
  palm update --dry-run --strict              exit 1 when a source is behind its ref`,

  check: `
Prints every check it ran, then one line per problem with the command that fixes it.
Exit 1 when a check fails; warnings alone exit 0.

Examples:
  palm check
  palm check --json
  palm check -g`,

  get: `
Kinds: skill (sk), agent (ag), instruction (ins), hook (hk), mcp, plugin (pl); also
source (src), target (tg) and all. Plurals work too.

Examples:
  palm get
  palm get skills
  palm get --source mattpocock/skills --files
  palm get sources
  palm get targets -g`,

  describe: `
Examples:
  palm describe tdd
  palm describe mcp:docs
  palm describe .claude/skills/tdd/SKILL.md   the entity that wrote a file
  palm describe source mattpocock/skills
  palm describe target cursor`,

  create: `
Kinds: skill, agent, instruction, hook. The template goes into ./agent-kit (~/.palm/kit
under -g), which is declared in palm.yaml on first use, and is installed at once.

Examples:
  palm create skill release-notes
  palm create agent reviewer --description "Reviews diffs before a merge"
  palm create hook session-log --in tools/agent-kit
  palm create instruction db-conventions -g`,
};

export const MIGRATE_HELP = `
Reads the palm 0.1 palm.yaml, palm.lock.yaml and ~/.palm/config.yaml and writes the new
format. --dry-run prints the new palm.yaml and writes nothing.

Examples:
  palm migrate --dry-run
  palm migrate
  palm migrate -g`;

export const COMPLETION_HELP = `
Install:
  bash   echo 'source <(palm completion bash)' >> ~/.bashrc
  zsh    echo 'source <(palm completion zsh)' >> ~/.zshrc     (after compinit)
  fish   palm completion fish > ~/.config/fish/completions/palm.fish`;

export const CACHE_HELP = `
Sources stay declared; the next command that needs one fetches it again.

Examples:
  palm cache clean
  palm cache clean --yes`;
