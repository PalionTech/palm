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

A command found in a source installs at these paths as a skill, with `name`, `description` and the command body in `SKILL.md`.
`$ARGUMENTS` survives. Where a harness does not expand it, a note says so.

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

- Gemini CLI rejects an agent file with any key outside its schema. palm writes only the keys Gemini defines, and maps Claude tool names to Gemini names, such as `Read` to `read_file` and `Bash` to `run_shell_command`.
- GitHub Copilot ignores tool names it does not know, so palm maps each tool to a Copilot name, such as `Read` to `read` and `mcp__docs__search` to `docs/search`. Copilot has no argument restrictions, so `Bash(git:*)` becomes `execute`.
- OpenCode passes unknown keys to the model provider, so palm writes only the keys OpenCode defines, `mode: subagent`, and a `permission` map built from the tool lists.
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
A root `AGENTS.md` or `GEMINI.md` whose managed blocks pass 24 KiB makes `palm check` warn. Above the harness's documented cap, palm refuses without `--force`.

## Hooks

| Target | Project | Global |
| --- | --- | --- |
| `claude` | merged into `.claude/settings.json` | merged into `~/.claude/settings.json` |
| `codex` | merged into `.codex/hooks.json` | merged into `~/.codex/hooks.json` |
| `copilot` | `.github/hooks/<n>.json` | `~/.copilot/hooks/<n>.json` |
| `cursor` | merged into `.cursor/hooks.json` | merged into `~/.cursor/hooks.json` |
| `gemini` | merged into `.gemini/settings.json` | merged into `~/.gemini/settings.json` |
| `opencode` | skipped: OpenCode hooks are JavaScript plugins | skipped |

Gemini CLI has its own event names and counts timeouts in milliseconds.
palm 0.3 ships a table of documented one-to-one event and matcher equivalents, each row tagged with the harness version it was checked against, and skips anything without a row, with a note.

## Hook scripts

palm copies what a hook or stdio MCP server runs into `.palm/assets/<source>/<entity>/`, the entity's **closure**.
`<source>` is the `palm.yaml` key with `/` replaced by `__`, so `trailofbits/skills` becomes `trailofbits__skills`.
The closure is the folder that holds the hook definition, plus every file a command names. palm never copies `SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, plugin manifests, `.git` or `node_modules`.
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

`palm remove` takes out exactly those entries.
It prunes containers palm emptied, such as `"hooks": {}`, and deletes a JSON file left as `{}`.
It removes folders palm emptied, but never the harness folders themselves.
A symlinked config file, such as a dotfiles-managed `~/.claude/settings.json`, stays a link. palm writes through it.

## Related

- [Targets](/palm/concepts/targets/)
- [palm describe](/palm/reference/cli/describe/)
- [Project and global scope](/palm/concepts/scopes/)
- [Why native files per harness](/palm/explanation/why-native-files/)
