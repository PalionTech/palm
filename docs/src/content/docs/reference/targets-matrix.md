---
title: Targets matrix
description: Where palm writes every kind, for every target, in project and global scope.
---

This page lists every path palm writes, by kind, target and scope.
`<n>` is the entity name. Project paths are relative to the project root; global paths start at `~`.

```sh
palm install agent reviewer --target claude,codex,copilot,cursor,gemini,opencode
palm install agent reviewer -g
```

`palm describe target <target>` prints these paths for your machine, with every override applied.

The `gemini` (Gemini CLI) and `opencode` (OpenCode) rows follow each harness's documentation and source, checked on 2026-09-28.
Neither harness has been tested against a running CLI yet.

## Skills

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.claude/skills/<n>/` | `~/.claude/skills/<n>/` |
| `codex` | `.agents/skills/<n>/` | `~/.agents/skills/<n>/` |
| `copilot` | `.agents/skills/<n>/` | `~/.agents/skills/<n>/` |
| `cursor` | `.agents/skills/<n>/` | `~/.agents/skills/<n>/` |
| `gemini` | `.agents/skills/<n>/` | `~/.agents/skills/<n>/` |
| `opencode` | `.agents/skills/<n>/` | `~/.agents/skills/<n>/` |

palm writes `.agents/skills` once, however many of `codex`, `copilot`, `cursor`, `gemini` and `opencode` are active.
With `$GEMINI_CLI_HOME` set, Gemini CLI reads `$GEMINI_CLI_HOME/.agents/skills`, so global skills go to `$GEMINI_CLI_HOME/.gemini/skills/<n>/`.
With `OPENCODE_DISABLE_EXTERNAL_SKILLS` set, OpenCode ignores `.agents/skills`, so palm writes `.opencode/skills/<n>/` and `~/.config/opencode/skills/<n>/`.

## Agents

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.claude/agents/<n>.md` | `~/.claude/agents/<n>.md` |
| `codex` | `.codex/agents/<n>.toml` | `~/.codex/agents/<n>.toml` |
| `copilot` | `.github/agents/<n>.agent.md` | `~/.copilot/agents/<n>.agent.md` |
| `cursor` | `.cursor/agents/<n>.md` | `~/.cursor/agents/<n>.md` |
| `gemini` | `.gemini/agents/<n>.md` | `~/.gemini/agents/<n>.md` |
| `opencode` | `.opencode/agents/<n>.md` | `~/.config/opencode/agents/<n>.md` |

Gemini CLI rejects an agent file with any key outside its schema.
palm writes only `name`, `description`, `kind`, `display_name`, `tools`, `model`, `temperature`, `max_turns` and `timeout_mins`.
Claude tool names become Gemini names, for example `Read` becomes `read_file` and `Bash` becomes `run_shell_command`.
Gemini CLI agents are a preview feature behind `experimental.enableAgents`.

GitHub Copilot ignores tool names it does not know, so palm maps each tool to a Copilot name.
For example `Read` becomes `read`, `Bash` becomes `execute`, and `mcp__docs__search` becomes `docs/search`.
Copilot has no argument restrictions, so `Bash(git:*)` becomes plain `execute`.
The install summary names each restriction it lost and each tool without a Copilot name.

OpenCode passes unknown agent keys to the model provider, so palm writes only the keys OpenCode defines.
Each agent gets `mode: subagent`, and a `tools` list becomes a `permission` block that denies everything else.
The install summary names every key palm dropped.

## Instructions

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.claude/rules/<n>.md` | `~/.claude/rules/<n>.md` |
| `codex` | managed block in `AGENTS.md` | managed block in `~/.codex/AGENTS.md` |
| `copilot` | `.github/instructions/<n>.instructions.md` | `~/.copilot/instructions/<n>.instructions.md` |
| `cursor` | `.cursor/rules/<n>.mdc` | skipped: Cursor has no user rules |
| `gemini` | managed block in `GEMINI.md` | managed block in `~/.gemini/GEMINI.md` |
| `opencode` | `.opencode/instructions/<n>.md`, listed in `opencode.json` | `~/.config/opencode/instructions/<n>.md`, listed in `~/.config/opencode/opencode.json` |

Gemini CLI loads only `GEMINI.md` files, so each instruction is a block in that file.
OpenCode reads the files named in the `instructions` array of `opencode.json`.
palm adds one entry per instruction: a project-relative path, or an absolute path in the global config.
It does not write `AGENTS.md` for OpenCode, because an `AGENTS.md` hides an existing `CLAUDE.md` from OpenCode.

## Commands

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.claude/commands/<n>.md` | `~/.claude/commands/<n>.md` |
| `codex` | skipped: Codex has no project prompts | `~/.codex/prompts/<n>.md` |
| `copilot` | `.github/prompts/<n>.prompt.md` | skipped: Copilot has no user prompt files |
| `cursor` | `.cursor/commands/<n>.md` | `~/.cursor/commands/<n>.md` |
| `gemini` | `.gemini/commands/<n>.toml` | `~/.gemini/commands/<n>.toml` |
| `opencode` | `.opencode/commands/<n>.md` | `~/.config/opencode/commands/<n>.md` |

