---
title: palm doctor
description: Check git, Node, palm home, harness detection, lockfile drift, hook assets and origins.
---

`palm doctor` runs every check it knows and prints one line per check.

```sh
palm doctor [options]
```

| Command | Meaning |
| --- | --- |
| `palm doctor` | Run every check, including a network check of each origin. |
| `palm doctor --offline` | Skip the origin check. |
| `palm doctor --json` | Every check as JSON, for a bug report. |
| `palm doctor --offline --json` | The same without network access. |

## Options

<!-- cli-reference:options doctor -->

No options of its own. The [global options](/palm/reference/cli/#global-options) apply.

<!-- /cli-reference -->

## Checks

| Group | Check | Fails or warns when |
| --- | --- | --- |
| `system` | git | git is not on `PATH` (fail) |
| `system` | node | Node is older than 22 (fail) |
| `palm` | palm home | `~/.palm`, or the nearest folder above it, is not writable (fail) |
| `palm` | cache | never; shows the cache size |
| `targets` | one per harness | never; shows where palm detects it |
| `lock` | project scope, global scope | a locked file is missing, or `palm.yaml` lists an entry that is not installed (warn) |
| `hooks` | project scope, global scope | copied hook scripts are missing, as after a fresh clone (warn) |
| `origins` | one per origin | a local origin's folder is missing, or a git origin does not answer within 20 seconds (fail) |

Each line starts with a status: `+` ok, `i` information, `!` warning, `x` failure.
A warning names the command that fixes it, such as `palm install`.

With `--json`, the document is `{ "items": [{ "group", "name", "status", "detail" }], "warnings": [] }`.
`status` is `ok`, `info`, `warn` or `fail`.

## Behavior

`palm doctor` never prompts and writes nothing.
It contacts each git origin with `git ls-remote`, unless `--offline`.

## Exit codes

| Code | When |
| --- | --- |
| `0` | No check failed. Warnings do not change the code. |
| `1` | At least one check failed. |
| `2` | A usage error. |

## Related

- [Troubleshooting](/palm/reference/troubleshooting/)
- [Environment variables](/palm/reference/environment/)
