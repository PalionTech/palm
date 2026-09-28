---
title: Why origins, not a registry
description: palm installs from git repositories you choose, as their authors published them. There is no central index to publish to or to squat on.
sidebar:
  label: Why origins
---

palm installs from **origins**, which are git repositories and folders that you add yourself.
It has no central package registry, and authors publish nothing to palm.

```sh
palm install origin obra/superpowers
palm install plugin superpowers
```

The repository holds the entities, and its tags are the versions.
The first command adds the repository once. The second installs from it by name.

## Repositories are already published

Skills, subagents and plugins already live in git repositories.
Authors ship them as Claude Code plugins, Cursor plugins, marketplaces, APM packages or plain `SKILL.md` folders.
A registry would ask each author to repackage and republish for one more tool.
palm reads what exists instead.
Its [scanner](/palm/concepts/scanning/) detects the layout, and a [layout descriptor](/palm/reference/layout/) covers the rest.

## Trust follows your choice

You decide which repositories palm may install from, one `palm install origin` at a time.
A name resolves only against those origins.
Nobody can publish a similar name into a shared index and wait for a typo.
When two of your origins offer the same name, palm asks, or fails with `E_AMBIGUOUS` in a script.

## Versions come from git

Without a ref, palm installs the latest semver tag, else the default branch.
A `#ref` pins a tag, a branch, a commit or a semver range such as `^1.2`.
The lockfile records the exact commit, and a bare `palm install` installs that commit again.
A new version is a new tag in the author's repository, not a new upload.
`palm outdated` shows which entries have one.

## What this costs

| Cost | What palm does about it |
| --- | --- |
| Discovery starts with no origins. | `palm search` finds what your origins offer, plus MCP servers from the registry. |
| A repository can move or disappear. | The lockfile keeps the URL and the commit, but no copy of the files. |
| Private repositories need access. | palm uses your usual git credentials and never prompts for them. |
| Each origin is a separate git host call. | palm caches checkouts and indexes in `~/.palm/cache`, and `--offline` uses only the cache. |

## The one registry palm reads

MCP servers are the exception.
`palm install mcp <name>` can resolve a name through the official MCP registry at `registry.modelcontextprotocol.io`.
In these docs, "registry" always means that MCP registry.

## Related

- [Origins](/palm/concepts/origins/)
- [Security model](/palm/explanation/security/)
- [How palm reads a repository](/palm/concepts/scanning/)
