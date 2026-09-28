---
title: Security model
description: What palm trusts, what it refuses, and where it puts secrets.
---

palm installs content from repositories you choose.
Most of it is text, but hooks and MCP servers run programs on your machine.

```sh
palm install plugin superpowers --dry-run
```

`--dry-run` resolves the plugin and prints what palm would install.
It writes no harness file, lockfile or manifest.

## What you trust

Adding an origin is a decision to trust its author.
palm never installs from a repository you did not add, except with an explicit `--from`.
It does not review the content of an origin for you.

| Kind | What it can do |
| --- | --- |
| skill, agent, instruction, command | Shape what the model does. The harness decides which tools it may use. |
| hook | Runs a shell command on a harness event, with your permissions. |
| mcp | Starts a local program (stdio) or connects to a URL (HTTP), with the tools that server exposes. |

When an install writes a hook, palm prints a note with the path of the hook file to review.
Treat a hook like any other software you install.

## What palm refuses

| Refused | Rule |
| --- | --- |
| Names that are paths | An entity name is one path segment: letters, digits, `.`, `_` and `-`, never `..`. palm checks it before it writes a file. |
| Symlinks that leave the origin | palm follows a symlink only when its real target stays inside the origin. A skill cannot carry `~/.ssh/id_rsa` into `.claude/skills`. |
| Unsafe git transports | Origin URLs may use `https`, `ssh`, `file`, `user@host:path` and absolute paths; `http` and `git` get a warning. palm refuses `ext::`, every other `<x>::` transport, a leading `-` and control characters. |
| Deletes outside the scope | palm never deletes a lockfile path outside the project root, or outside your home with `-g`. |
| Files it does not own | When a destination exists and the lockfile does not list it, palm stops. `--force` overwrites the file and records it. |

Every git call runs with `protocol.ext.allow=never` and `protocol.fd.allow=never`.
It puts `--` before URLs and refs, so an origin cannot pass itself off as a git option.

## Secrets

palm treats every `${VAR}` placeholder in an MCP server's `env`, `headers`, `url` or `args` as a secret.

| Scope | Default policy | What palm writes |
| --- | --- | --- |
| project | `env-ref` | The harness's own reference: `${VAR}` for Claude Code, `${env:VAR}` for Cursor and VS Code, `env_vars` for Codex |
| global (`-g`) | `literal` | The value, read from your environment or a masked prompt, into a user config file created with mode `0600` |

The lockfile stores the `${VAR}` placeholder, never the value.
palm writes a literal secret into a project file only when you pass `--secrets literal`.
HTTP servers without secrets get only their URL, and the harness runs OAuth on first connect.

## Network access

palm has no telemetry and no update check.
It contacts only your origins' git hosts, the MCP registry for `palm search` and `palm install mcp`, and URLs you pass it.
`--offline` limits palm to its cache.

## Planned for 1.0

- A consent step that lists every hook command and stdio MCP server before it writes them. Scripts will need `--yes`.
- A scan for hidden Unicode (bidirectional overrides, tag characters) before install, and a `palm audit` command.
- Per-file content hashes in the lockfile, so palm refuses to overwrite a file you edited.

## Related

- [Why origins, not a registry](/palm/explanation/why-origins/)
- [Origins](/palm/concepts/origins/)
- [Project and global scope](/palm/concepts/scopes/)
