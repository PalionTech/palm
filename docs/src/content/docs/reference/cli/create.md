---
title: palm create
description: Write a new skill, agent, instruction or command into your own origin, then install it.
---

`palm create` asks a few questions, writes the file into your `mine` origin at `~/.palm/mine/`, then offers to install it.

```sh
palm create <kind> [name] [options]
```

Alias: `palm new`.
Kinds: `skill`, `agent`, `instruction` and `command`, as singular, plural or [short name](/palm/reference/cli/#kinds).

| Command | Meaning |
| --- | --- |
| `palm create skill release-notes` | Write `~/.palm/mine/skills/release-notes/SKILL.md`, then install it in this project. |
| `palm create agent code-reviewer -g` | Write an agent (subagent), then install it in your home directory. |
| `palm create instruction ts-style --no-install` | Only write the file. |
| `palm new command changelog` | Write a `/changelog` command. |
| `palm create agent --dry-run` | Show the file palm would write, and write nothing. |

## Options

<!-- cli-reference:options create -->

| Argument | Meaning |
| --- | --- |
| `kind` | skill, agent, instruction, command (plurals and short names work) |
| `names` | `name[@origin][#ref]` |

| Option | Meaning |
| --- | --- |
| `--no-install` | only write the file; do not install it |

The [global options](/palm/reference/cli/#global-options) also apply.

<!-- /cli-reference -->

## What it asks

| Kind | Questions |
| --- | --- |
| `skill` | name, description, optional folders (`scripts/`, `references/`, `assets/`) |
| `agent` | name, when to delegate to it, model, tools, skills, MCP servers, instructions, then the system prompt |
| `instruction` | name, description, path globs, whether it always applies |
| `command` | name, description, argument hint |

For an agent, palm offers the skills and MCP servers you have installed or indexed.
It searches the MCP registry on request.
It opens the new file in `$VISUAL` or `$EDITOR` when one is set.

## Behavior

### What it writes

| Kind | File |
| --- | --- |
| `skill` | `~/.palm/mine/skills/<name>/SKILL.md` |
| `agent` | `~/.palm/mine/agents/<name>.md` |
| `instruction` | `~/.palm/mine/instructions/<name>.md` |
| `command` | `~/.palm/mine/commands/<name>.md` |

The first run creates `~/.palm/mine`, runs `git init` in it and registers it as the origin `mine`.
palm then rescans `mine` and installs the entity through [`palm install`](/palm/reference/cli/install/), unless `--no-install`.
An agent's skills, MCP servers and instructions install with it as dependencies.

### What it asks

The questions above, then `Install <kind> <name> now?`, with the default yes.
With `--yes`, palm installs without asking.

### What it refuses

- Running without a terminal: `E_NON_INTERACTIVE`. Write the file into `~/.palm/mine/` yourself, then run `palm install <kind> <name>@mine`.
- A file that exists: palm asks to overwrite it, with the default No. `--force` overwrites.
- More than one name, or a kind other than the four above: usage errors.

## Exit codes

| Code | When |
| --- | --- |
| `0` | The file is written, and installed unless `--no-install`. |
| `1` | No terminal, the file exists, or the install failed. |
| `2` | A usage error. |
| `130` | You pressed Esc or Ctrl-C at a question. |

## Related

- [`palm install`](/palm/reference/cli/install/)
- [Entities](/palm/concepts/entities/)
