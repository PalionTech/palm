---
title: Project and global scope
description: The scope decides whether palm writes into the current project or into your home directory.
sidebar:
  label: Scopes
---

The **scope** decides where palm writes: `project` (the default) or `global`.
Project scope writes under the project root. Global scope, chosen with `-g`, writes under your home directory.

```sh
palm install skill tdd        # .claude/skills/tdd/ in this project
palm install skill tdd -g     # ~/.claude/skills/tdd/ for every project
```

Every command takes `-g`, and the same command works in both scopes.

## The project root

palm looks upward from the current directory and takes the first match:

1. The nearest directory with a `palm.yaml`.
2. The nearest directory with a `.git`.
3. The current directory.

## What changes with the scope

| | Project | Global (`-g`) |
| --- | --- | --- |
| Harness files | under the project root, such as `.claude/agents/` | under `~`, such as `~/.claude/agents/` |
| Manifest | `palm.yaml` in the project root | `~/.palm/palm.yaml` |
| Lockfile | `palm.lock.yaml` in the project root | `~/.palm/palm.lock.yaml` |
| Saved targets | `targets:` in `palm.yaml` | `targets:` in `~/.palm/config.yaml` |
| Hook scripts | `.palm/hooks/<name>/` | `~/.palm/hooks/<name>/` |
| MCP secrets, by default | an environment reference | the value, in a user config file created with mode `0600` |

Commit the project's `palm.yaml` and `palm.lock.yaml`.
Add `.palm/` to `.gitignore`: `palm init` does this for you.

## Harness homes

For the global scope, palm follows the same variables the harnesses use:

| Variable | Replaces |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | `~/.claude` |
| `CODEX_HOME` | `~/.codex` |
| `COPILOT_HOME` | `~/.copilot` |
| `PALM_HOME` | `~/.palm` |

Some paths differ between the scopes.
Claude Code keeps global MCP servers in `~/.claude.json`, and Copilot keeps them in `~/.copilot/mcp-config.json`.
The [targets matrix](/palm/reference/targets-matrix/) lists both scopes for every kind.

## Related

- [Targets](/palm/concepts/targets/)
- [Glossary](/palm/reference/glossary/)
- [Security model](/palm/explanation/security/)
