---
title: Targets
description: A target is palm's identifier for a harness. It decides which harnesses get files, and in which format.
---

A **harness** is the program that runs a coding agent, such as Claude Code or Codex.
A **target** is palm's identifier for a harness, such as `claude` or `codex`.
Flags and config values use targets. Prose about the tools uses harnesses.

```sh
palm install skill tdd --target claude,codex
palm targets
```

The first command writes the skill for Claude Code and Codex, and saves `targets: [claude, codex]` to `palm.yaml`.
`palm targets` shows which targets are active and why.

## The targets

| Target | Harness | Detected in a project by | Status |
| --- | --- | --- | --- |
| `claude` | Claude Code | `.claude/` or `CLAUDE.md` | supported |
| `codex` | Codex | `.codex/` or `AGENTS.md` | supported |
| `copilot` | GitHub Copilot | `.github/copilot-instructions.md`, `.github/agents/` or `.vscode/mcp.json` | supported |
| `cursor` | Cursor | `.cursor/` | supported |
| `gemini` | Gemini CLI | `.gemini/` or `GEMINI.md` | supported |
| `opencode` | OpenCode | `.opencode/`, `opencode.json` or `opencode.jsonc` | supported |

For the global scope, palm detects a harness by its home directory: `~/.claude`, `~/.codex`, `~/.copilot`, `~/.cursor`, `~/.gemini` or `~/.config/opencode`.

## How palm picks targets

palm takes the first of these that gives an answer:

1. The `--target` flag. palm saves it to `palm.yaml`, or to `~/.palm/config.yaml` with `-g`.
2. `targets:` in the project's `palm.yaml`.
3. `targets:` in `~/.palm/config.yaml`, the global default.
4. The harness markers in the table above.
5. A prompt, when a terminal is attached.

Commit `palm.yaml` with `targets:` so every clone installs for the same harnesses.

## One shared skill folder

Codex, GitHub Copilot, Cursor, Gemini CLI and OpenCode all read skills from `.agents/skills`.
palm writes that folder once, however many of the five are active.
Claude Code reads only `.claude/skills`, so a skill for `claude` gets its own copy.

## Combinations a harness does not support

Some harnesses have no place for a kind at one scope.
Codex has no project-level prompts, Copilot has no user-level prompt files, and Cursor has no user-level rules.
OpenCode has no declarative hooks, so palm skips hooks for `opencode`.
palm skips those combinations and says so in the install summary.
The [targets matrix](/palm/reference/targets-matrix/) marks each one.

## Related

- [Targets matrix](/palm/reference/targets-matrix/)
- [Project and global scope](/palm/concepts/scopes/)
- [Why native files per harness](/palm/explanation/why-native-files/)
