---
title: Targets matrix
description: Where palm writes every kind, for every target, in project and global scope, how hook scripts are relocated, and how merging works.
---

This page lists every path palm writes, by kind, target and scope.
`<n>` is the entity name. Project paths are relative to the project root. Global paths start at `~`, and the global lock writes them as tokens such as `<claude>`.

```sh
palm init --target claude,codex,copilot,cursor,gemini,opencode
palm describe target gemini
```

`palm describe target <target>` prints these paths for your machine, with every override applied.

The `gemini` (Gemini CLI) and `opencode` (OpenCode) rows follow each harness's documentation and source, checked on 2026-09-28.
Neither has run against a live CLI in palm's tests yet.

## Skills

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.claude/skills/<n>/` | `~/.claude/skills/<n>/` |
| `codex` | `.agents/skills/<n>/` | `~/.agents/skills/<n>/` |
| `copilot` | `.agents/skills/<n>/` | `~/.agents/skills/<n>/` |
| `cursor` | `.claude/skills/<n>/` when `claude` is a target, else `.agents/skills/<n>/` | `~/.agents/skills/<n>/` |
| `gemini` | `.agents/skills/<n>/` | `~/.agents/skills/<n>/` |
| `opencode` | `.agents/skills/<n>/` | `~/.agents/skills/<n>/` |

palm writes `.agents/skills` once, however many targets read it.
Claude Code does not read `.agents/skills`. Cursor reads both folders and removes duplicates by name, so `claude` plus `cursor` means one copy.
With `$GEMINI_CLI_HOME` set, global skills for Gemini CLI go to `$GEMINI_CLI_HOME/.gemini/skills/<n>/`.
With `OPENCODE_DISABLE_EXTERNAL_SKILLS` set to `1` or `true`, skills for OpenCode go to `.opencode/skills/<n>/` and `~/.config/opencode/skills/<n>/`.

palm copies a skill's whole folder, including an `AGENTS.md`, `CLAUDE.md` or `GEMINI.md` the skill keeps in it.
The copy leaves out harness folders (`.claude/`, `.cursor/`, `.codex/`, `.github/`, `.vscode/`, `.gemini/`, `.opencode/`), palm's own files, `.git`, `node_modules`, `.env*`, and tests: `tests/`, `test/`, `fixtures/`, `__tests__/` and `*.test.*` files.
Every copied file goes through the secret scan, and a finding in a file the copy leaves out never refuses the skill. A skill above 200 files or 5 MB needs `--force`, and the message gives the count.
`agents/openai.yaml` is Codex metadata, so palm copies it into `.agents/skills` only, never into `.claude/skills`.

A command found in a source installs at these paths as a skill, with `name`, `description` and the command body in `SKILL.md`.
A command without a description gets its first body line.
`$ARGUMENTS` survives. Where a harness does not expand it, or has no `/name` call for skills, a note says so.

## Agents

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.claude/agents/<n>.md` | `~/.claude/agents/<n>.md` |
| `codex` | `.codex/agents/<n>.toml` | `~/.codex/agents/<n>.toml` |
| `copilot` | `.github/agents/<n>.agent.md` | `~/.copilot/agents/<n>.agent.md` |
| `cursor` | `.cursor/agents/<n>.md` | `~/.cursor/agents/<n>.md` |
| `gemini` | `.gemini/agents/<n>.md` | `~/.gemini/agents/<n>.md` |
| `opencode` | `.opencode/agents/<n>.md` | `~/.config/opencode/agents/<n>.md` |

palm never copies a field into a harness that would misread it, and records each dropped field as a note.

- Claude Code gets a Claude Code agent unchanged. From another format, palm drops keys Claude Code does not define, such as a Cursor model id, and turns `readonly: true` into a read-only tool list.
- Gemini CLI rejects an agent file with any key outside its schema. palm writes only the keys Gemini defines, and maps Claude tool names to Gemini names, such as `Read` to `read_file` and `Bash` to `run_shell_command`.
- GitHub Copilot ignores tool names it does not know, so palm maps each tool to a Copilot name, such as `Read` to `read` and `mcp__docs__search` to `docs/search`. Copilot has no argument restrictions, so `Bash(git:*)` becomes `execute`.
- Cursor gets `readonly: true` only when the tool list has no tool that writes or runs commands.
- OpenCode passes unknown keys to the model provider, so palm writes only the keys OpenCode defines, `mode: subagent`, and a `permission` map built from the tool lists or from `readonly: true`.
- Codex agents get `name`, `description` and `developer_instructions`.