Gemini CLI commands are TOML files with `description` and `prompt`.
palm turns `$ARGUMENTS` into `{{args}}`, a shell line into `!{cmd}` and a file reference into `@{path}`.
Gemini CLI has no positional arguments such as `$1`, and the install summary says so.

## Hooks

| Target | Project | Global |
| --- | --- | --- |
| `claude` | merged into `.claude/settings.json` | merged into `~/.claude/settings.json` |
| `codex` | merged into `.codex/hooks.json` | merged into `~/.codex/hooks.json` |
| `copilot` | `.github/hooks/<n>.json` | `~/.copilot/hooks/<n>.json` |
| `cursor` | merged into `.cursor/hooks.json` | merged into `~/.cursor/hooks.json` |
| `gemini` | merged into `.gemini/settings.json` (`hooks`) | merged into `~/.gemini/settings.json` (`hooks`) |
| `opencode` | skipped: OpenCode hooks are JavaScript plugins | skipped |

palm copies hook scripts to `.palm/hooks/<n>/`, or to `~/.palm/hooks/<n>/` with `-g`.
Claude Code and Codex use PascalCase event names; Cursor and Copilot use camelCase with `version: 1`.

Gemini CLI has its own event names and counts timeouts in milliseconds:

| Claude Code event | Gemini CLI event |
| --- | --- |
| `PreToolUse` | `BeforeTool` |
| `PostToolUse` | `AfterTool` |
| `UserPromptSubmit` | `BeforeAgent` |
| `Stop` | `AfterAgent` |
| `PreCompact` | `PreCompress` |
| `SessionStart`, `SessionEnd`, `Notification` | same name |

palm drops the other Claude Code events, such as `SubagentStop`, and names them in the install summary.
Tool names in matchers change as for agents, in both directions.
A Gemini CLI `run_shell_command` matcher becomes `Bash` for Claude Code and Codex.
A hook script still receives Gemini tool names on stdin, so a script that tests for `Bash` does not match.

## MCP servers

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.mcp.json` (`mcpServers`) | `~/.claude.json` (`mcpServers`) |
| `codex` | `.codex/config.toml` (`[mcp_servers.<n>]`) | `~/.codex/config.toml` |
| `copilot` | `.vscode/mcp.json` (`servers`) | `~/.copilot/mcp-config.json` (`mcpServers`) |
| `cursor` | `.cursor/mcp.json` | `~/.cursor/mcp.json` |
| `gemini` | `.gemini/settings.json` (`mcpServers`) | `~/.gemini/settings.json` (`mcpServers`) |
| `opencode` | `opencode.json` (`mcp`) | `~/.config/opencode/opencode.json` (`mcp`) |

Secrets stay environment references unless you pass `--secrets literal`.
Gemini CLI uses `${NAME}`, like Claude Code. OpenCode uses `{env:NAME}` and has no default value syntax.
palm writes `opencode.json` even when `opencode.jsonc` exists, because OpenCode loads and merges both.

## Harness homes

With `-g`, `~/.claude` follows `$CLAUDE_CONFIG_DIR`, `~/.codex` follows `$CODEX_HOME` and `~/.copilot` follows `$COPILOT_HOME`.
`~/.gemini` becomes `$GEMINI_CLI_HOME/.gemini`, and `~/.config/opencode` becomes `$XDG_CONFIG_HOME/opencode`.

Gemini CLI ignores project settings, commands, skills, agents and MCP servers in folders you have not trusted.
Trust the project folder in Gemini CLI after installing.

## How merging works

Hooks and MCP servers go into files the harness shares with your own settings.
palm parses the file, inserts its entries and writes it back: JSON with two-space indentation, TOML as a whole file.
The lockfile records each insertion as a file, a JSON pointer and the exact value.

An uninstall removes exactly those values.
It prunes containers palm emptied, such as `"hooks": {}`, and deletes a JSON file left as `{}`.
It removes directories palm emptied, but never the harness directories themselves, such as `.claude`, `.github` or `.opencode`.

For Codex and Gemini CLI instructions, palm writes one managed block per instruction in `AGENTS.md` or `GEMINI.md`.
It removes only its own blocks.
For OpenCode, it removes only its own entries from the `instructions` array.

## Related

- [Targets](/palm/concepts/targets/)
- [`palm describe`](/palm/reference/cli/describe/)
- [Project and global scope](/palm/concepts/scopes/)
- [Why native files per harness](/palm/explanation/why-native-files/)
