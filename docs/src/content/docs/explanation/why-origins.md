---
title: Why origins, not a registry
description: palm installs from git repositories you choose, as they are published. There is no central index to publish to or to squat on.
sidebar:
  label: Why origins
---

palm installs from **origins**: git repositories and folders that you add yourself.
It has no central package registry, and authors publish nothing to palm.

```sh
palm origin add obra/superpowers
palm install plugin superpowers
```

The repository is the package. Its tags are the versions.

## Repositories are already published

Skills, subagents and plugins already live in git repositories.
Authors ship them as Claude Code plugins, Cursor plugins, marketplaces, APM packages or plain `SKILL.md` folders.
A registry would ask each author to repackage and republish for one more tool.
palm reads what exists: its [scanner](/palm/reference/scan-rules/) detects the layout, and a [layout descriptor](/palm/reference/layout/) covers the rest.

## Trust follows your choice

You decide which repositories palm may install from, one `palm origin add` at a time.
A name resolves only against those origins.
Nobody can publish a similar name into a shared index and wait for a typo.
When two of your origins offer the same name, palm asks, or fails with `E_AMBIGUOUS` in a script.

## Versions come from git

Without a ref, palm installs the latest semver tag, else the default branch.
The lockfile records the exact commit, so a teammate installs the same content.
Moving to a new version is a new tag in the author's repository, not a new upload.

## What this costs

- Discovery starts empty. `palm search` finds what your origins offer, plus MCP servers from the registry.
- A repository can move or disappear. The lockfile keeps the URL and commit, but not a copy.
- palm talks to each origin's git host. Private repositories need your usual git credentials.

## The one registry palm reads

MCP servers are the exception.
`palm install mcp <name>` can resolve a name through the official MCP registry at `registry.modelcontextprotocol.io`.
In these docs, "registry" always means that MCP registry.

## Related

- [Origins](/palm/concepts/origins/)
- [Security model](/palm/explanation/security/)
- [Scan rules](/palm/reference/scan-rules/)