## Instructions

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.claude/rules/<n>.md` | `~/.claude/rules/<n>.md` |
| `codex` | managed block in `AGENTS.md` | managed block in `~/.codex/AGENTS.md` |
| `copilot` | `.github/instructions/<n>.instructions.md` | `~/.copilot/instructions/<n>.instructions.md` |
| `cursor` | `.cursor/rules/<n>.mdc` | skipped: Cursor has no user rules file |
| `gemini` | managed block in `GEMINI.md` | managed block in `~/.gemini/GEMINI.md` |
| `opencode` | `.opencode/instructions/<n>.md`, listed in `opencode.json` | `~/.config/opencode/instructions/<n>.md`, listed in `~/.config/opencode/opencode.json` |

palm never edits `CLAUDE.md`.
A rule written for Claude Code installs into `.claude/rules` byte for byte, frontmatter and file name case included. palm converts only for other harnesses.

Claude Code and OpenCode have no on-request or manual rules, so palm 0.2 installs such a rule always-on there, with one notice per rule.
`palm describe <name>` shows the activation the source declared.

A root `AGENTS.md` or `GEMINI.md` whose managed blocks pass 24 KiB makes `palm install`, its dry run and `palm check` warn.
Above the harness's documented cap, the install refuses without `--force`, and the hint suggests `targets:` on the entry to keep the block out of that file.

## Hooks

| Target | Project | Global |
| --- | --- | --- |
| `claude` | merged into `.claude/settings.json` | merged into `~/.claude/settings.json` |
| `codex` | merged into `.codex/hooks.json` | merged into `~/.codex/hooks.json` |
| `copilot` | `.github/hooks/<n>.json` | `~/.copilot/hooks/<n>.json` |
| `cursor` | merged into `.cursor/hooks.json` | merged into `~/.cursor/hooks.json` |
| `gemini` | merged into `.gemini/settings.json` | merged into `~/.gemini/settings.json` |
| `opencode` | skipped: OpenCode hooks are JavaScript plugins | skipped |

Each merged hook entry carries only the keys that harness documents.
GitHub Copilot matchers cannot hold arguments, so a hook whose matcher has them, such as `Bash(git commit*)`, is skipped for Copilot with a note.

Gemini CLI has its own event names and counts timeouts in milliseconds.
palm 0.3 ships a table of documented one-to-one event and matcher equivalents.
Each row names the harness version it was checked against, and anything without a row is skipped with a note.

## Hook scripts

palm copies what a hook or stdio MCP server runs into `.palm/assets/<source>/<entity>/`, the entity's **closure**.
`<source>` is the `palm.yaml` key with `/` replaced by `__`, so `trailofbits/skills` becomes `trailofbits__skills`.
The closure is the folder that holds the hook definition, plus every file a command names.
It also holds every file a script reads through a literal path, such as `$CLAUDE_PLUGIN_ROOT/skills/x/SKILL.md`, `../x` or `"$(dirname "$0")/../x"`.
palm never copies `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, plugin manifests, `.git` or `node_modules`, and copies a `SKILL.md` only when a script reads it.
Mode bits are kept. A symlink is dereferenced, and one that leaves the source refuses the entity.

A reference to the plugin root, such as `${CLAUDE_PLUGIN_ROOT}/hooks/x.sh`, becomes a quoted path in each harness's project-folder idiom.

| Target | Command starts with |
| --- | --- |
| `claude` | `"$CLAUDE_PROJECT_DIR"/.palm/assets/...` |
| `cursor` | `"$CURSOR_PROJECT_DIR"/.palm/assets/...` |
| `gemini` | `"$GEMINI_PROJECT_DIR"/.palm/assets/...` |
| `codex`, `copilot` | `"$(git rev-parse --show-toplevel 2>/dev/null \|\| pwd)"/.palm/assets/...` |
| any, with `-g` | `"$HOME"/.palm/assets/...` |
| `opencode` | skipped |

An in-repo source is not copied. Its scripts run in place, such as `"$CLAUDE_PROJECT_DIR"/agent-kit/hooks/x.sh`, so an edit is live.
palm still hashes those scripts for [consent](/palm/concepts/consent/), so an edit asks again on the next install.

## MCP servers

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.mcp.json` (`mcpServers`) | `~/.claude.json` (`mcpServers`) |
| `codex` | `.codex/config.toml` (`[mcp_servers.<n>]`) | `~/.codex/config.toml` |
| `copilot` | `.vscode/mcp.json` (`servers`) | `~/.copilot/mcp-config.json` (`mcpServers`) |
| `cursor` | `.cursor/mcp.json` (`mcpServers`) | `~/.cursor/mcp.json` |
| `gemini` | `.gemini/settings.json` (`mcpServers`) | `~/.gemini/settings.json` (`mcpServers`) |
| `opencode` | `opencode.json` (`mcp`) | `~/.config/opencode/opencode.json` (`mcp`) |

Secrets are environment references in each harness's syntax. [Secrets](/palm/concepts/secrets/#one-reference-six-spellings) lists them.
Every file that can hold secrets is created with mode `0600` in global scope.

## Harness homes

With `-g`, `~/.claude` follows `$CLAUDE_CONFIG_DIR`, `~/.codex` follows `$CODEX_HOME` and `~/.copilot` follows `$COPILOT_HOME`.
`~/.gemini` becomes `$GEMINI_CLI_HOME/.gemini`, and `~/.config/opencode` becomes `$XDG_CONFIG_HOME/opencode`.

Gemini CLI ignores project settings, skills, agents and MCP servers in folders you have not trusted.
Trust the project folder in Gemini CLI after installing.

## How merging works

Hooks and MCP servers go into files the harness shares with your own settings.
palm parses the file, inserts its entries and writes it back, JSON with two-space indentation and TOML as a whole file.
The lock records each insertion by file, location and identity, never by value.

An entry you already wrote by hand with the same identity, such as the same hook event, matcher and command, is adopted and reported, never added twice.
An entry palm owns whose value you changed is `changed`: palm keeps it, `palm check` fails, and only `--force` writes it again.
`palm check` warns about a command in a hook array palm manages that no lock entry explains.

`palm remove` takes out exactly those entries, checks that each is gone, and prints `! could not remove` for one that stays.
It prunes containers palm emptied, such as `"hooks": {}`, and deletes a JSON file left as `{}`.
A Cursor `hooks.json` left holding only `version` is deleted when palm created the file, and kept otherwise.
It removes folders palm emptied, but never the harness folders themselves.
A symlinked config file, such as a dotfiles-managed `~/.claude/settings.json`, stays a link. palm writes through it.

## Related

- [Targets](/palm/concepts/targets/)
- [palm describe](/palm/reference/cli/describe/)
- [Project and global scope](/palm/concepts/scopes/)
- [Why native files per harness](/palm/explanation/why-native-files/)
