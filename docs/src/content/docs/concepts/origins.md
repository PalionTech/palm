---
title: Origins
description: An origin is a git repository, a folder in one, or a local directory that palm installs entities from.
---

An **origin** is a place palm installs entities from: a git repository, a folder inside one, or a local directory.
You add an origin once, and every entity in it becomes installable by name.

```sh
palm origin add mattpocock/skills
palm origin add cursor/plugins/pstack --alias pstack
palm install skill tdd
```

`palm origin add` clones the repository, scans it and stores an index.
`palm install skill tdd` then searches the indexes of all your origins.

## What you can add

| Spec | Example |
| --- | --- |
| GitHub `owner/repo` | `mattpocock/skills` |
| A folder in a repository | `cursor/plugins/pstack` |
| GitHub shorthand | `github:obra/superpowers` |
| Any git URL, with an optional `#ref` | `https://gitlab.com/team/agents.git#v2.0.0` |
| A local directory | `./my-skills` |
| A marketplace file | `./.claude-plugin/marketplace.json` |

A marketplace file becomes one origin per plugin it lists.
palm scans each origin as it is published: see [how palm reads a repository](/palm/reference/scan-rules/).

## Refs

Without a ref, palm uses the latest semver tag, else the default branch.
Pin a tag, branch or commit with `--ref` or a `#ref` suffix.
The lockfile records the commit palm installed from.

## Aliases

The **alias** is the short name after `@` in `tdd@mattpocock`.
By default it is the repository name: `obra/superpowers` becomes `superpowers`.

When the repository name is generic, such as `skills`, `plugins`, `agents` or `rules`, the alias is the owner.
`mattpocock/skills` becomes `mattpocock`.
When the alias is taken, palm uses `owner-repo`.
A folder origin takes the folder's last segment.
Choose your own with `--alias`.

Aliases use lowercase letters, digits, `.`, `_` and `-`, and start with a letter or digit.

## When several origins have the name

`palm install skill tdd` installs directly when one origin has `tdd`.
When several do, palm shows a picker.
Without a terminal, it stops with `E_AMBIGUOUS` and lists the `name@origin` forms to use.

```sh
palm install skill tdd@mattpocock
```

## Where origins live

| What | Where |
| --- | --- |
| Your origins | `~/.palm/config.yaml` |
| A project's own origins (`--project`) | `origins:` in the project's `palm.yaml` |
| Checkouts and scan results | `~/.palm/cache/` |

`palm origin update` fetches and rescans an origin.
`palm origin remove` forgets it; entities you installed from it stay installed.

## Two built-in sources

- `mine` is a local origin at `~/.palm/mine`. `palm create` writes new entities there.
- The official MCP registry serves `palm install mcp <registry name>`. It is the only registry palm reads.

## Related

- [Why origins, not a registry](/palm/explanation/why-origins/)
- [Layout descriptor for unusual repositories](/palm/reference/layout/)
- [Security model](/palm/explanation/security/)
