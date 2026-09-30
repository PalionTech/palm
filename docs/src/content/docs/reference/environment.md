---
title: Environment variables
description: Every variable palm reads, what it changes, and the list palm passes on to git.
---

palm reads variables for its own home, the harness homes, debugging and colour.
It passes a short allow list on to git.

```sh
PALM_HOME=~/work/.palm palm get -g
CODEX_HOME=~/codex-work palm install mattpocock/skills tdd -g
```

| Variable | Effect |
| --- | --- |
| `PALM_HOME` | palm's own folder. The default is `~/.palm`. |
| `HOME` | Your home directory: the root of the global scope. |
| `CLAUDE_CONFIG_DIR` | Replaces `~/.claude` in global scope. Global MCP servers go to `$CLAUDE_CONFIG_DIR/.claude.json`. |
| `CODEX_HOME` | Replaces `~/.codex` in global scope. |
| `COPILOT_HOME` | Replaces `~/.copilot` in global scope. |
| `GEMINI_CLI_HOME` | Replaces the home Gemini CLI resolves `.gemini` against, so `~/.gemini` becomes `$GEMINI_CLI_HOME/.gemini`, and global skills go to `$GEMINI_CLI_HOME/.gemini/skills/`. |
| `XDG_CONFIG_HOME` | `~/.config/opencode` becomes `$XDG_CONFIG_HOME/opencode`. git also reads it for its global config. |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS` | Set to `1` or `true`: skills for OpenCode go to `.opencode/skills/` and `~/.config/opencode/skills/` instead of `.agents/skills/`. |
| `PALM_DEBUG` | Set to `1`: debug lines on stderr, git's own error text, and every index warning in full. There is no `--verbose`. |
| `NO_COLOR` | Set to any value: no colour. |
| `PAGER` | The pager for script bodies and diffs at the consent prompt, and for `palm update --review`. |
| `GIT_SSH_COMMAND`, `GIT_SSH` | The ssh program git uses. See [git](#git). |
| MCP secrets | Each `${NAME}` in an MCP server or hook. See [MCP secrets](#mcp-secrets). |

## `PALM_HOME`

| Path | Holds |
| --- | --- |
| `palm.yaml`, `palm.lock.yaml` | The global scope's manifest and lock. The lock uses tokens for harness homes, so both files can live in a dotfiles repository. |
| `applied.yaml` | This machine's record of what the global scope wrote, with real paths. Never commit it. |
| `assets/<source>/<entity>/` | Scripts that global hooks and MCP servers run. |
| `kit/` | The in-repo source for `palm create -g`, declared as `./kit` in `~/.palm/palm.yaml`. |
| `cache/` | One checkout per source commit, and index files. Mode `0700`. Safe to delete. |
| `lock` | An advisory lock while a global command runs. |

A project has its own advisory lock at `.palm/lock` while palm runs, so two palm processes on one scope wait for each other.
palm removes the lock file when it exits, also after Ctrl-C.
There is no `~/.palm/config.yaml` in palm 0.2.

## Harness homes

The overrides apply to the global scope only. Project files always go under the project root.
palm treats each override as a boundary, and never writes or deletes outside your home, `PALM_HOME` and the harness homes.
The reverse holds too: `PALM_HOME` and every harness home refuse project scope, and the error names the command with `-g`.
Each home has a token in the global lock, such as `<claude>` or `<codex>`, so the lock stays portable.
`palm describe target <target> -g` prints the paths with every override applied.

## Colour and prompts

Colour appears only when stdout is a terminal, and `NO_COLOR` turns it off.
palm prompts only when stdin and stdout are terminals. Otherwise every question it needs answered stops the command with an error that names the flag.

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
For an ssh remote, palm uses your `core.sshCommand` or `ssh` with `-o BatchMode=yes`, and appends that option to a `GIT_SSH_COMMAND` that runs OpenSSH without one.
`GIT_SSH` passes unchanged.

palm drops these variables, so a palm run from a git hook never touches the hook's repository.

`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_COMMON_DIR`, `GIT_CEILING_DIRECTORIES`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_ASKPASS`, `SSH_ASKPASS`.

Inside a project, palm runs only read-only git commands: `git ls-files`, `git check-ignore` and `git rev-parse --show-toplevel`, for `palm check` and the secrets rules.

## MCP secrets

Each `${NAME}` in an MCP server's `env`, headers, URL or arguments is a reference.
palm writes the reference in each harness's syntax and lists the variables to export. `palm check` prints one warning line per server whose variables are not set.
A value you type with `--env K=V` is written as `${K}` too, and palm prints the `export` line instead of storing the value.
Under `--secrets literal`, palm reads `NAME` from the environment, and asks for it with a masked prompt only on a terminal.
See [Secrets](/palm/concepts/secrets/).

## Related

- [Project and global scope](/palm/concepts/scopes/)
- [Targets matrix](/palm/reference/targets-matrix/#harness-homes)
- [Security model](/palm/explanation/security/)
