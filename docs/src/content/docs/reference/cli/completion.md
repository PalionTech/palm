---
title: palm completion
description: Print a shell completion script for bash, zsh or fish.
---

`palm completion` prints a completion script built from palm's command tree.

```sh
palm completion <shell>
```

| Command | Meaning |
| --- | --- |
| `palm completion bash` | Print the bash script. |
| `palm completion zsh` | Print the zsh script. |
| `palm completion fish` | Print the fish script. |

Load it from your shell's startup file:

| Shell | Setup |
| --- | --- |
| bash | `echo 'source <(palm completion bash)' >> ~/.bashrc` |
| zsh | `echo 'source <(palm completion zsh)' >> ~/.zshrc`, after `compinit` |
| fish | `palm completion fish > ~/.config/fish/completions/palm.fish` |

## Options

<!-- cli-reference:options completion -->

| Argument | Meaning |
| --- | --- |
| `shell` | bash, zsh or fish |

No options of its own. The [global options](/palm/reference/cli/#global-options) apply.

<!-- /cli-reference -->

## What it completes

The script completes verbs, aliases, utilities and the kind words of each verb.
It also completes each command's options and the target names after `--target`.
It is static: after an upgrade that adds a command, print it again.

## Behavior

`palm completion` prints to stdout, writes nothing and never prompts.

## Exit codes

| Code | When |
| --- | --- |
| `0` | The script printed. |
| `2` | No shell, or a shell other than `bash`, `zsh` and `fish`. |

## Related

- [CLI overview](/palm/reference/cli/)
