---
title: Environment variables
description: Every variable palm reads, what it changes, and which one wins.
---

palm reads variables for its own home, the harness homes, prompts and colour.
It passes a short list on to git.

```sh
PALM_HOME=~/work/.palm palm get origins
CODEX_HOME=~/codex-work palm install skill tdd -g --target codex
```

| Variable | Effect |
| --- | --- |
| `PALM_HOME` | palm's own folder. The default is `~/.palm`. |
| `HOME` | Your home directory: the root of the global scope. When `HOME` is unset, palm reads `USERPROFILE`. |
| `CLAUDE_CONFIG_DIR` | Replaces `~/.claude` in global scope. Global MCP servers go to `$CLAUDE_CONFIG_DIR/.claude.json`. |
| `CODEX_HOME` | Replaces `~/.codex` in global scope. |
| `COPILOT_HOME` | Replaces `~/.copilot` in global scope. |
| `GEMINI_CLI_HOME` | Replaces the home that Gemini CLI resolves `.gemini` against: `~/.gemini` becomes `$GEMINI_CLI_HOME/.gemini`. |
| `XDG_CONFIG_HOME` | `~/.config/opencode` becomes `$XDG_CONFIG_HOME/opencode`. git also reads it for its global config. |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS` | Set to `1` or `true`: skills for OpenCode go to `.opencode/skills/` and `~/.config/opencode/skills/` instead of `.agents/skills/`. |
| `VISUAL`, `EDITOR` | The editor `palm create` opens the new file in. `VISUAL` wins. |
| `CI` | Set to anything but empty, `0` or `false`: palm never prompts. Any non-empty value also turns colour on. |
| `NO_COLOR` | Set to any non-empty value: no colour. |
| `FORCE_COLOR` | Set to any non-empty value: colour without a terminal. |
| `TERM` | `dumb`: no colour in a terminal. |
| `GIT_SSH_COMMAND`, `GIT_SSH` | The ssh program git uses. See [git](#git). |
| MCP secrets | Each `${NAME}` in an MCP server definition. See [MCP secrets](#mcp-secrets). |

## `PALM_HOME`

| Path | Holds |
| --- | --- |
| `config.yaml` | Your origins, default targets and secret policies. See [config.yaml](/palm/reference/config-yaml/). |
| `palm.yaml`, `palm.lock.yaml` | The manifest and lockfile of the global scope. |
| `cache/` | One checkout per origin and ref, and one index file per origin, ref and layout. |
| `mine/` | The local origin `palm create` writes to. |
| `hooks/<name>/` | Hook scripts for global installs. |

`~` in `PALM_HOME` expands, and a relative value resolves against your home directory.

## Harness homes

The overrides apply to the global scope only; project files always go under the project root.
palm treats each override as a boundary: it never deletes a lockfile path outside the project, your home, `PALM_HOME` and the harness homes.
`palm describe target <target> -g` prints the paths with every override applied.

## Prompts and colour

palm prompts only when stdin and stdout are terminals and `CI` is unset, empty, `0` or `false`.
For colour, the first match wins:

1. `--no-color`, or a non-empty `NO_COLOR`: no colour.
2. A non-empty `FORCE_COLOR`: colour.
3. A terminal whose `TERM` is not `dumb`, or a non-empty `CI`: colour.
4. Otherwise, no colour.

## git

palm runs git with a clean environment built from an allow list.
Everything else, including tokens and variables such as `GIT_DIR`, stays out of git's environment.

| Passed to git | Variables |
| --- | --- |
| Paths and locale | `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LANGUAGE`, `LC_*`, `TMPDIR`, `XDG_CONFIG_HOME` |
| ssh | `SSH_AUTH_SOCK`, `GIT_SSH`, `GIT_SSH_COMMAND` |
| git config | `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM` |
| Proxies | `http_proxy`, `https_proxy`, `all_proxy`, `no_proxy`, and their upper-case forms |
| Certificates | `GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`, `SSL_CERT_FILE`, `SSL_CERT_DIR` |

palm adds `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`, so git never asks for a password.
For an ssh remote, palm appends `-o BatchMode=yes` to `GIT_SSH_COMMAND` when it runs OpenSSH without a BatchMode setting.
Without `GIT_SSH_COMMAND`, it uses your git `core.sshCommand`, or `ssh`, with the same option.
`GIT_SSH` passes unchanged.

palm drops these variables, so a palm run from a git hook never touches the hook's repository:

`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_CEILING_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_CONFIG`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_ASKPASS`, `SSH_ASKPASS`.

## MCP secrets

Each `${NAME}` in an MCP server's `env`, headers, URL or arguments is a secret.
Under the `env-ref` policy, the default in project scope, palm writes a reference and lists the variables to export.
Under the `literal` policy, the default with `-g`, palm reads `NAME` from the environment.
It asks for the value only when `NAME` is unset.
Without a terminal, a required secret that is unset fails with `E_NON_INTERACTIVE`.

## Related

- [config.yaml](/palm/reference/config-yaml/)
- [Project and global scope](/palm/concepts/scopes/)
- [Targets matrix](/palm/reference/targets-matrix/#harness-homes)
