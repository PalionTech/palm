---
title: palm completion
description: Print a shell completion script for bash, zsh or fish.
---

`palm completion` prints a static completion script generated from palm's command tree.

```sh
palm completion bash|zsh|fish
```

| Command | What it does |
| --- | --- |
| `palm completion bash` | Print the bash script. |
| `palm completion zsh` | Print the zsh script. |
| `palm completion fish` | Print the fish script. |

Load it from your shell's startup file.

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

The script completes the verbs and their aliases, the utilities, each command's options, the kind words of `get` and `describe`, and the target names after `--target` and `--targets`.
It does not complete source names or entity names, because those need the network.
The script is static. After an upgrade that adds a command, print it again.

## Reads and writes

`palm completion` prints to stdout. It reads no file, writes nothing and never prompts.

## Exit codes

| Code | When |
| --- | --- |
| `0` | The script printed. |
| `2` | No shell, or a shell other than `bash`, `zsh` and `fish`. |

## Related

- [CLI overview](/palm/reference/cli/)
- [Installation](/palm/getting-started/install/#shell-completion)
