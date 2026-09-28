---
title: palm cache
description: Show or clear palm's cache of origin checkouts and indexes.
---

`palm cache` shows or removes `~/.palm/cache`, where palm keeps a checkout and an index of each origin.

```sh
palm cache info
palm cache clean [options]
```

| Command | Meaning |
| --- | --- |
| `palm cache info` | Path, size, number of checkouts and number of index files. |
| `palm cache clean` | Remove every checkout and index, after a confirmation. |
| `palm cache clean --yes` | Remove them without asking. |
| `palm cache clean --dry-run` | Show what palm would remove. |
| `palm cache info --json` | The same facts as JSON. |

## Subcommands

<!-- cli-reference:subcommands cache -->

| Command | Meaning |
| --- | --- |
| `palm cache info` | Cache path, size, checkouts and index files. |
| `palm cache clean` | Remove every checkout and index (origins stay registered; next use refetches). |

<!-- /cli-reference -->

## Options

<!-- cli-reference:options cache -->

No options of its own. The [global options](/palm/reference/cli/#global-options) apply.

<!-- /cli-reference -->

## Behavior

The cache holds one folder per origin repository, with one checkout per ref.
It also holds one index file per origin, ref and layout.
`palm cache clean` deletes `~/.palm/cache` as a whole.
Your origins stay registered, and the next command that needs one fetches it again.

`palm cache clean` asks `Remove N checkouts and M indexes?`, with the default No.
Without a terminal, it stops with `E_NON_INTERACTIVE` unless you pass `--yes`.

With `--json`, `info` returns `{ "path", "exists", "bytes", "checkouts", "indexes" }`, and `clean` adds `removed`.

## Exit codes

| Code | When |
| --- | --- |
| `0` | The cache is shown, removed or already empty. |
| `1` | No terminal and no `--yes`. |
| `2` | No subcommand, or an unknown one. |
| `130` | You answered No, or pressed Esc. |

## Related

- [Layout of palm's files](/palm/reference/environment/#palm_home)
- [`palm update`](/palm/reference/cli/update/)
