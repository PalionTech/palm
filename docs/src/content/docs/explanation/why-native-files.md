---
title: Why native files per harness
description: palm writes each item in the format and place each harness reads, commits the result, and never compiles everything into one shared file.
sidebar:
  label: Why native files
---

palm writes every entity in the native format of each harness.
One agent becomes six files, one per harness, and each harness reads its own.

```sh
palm install anthropics/claude-plugins-official agent-sdk-verifier-py
```

| Harness | File palm writes | Format |
| --- | --- | --- |
| Claude Code | `.claude/agents/<name>.md` | Markdown with YAML frontmatter |
| Codex | `.codex/agents/<name>.toml` | TOML |
| GitHub Copilot | `.github/agents/<name>.agent.md` | Markdown with Copilot's frontmatter and tool names |
| Cursor | `.cursor/agents/<name>.md` | Markdown with YAML frontmatter |
| Gemini CLI | `.gemini/agents/<name>.md` | Markdown with Gemini's strict frontmatter, including `kind: local` |
| OpenCode | `.opencode/agents/<name>.md` | Markdown with `mode: subagent` and permissions from the tool lists |

The [home page](/palm/) shows a recorded run of this install and the files it created.

## The alternative is one compiled file

A tool can compile everything into one shared file, such as a long `AGENTS.md`.
Every harness that reads `AGENTS.md` then sees the same text.
That works for instructions, but it loses what the harnesses load separately.

- A skill loads on demand. Its name and description cost context at startup, and its body loads only when used.
- A subagent runs in its own context, with its own tools and model.
- Hooks and MCP servers are configuration. A harness reads them only from its config files.

Native files keep each of these working the way its harness designed it.

## Why the files are committed

Every generated file is a function of `palm.yaml`, the lock and the sources, so palm could rebuild them on every machine.
It asks you to commit them instead.

- A clone works without palm, in the editor, in CI, and on a machine where palm is not installed.
- A review sees exactly what each harness will read. A converted agent is not a black box.
- `palm check` can prove the committed bytes still match the sources, which a rebuild on each machine cannot.

palm 0.1 kept hook scripts in an ignored folder and rebuilt them per clone. A clone without palm then held hook commands that pointed nowhere.
palm 0.2 commits them in `.palm/assets/`, and nothing dangles.

## Exact removal

Each native file belongs to one entity, so a removal deletes that file.
Hooks and MCP servers merge into shared files, such as `.claude/settings.json` or `.codex/config.toml`.
For those, the lock records where palm inserted each entry and an identity that finds it again.
A removal takes out that entry, prunes containers palm emptied, and leaves your other settings alone.

Instructions for Codex and Gemini CLI share one text file each.
palm writes each instruction as a managed block in `AGENTS.md` or `GEMINI.md`, and removes only its own block.

## What this costs

Each harness format changes on its own schedule, and palm follows six of them.
Each target is one module with its own tests, and the [targets matrix](/palm/reference/targets-matrix/) records the paths palm writes today.
Gemini CLI and OpenCode are marked unverified until an end-to-end job runs their real CLIs.

A conversion can lose detail.
When a format has no field for something, palm drops it from that one file and records a note, and `palm describe` shows it later.
Codex agents, for example, get no `model` from a Claude Code agent that names `sonnet`.

Some combinations have no native place, such as hooks in OpenCode.
palm skips those and says so, instead of writing a file the harness ignores.

## Related

- [Targets](/palm/concepts/targets/)
- [Targets matrix](/palm/reference/targets-matrix/)
- [palm.yaml and palm.lock.yaml](/palm/concepts/manifest-and-lockfile/)
