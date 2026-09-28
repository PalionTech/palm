---
title: Why native files per harness
description: palm writes each item in the format and place each harness reads, instead of compiling everything into one shared file.
sidebar:
  label: Why native files
---

palm writes every entity in the native format of each harness.
One agent becomes four files, one per harness, and each harness reads its own.

```sh
palm install agent reviewer --target claude,codex,copilot,cursor
```

| Harness | File palm writes | Format |
| --- | --- | --- |
| Claude Code | `.claude/agents/reviewer.md` | Markdown with YAML frontmatter |
| Codex | `.codex/agents/reviewer.toml` | TOML |
| GitHub Copilot | `.github/agents/reviewer.agent.md` | Markdown with Copilot's frontmatter |
| Cursor | `.cursor/agents/reviewer.md` | Markdown with YAML frontmatter |

## The alternative: one compiled file

A tool can compile everything into one shared file, such as a long `AGENTS.md`.
Every harness that reads `AGENTS.md` then sees the same text.
That works for instructions, but it loses what the harnesses load separately:

- A skill loads on demand. Its name and description cost context at startup; its body loads only when used.
- A subagent runs in its own context, with its own tools and model.
- Hooks and MCP servers are configuration, not prose. A harness reads them only from its config files.

Native files keep each of these working the way its harness designed it.

## Exact removal

Each native file belongs to one entity, so an uninstall deletes that file.
Hooks and MCP servers merge into shared files such as `.claude/settings.json` or `.codex/config.toml`.
For those, the lockfile records the JSON pointer and the exact value palm inserted.
An uninstall removes that value, prunes containers palm emptied, and leaves your other settings alone.

Instructions for Codex are the one shared text file.
palm writes each one as a managed block in `AGENTS.md`, and removes only its own block.

## What this costs

Each harness format changes on its own schedule.
palm has to follow the Claude Code, Codex, Copilot and Cursor formats and release when one moves.
Every target is one module with its own tests, and the [targets matrix](/palm/reference/targets-matrix/) records the paths palm writes today.

Some combinations have no native place, such as project-level prompts in Codex.
palm skips those and says so, instead of writing a file the harness ignores.

## Related

- [Targets](/palm/concepts/targets/)
- [Targets matrix](/palm/reference/targets-matrix/)
- [Entities and kinds](/palm/concepts/entities/)
