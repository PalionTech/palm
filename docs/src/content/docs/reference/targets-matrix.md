---
title: Targets matrix
description: Where palm writes every kind, for every target, in project and global scope.
---

This page lists every path palm writes, by kind, target and scope.
`<n>` is the entity name. Project paths are relative to the project root; global paths start at `~`.

```sh
palm install agent reviewer --target claude,codex,copilot,cursor
palm install agent reviewer -g
```

`gemini` (Gemini CLI) and `opencode` (OpenCode) are planned for 1.0.
Their rows show the planned paths, checked against each harness's documentation and source on 2026-09-28.
A note under each table names the paths we could not verify yet.

## Skills

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.claude/skills/<n>/` | `~/.claude/skills/<n>/` |
| `codex` | `.agents/skills/<n>/` | `~/.agents/skills/<n>/` |
| `copilot` | `.agents/skills/<n>/` | `~/.agents/skills/<n>/` |
| `cursor` | `.agents/skills/<n>/` | `~/.agents/skills/<n>/` |
| `gemini`, planned | `.gemini/skills/<n>/` | `~/.gemini/skills/<n>/` |
| `opencode`, planned | `.opencode/skills/<n>/` | `~/.config/opencode/skills/<n>/` |

We have not verified the Gemini CLI paths yet.

palm writes `.agents/skills` once, however many of `codex`, `copilot` and `cursor` are active.
OpenCode also reads `.agents/skills` and `.claude/skills`.

## Agents

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.claude/agents/<n>.md` | `~/.claude/agents/<n>.md` |
| `codex` | `.codex/agents/<n>.toml` | `~/.codex/agents/<n>.toml` |
| `copilot` | `.github/agents/<n>.agent.md` | `~/.copilot/agents/<n>.agent.md` |
| `cursor` | `.cursor/agents/<n>.md` | `~/.cursor/agents/<n>.md` |
| `gemini`, planned | `.gemini/agents/<n>.md` | `~/.gemini/agents/<n>.md` |
| `opencode`, planned | `.opencode/agents/<n>.md` | `~/.config/opencode/agents/<n>.md` |

We have not verified the Gemini CLI and OpenCode paths yet.
Gemini CLI agents are a preview feature.

## Instructions

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.claude/rules/<n>.md` | `~/.claude/rules/<n>.md` |
| `codex` | managed block in `AGENTS.md` | managed block in `~/.codex/AGENTS.md` |
| `copilot` | `.github/instructions/<n>.instructions.md` | `~/.copilot/instructions/<n>.instructions.md` |
| `cursor` | `.cursor/rules/<n>.mdc` | skipped: Cursor has no user rules |
| `gemini`, planned | managed block in `GEMINI.md` | managed block in `~/.gemini/GEMINI.md` |
| `opencode`, planned | managed block in `AGENTS.md` | managed block in `~/.config/opencode/AGENTS.md` |

We have not verified the global Gemini CLI and OpenCode paths yet.

## Commands

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.claude/commands/<n>.md` | `~/.claude/commands/<n>.md` |
| `codex` | skipped: Codex has no project prompts | `~/.codex/prompts/<n>.md` |
| `copilot` | `.github/prompts/<n>.prompt.md` | skipped: Copilot has no user prompt files |
| `cursor` | `.cursor/commands/<n>.md` | `~/.cursor/commands/<n>.md` |
| `gemini`, planned | `.gemini/commands/<n>.toml` | `~/.gemini/commands/<n>.toml` |
| `opencode`, planned | `.opencode/commands/<n>.md` | `~/.config/opencode/commands/<n>.md` |

Gemini CLI commands are TOML files; we verified the format.
We have not verified the Gemini CLI and OpenCode paths yet.

## Hooks

| Target | Project | Global |
| --- | --- | --- |
| `claude` | merged into `.claude/settings.json` | merged into `~/.claude/settings.json` |
| `codex` | merged into `.codex/hooks.json` | merged into `~/.codex/hooks.json` |
| `copilot` | `.github/hooks/<n>.json` | `~/.copilot/hooks/<n>.json` |
| `cursor` | merged into `.cursor/hooks.json` | merged into `~/.cursor/hooks.json` |
| `gemini`, planned | merged into `.gemini/settings.json` (`hooks`) | merged into `~/.gemini/settings.json` |
| `opencode`, planned | skipped: OpenCode hooks are JavaScript plugins | skipped |

We have not verified the Gemini CLI paths yet.

palm copies hook scripts to `.palm/hooks/<n>/`, or to `~/.palm/hooks/<n>/` with `-g`.
Claude Code and Codex use PascalCase event names; Cursor and Copilot use camelCase with `version: 1`.

## MCP servers

| Target | Project | Global |
| --- | --- | --- |
| `claude` | `.mcp.json` (`mcpServers`) | `~/.claude.json` (`mcpServers`) |
| `codex` | `.codex/config.toml` (`[mcp_servers.<n>]`) | `~/.codex/config.toml` |
| `copilot` | `.vscode/mcp.json` (`servers`) | `~/.copilot/mcp-config.json` (`mcpServers`) |
| `cursor` | `.cursor/mcp.json` | `~/.cursor/mcp.json` |
| `gemini`, planned | `.gemini/settings.json` (`mcpServers`) | `~/.gemini/settings.json` |
| `opencode`, planned | `opencode.json` (`mcp`) | `~/.config/opencode/opencode.json` |

We have not verified the global Gemini CLI and OpenCode paths yet.

## Harness homes

With `-g`, `~/.claude` follows `$CLAUDE_CONFIG_DIR`, `~/.codex` follows `$CODEX_HOME` and `~/.copilot` follows `$COPILOT_HOME`.

## How merging works

Hooks and MCP servers go into files the harness shares with your own settings.
palm parses the file, inserts its entries and writes it back: JSON with two-space indentation, TOML as a whole file.
The lockfile records each insertion as a file, a JSON pointer and the exact value.

An uninstall removes exactly those values.
It prunes containers palm emptied, such as `"hooks": {}`, and deletes a JSON file left as `{}`.
It removes directories palm emptied, but never the harness directories themselves, such as `.claude` or `.github`.

For Codex instructions, palm writes one managed block per instruction in `AGENTS.md` and removes only its own blocks.

## Related

- [Targets](/palm/concepts/targets/)
- [Project and global scope](/palm/concepts/scopes/)
- [Why native files per harness](/palm/explanation/why-native-files/)
