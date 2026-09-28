---
title: Why native files per harness
description: palm writes each item in the format and place each harness reads, instead of compiling everything into one shared file.
sidebar:
  label: Why native files
---

palm writes every entity in the native format of each harness.
One agent becomes six files, one per harness, and each harness reads its own.

```sh
palm install agent reviewer --target claude,codex,copilot,cursor,gemini,opencode
```

| Harness | File palm writes | Format |
| --- | --- | --- |
| Claude Code | `.claude/agents/reviewer.md` | Markdown with YAML frontmatter |
| Codex | `.codex/agents/reviewer.toml` | TOML |
| GitHub Copilot | `.github/agents/reviewer.agent.md` | Markdown with Copilot's frontmatter |
| Cursor | `.cursor/agents/reviewer.md` | Markdown with YAML frontmatter |
| Gemini CLI | `.gemini/agents/reviewer.md` | Markdown with Gemini's frontmatter, including `kind: local` |
| OpenCode | `.opencode/agents/reviewer.md` | Markdown with `mode: subagent` and permissions from the tool lists |

The [home page](/palm/) shows a recorded run of this install and the files it created.

## The alternative is one compiled file

A tool can compile everything into one shared file, such as a long `AGENTS.md`.
Every harness that reads `AGENTS.md` then sees the same text.
That works for instructions, but it loses what the harnesses load separately.

- A skill loads on demand. Its name and description cost context at startup, and its body loads only when used.
- A subagent runs in its own context, with its own tools and model.
- Hooks and MCP servers are configuration. A harness reads them only from its config files.

Native files keep each of these working the way its harness designed it.

## Exact removal

Each native file belongs to one entity, so an uninstall deletes that file.
Hooks and MCP servers merge into shared files, such as `.claude/settings.json` or `.codex/config.toml`.
For those, the lockfile records the JSON pointer and the exact value palm inserted.
An uninstall removes that value, prunes containers palm emptied and leaves your other settings alone.

Instructions for Codex and Gemini CLI share one text file each.
palm writes each instruction as a managed block in `AGENTS.md` or `GEMINI.md`, and removes only its own block.

## What this costs

Each harness format changes on its own schedule.
palm follows six formats and releases when one moves.
Each target is one module with its own tests, and the [targets matrix](/palm/reference/targets-matrix/) records the paths palm writes today.

A conversion can lose detail.
When a format has no field for something, palm drops it from that one file.
The install summary names each dropped field.
Codex agents, for example, get no `model` from a Claude Code agent that names `sonnet`.

Some combinations have no native place, such as project-level prompts in Codex.
palm skips those and says so, instead of writing a file the harness ignores.

## Related

- [Targets](/palm/concepts/targets/)
- [Targets matrix](/palm/reference/targets-matrix/)
- [Entities and kinds](/palm/concepts/entities/)
