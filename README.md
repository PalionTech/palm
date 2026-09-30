# palm

[![npm](https://img.shields.io/npm/v/@paliontech/palm)](https://www.npmjs.com/package/@paliontech/palm)
[![CI](https://github.com/PalionTech/palm/actions/workflows/ci.yml/badge.svg)](https://github.com/PalionTech/palm/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

palm installs skills, subagents, instructions, hooks and MCP servers from git repositories into
the native files of six coding harnesses. You commit what it writes, a lock pins every source to a
commit, and `palm check` proves in CI that the committed files still match. Nothing that runs a
program lands without a review you can read, and your yes is pinned by hash.
Documentation: <https://paliontech.github.io/palm>.

## Install

```sh
npm install -g @paliontech/palm              # needs Node 22 or later and git
# or from source:
git clone https://github.com/PalionTech/palm && cd palm && npm ci && npm run build && npm link
```

## Quick start

The source comes first, as in `palm install <owner/repo> [names...]`.

```sh
palm init --target claude,codex              # palm.yaml with the harnesses for this project
palm install mattpocock/skills               # list what the repository offers; writes nothing
palm install mattpocock/skills tdd grill-me  # install two skills, declare the source in palm.yaml
palm install obra/superpowers plugin:superpowers   # every member of a plugin; its hook asks first
pbpaste | palm install mcp --snippet -       # an MCP server from the JSON snippet in its README
palm check                                   # read-only: palm.yaml, lock, files and sources agree
git add -A && git commit -m "Add agent setup"
```

A teammate's clone needs no palm run. The files are committed, and the harnesses read them.
`palm install` with no arguments makes the disk match `palm.yaml` and the lock, and `palm update`
moves sources to the newest commit their range allows.

## Commands

| Verb | Aliases | What it does |
|---|---|---|
| `init [--target ids] [--here]` | | Write `palm.yaml` with the detected or given targets, printing the evidence for each, and add `.palm/local/` and `palm.local.yaml` to `.gitignore`. `init -g --target ids` sets the global targets. |
| `install <source> [[kind:]name...] [--all]` | `add`, `i` | Without names, list what the source offers (`--grep text` filters it) and save nothing. With names or `--all`, render every entity for every target, declare the source in `palm.yaml` and pin it in the lock. `--all` leaves out hooks and stdio servers and prints the command for each. `--layout kind=glob` declares a layout with the source. |
| `install` | | Sync: make the disk match `palm.yaml` and the lock. Installs new entries, removes dropped ones, restores missing files, re-renders changed in-repo sources, keeps files you edited (exit 1). Offline when the cache holds every commit. |
| `install mcp <name> [flags]`, `install mcp --snippet <file or ->` | | Declare an MCP server from flags or from a README snippet, rendered into every harness. |
| `remove [source] <[kind:]name...> [--exclude]` | `uninstall`, `rm` | Delete exactly the files and merged entries the lock lists, and update both files. `--exclude` drops one plugin member for the team. |
| `update [sources...] [--to ref] [--dry-run] [--strict] [--review]` | `up` | Re-resolve refs within their ranges, print a plan with every changed entity and every new or changed program, ask (default no), then install. `--dry-run` is the outdated report, with the latest tag for pinned sources; `--strict` exits 1 when a source is behind and says why. |
| `check [--quiet] [--json]` | | Read-only CI gate. Fails when `palm.yaml`, the lock, the generated files or an in-repo source disagree, when an entry is partial, when a program is untrusted, when a tracked file or a merged harness config holds a secret, or when git ignores a generated file. Prints the fix for every problem, one line per entity. `--quiet` prints only what failed or warned. |
| `get [kind] [names...] [-s source] [--files]` | `list`, `ls` | What is installed, with source, ref, targets and file counts. `get sources`, `get targets` (with the project root), `get all`. |
| `describe [source] <[kind:]name or path>` | `info` | One entity: source, version, files per harness, notes, activation, program trust. With a source first, an entity that is not installed yet. Given a path, the entity that wrote it. `describe source <s>`, `describe target <t>`. |
| `create <kind> <name> [--in dir]` | `new` | Write a template skill, agent, instruction or hook into `./agent-kit`, declare it in `palm.yaml`, install it. No prompts, no editor. |

Utilities: `palm migrate` (palm 0.1 files to 0.2; removed in 0.3), `palm completion bash|zsh|fish`,
`palm cache clean`.

Global flags: `-g`, `--dry-run`, `--force`, `-y/--yes` (never consents to a program),
`--allow-exec <kind:name@source=sha256:hash,...>`, `--offline`, `--json`,
`--secrets env-ref|literal`. Colour follows the terminal, and `NO_COLOR` turns it off.

## Files

| File | Holds | Commit it |
|---|---|---|
| `palm.yaml` | targets; sources with `ref:`; entries with filters; hand-declared MCP servers | yes |
| `palm.lock.yaml` | per source the URL, range, resolved tag and commit; per entry one content hash, one render hash per target, the file list, merged-entry identities, program hashes and trust | yes |
| generated files | every harness file palm wrote | yes |
| `.palm/assets/<source>/<entity>/` | the scripts hooks and stdio MCP servers run | yes |
| `.palm/local/`, `palm.local.yaml` | reserved for personal additions in 0.3 | no, ignored |
| `~/.palm/palm.yaml`, `~/.palm/palm.lock.yaml` | the global scope (`-g`), same format, paths as tokens such as `<claude>/skills/x` | your dotfiles, if you like |
| `~/.palm/applied.yaml`, `~/.palm/cache/` | what `-g` wrote on this machine; checkouts and indexes | never |

```yaml
# palm.yaml
targets: [claude, cursor]

sources:
  mattpocock/skills:                    # GitHub shorthand: the name is owner/repo
    ref: ^1.2                           # tag, branch, sha or range: the one home of version intent
    skills: [tdd, handoff]
  obra/superpowers:
    ref: ^4
    plugins:
      - name: superpowers
        exclude: [skill:brainstorming]
  ./agent-kit:                          # in-repo source, rendered from the working tree
    skills: [release-notes]

mcp:
  docs:
    url: https://example.com/mcp
    headers: { Authorization: "Bearer ${DOCS_TOKEN}" }
```

The lock holds no absolute path, hostname, timestamp or secret, so a newcomer's lock equals a
veteran's. Edits are detected against the render hash, so palm never overwrites or deletes a file
you changed without `--force`, and a pull that moves the lock is an upgrade, not "your edits".

## Where files go

Project scope, per target. `-g` writes the user-level equivalents under your home directory
(`$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, `$COPILOT_HOME`, `$GEMINI_CLI_HOME` and `$XDG_CONFIG_HOME`
are honoured).

| kind | claude | codex | copilot |
|---|---|---|---|
| skill | `.claude/skills/<n>/` | `.agents/skills/<n>/` | `.agents/skills/<n>/` |
| agent | `.claude/agents/<n>.md` | `.codex/agents/<n>.toml` | `.github/agents/<n>.agent.md` |
| instruction | `.claude/rules/<n>.md` | block in `AGENTS.md` | `.github/instructions/<n>.instructions.md` |
| hook | merged into `.claude/settings.json` | merged into `.codex/hooks.json` | `.github/hooks/<n>.json` |
| mcp | `.mcp.json` | `.codex/config.toml` | `.vscode/mcp.json` |

| kind | cursor | gemini (unverified) | opencode (unverified) |
|---|---|---|---|
| skill | `.claude/skills/<n>/` with claude, else `.agents/skills/<n>/` | `.agents/skills/<n>/` | `.agents/skills/<n>/` |
| agent | `.cursor/agents/<n>.md` | `.gemini/agents/<n>.md` | `.opencode/agents/<n>.md` |
| instruction | `.cursor/rules/<n>.mdc` (project only) | block in `GEMINI.md` | `.opencode/instructions/<n>.md` + `opencode.json` |
| hook | merged into `.cursor/hooks.json` | merged into `.gemini/settings.json` | skipped with a note |
| mcp | `.cursor/mcp.json` | `.gemini/settings.json` | `opencode.json` |

`.agents/skills` is written once. A command file in a source installs as a skill. Hook scripts go
to `.palm/assets/<source>/<entity>/` and commands reach them through each harness's project folder
variable, such as `"$CLAUDE_PROJECT_DIR"`, never an absolute path. Gemini CLI and OpenCode follow
their documentation and source and have not yet run against a live CLI in palm's tests.

## Sources

A source is a git repository (optionally a folder at a ref) or a directory inside the project,
declared in `palm.yaml`. There is no per-user registry, so a clone carries everything it needs.
`palm install` accepts `owner/repo`, `owner/repo/sub/dir`, `github:owner/repo`, any `https://`,
`ssh://` or `user@host:path` URL with an optional `#ref`, and `./dir`. On the first install from a
source, palm declares it with a caret range on the newest tag, or the default branch by name, and
says so. `palm update` moves the commit within the range, and `palm update --to <ref>` moves the
range. An in-repo source such as `./agent-kit` is rendered from the working tree. A bare install
re-renders what changed, and `palm check` fails on drift.

palm reads repositories as they are published: Claude Code, Cursor and Codex plugins,
marketplaces, APM packages and plain `SKILL.md` folders. A `layout:` on the source overrides
detection when a repository needs it.

## MCP servers

An MCP server is declared once and rendered into every target's file and syntax, with environment
references instead of secrets. Four ways in, none of them a registry:

- `palm install <source> mcp:<name>` takes a server a source ships in its `.mcp.json`.
- `pbpaste | palm install mcp --snippet -` reads the JSON snippet from the server's README.
- `palm install mcp docs --url https://example.com/mcp --header 'Authorization=Bearer ${DOCS_TOKEN}'`
  declares a remote server by flags, and
  `palm install mcp xcodebuild --command npx --arg -y --arg xcodebuildmcp@latest` a stdio one.
- An entry you write under `mcp:` in `palm.yaml` installs with a bare `palm install`.

## Consent

Hooks and stdio MCP servers run programs on your machine. Before palm writes one, it prints the
source and commit, every command as each harness will run it, the files it lands in, and every
script with its mode, size and hash. `v` pages the script bodies, and on update `d` pages a diff.

- The default answer is no, and `--yes` never consents.
- Your yes is a hash over the commands and every script byte, recorded as `trust:` in the lock.
  Teammates and CI replay it silently; any change asks again. The scripts of an in-repo source
  and the files a script reads are hashed too. The hash pins `npx -y <package>` as text, not the
  package npx downloads, so pin a version in the command.
- `install <source> --all` leaves programs out without asking. Declining a plugin's hook writes
  `exclude: [hook:<name>]` on the plugin entry in `palm.yaml`; declining a program you named exits 130.
- Without a terminal, palm stops with `E_UNTRUSTED_EXEC` and prints the exact
  `--allow-exec hook:gh-cli@trailofbits/skills=sha256:a7cc7911f2bd0a61d9686cbc62fcfb17c8e8276fa2ea5aa0c69e646a0b23ad60`
  line to consent: the full hash (a prefix of at least 16 hex digits is accepted).
- palm refuses hidden Unicode (bidi overrides, tag characters) in any file of an entity, including
  hook scripts, and refuses a hook command that names a script the source does not have.
- palm never runs what it installs.

## Secrets

- A literal secret that arrives from a source or a pasted snippet is never written. palm writes
  `${NAME}`, in each harness's syntax, and names the variable to export.
- A value you type with `--env K=V` or `--header K=V` becomes `${K}`, and palm prints the
  `export` line; the value is stored nowhere. So does a README placeholder such as `YOUR_API_KEY`.
- Only `--secrets literal` writes a value, recorded as `secrets: literal` on the entry. palm warns
  when git would commit the destination (inside a worktree and not ignored). Under `-g`, a literal
  is written only outside every git worktree, into a file with mode `0600`, and `--force` does not
  change that.
- The index and the lock store redacted hashes, never values.
- `palm check` fails on a literal in a tracked file, including harness configs palm merges into,
  and lists every variable the installed servers need and whether it is set.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success; warnings never change it |
| 1 | a refusal, a failed or partial install, a modified file palm kept, a failed check |
| 2 | usage error, including a removed 0.1 command or a 0.1 `palm.yaml` (run `palm migrate`) |
| 130 | cancelled: Ctrl-C, a declined program you named, a declined new version of a trusted program, or a declined ref change |

## How palm differs from Microsoft APM

- Sources and entries live in `palm.yaml` with one `ref:` per source, and palm installs from
  repositories as they are: plugins, marketplaces, APM packages (`apm.yml`) and plain skill folders.
- palm writes each harness's native format (Codex `.toml` agents, Copilot `.agent.md`, Cursor
  `.mdc` rules) and merges hooks and MCP servers into its config. There is no compile step.
- The generated files are committed, and `palm check` recomputes each one from the lock in CI.
- Consent for hooks and stdio servers is shown, default no, and pinned by hash in the lock; a
  changed script asks again.
- palm follows no dependencies. An APM package's `dependencies:` and an agent's skills are listed
  with the command that installs them.
- MCP servers come from a source, a README snippet, flags or `palm.yaml`, never a registry, and a
  literal secret from a source is never written.

## What palm does not do

- palm does not run on native Windows. macOS and Linux are supported; on Windows, run palm inside
  WSL. Contributors who only use the harnesses need no palm, since the generated files are committed.
- palm sends no telemetry and checks for no updates. It talks to the git hosts of the sources you
  declare and nothing else.
- palm has no registry and no search. You name the repository, and `palm install tdd` fails with
  the command that works.

## Links

[Documentation](https://paliontech.github.io/palm) · [CONCEPTS.md](CONCEPTS.md) · [DESIGN.md](DESIGN.md) ·
[CONTRIBUTING.md](CONTRIBUTING.md) (run `npm run verify` before every commit) · [SECURITY.md](SECURITY.md)
