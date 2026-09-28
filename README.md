# palm

[![npm](https://img.shields.io/npm/v/@paliontech/palm)](https://www.npmjs.com/package/@paliontech/palm)
[![CI](https://github.com/PalionTech/palm/actions/workflows/ci.yml/badge.svg)](https://github.com/PalionTech/palm/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

palm is a package manager for agent resources. It installs skills, subagents, instructions,
commands, hooks, MCP servers and plugins from git repositories into the native files of six
coding harnesses, records every file it wrote in a lockfile, and removes them again cleanly.
Documentation: <https://paliontech.github.io/palm>.

## Install

```sh
npm install -g @paliontech/palm              # needs Node 22 or later and git
# or from source:
git clone https://github.com/PalionTech/palm && cd palm && npm ci && npm run build && npm link
```

## Quick start

Every command has the same shape: `palm <verb> [kind] [names...] [flags]`.

```sh
palm install origin mattpocock/skills        # a repository becomes an origin (alias: mattpocock)
palm get skills --available                  # what your origins offer
palm search tdd                              # search every origin and the MCP registry
palm install skill tdd                       # several origins have it: a picker asks which one
palm install skill tdd@mattpocock            # name@origin picks directly (no terminal needed)
palm install plugin superpowers -g           # -g: into your home directory instead of the project
palm install agent comment-sicko             # plus the skills and MCP servers the agent names
palm install mcp io.github.upstash/context7  # from the MCP registry
palm get                                     # what is installed here
palm install                                 # on another machine: install what palm.yaml lists
palm uninstall skill tdd
```

Without a terminal an ambiguous name stops with `E_AMBIGUOUS`, listing the `name@origin` forms.

## Commands

| Verb | Aliases | What it does |
|---|---|---|
| `install [kind] <name[@origin][#ref]>...` | `add`, `i` | Install entities. With no names, install what `palm.yaml` lists (`--prune` removes extras, `--frozen` fails on any difference from the lockfile and writes nothing, for CI). `install origin <spec>` registers an origin. |
| `uninstall [kind] <name>...` | `remove`, `rm`, `delete` | Remove entities, reverse merged config, drop dependencies nothing else needs. `uninstall origin <alias>` unregisters one. |
| `get [kind] [name...]` | `list`, `ls` | What is installed. `--available` lists what origins offer; `get origins`, `get targets`, `get all`. |
| `describe <kind> <name>` | `info` | One entity, origin (`describe origin <alias>`) or target (`describe target <id>`). |
| `update [kind] [name...]` | `up` | Prints a plan (`~` updated, `+` added, `-` removed, `=` unchanged, files you edited), then asks once. That one confirmation also covers the hook and stdio MCP commands the update writes. `--yes` for scripts, `--dry-run` for the plan only. `update origins` refreshes indexes. |
| `create <kind> [name]` | `new` | Write a skill, agent, instruction or command into your local `mine` origin, then install it. |
| `search [kind] <query>` | | Search names and descriptions across origins and the MCP registry. |

| Utility | What it does |
|---|---|
| `palm init` | Write `palm.yaml` with the targets for this project. |
| `palm doctor` | Check git, Node, harness directories, lockfile drift and origin reachability. |
| `palm config get\|set <key> [value]` | Global settings: `targets`, `secrets.project`, `secrets.global`, `mcpRegistryUrl`. |
| `palm outdated [kind]` | Current, wanted and latest ref per installed entry. |
| `palm why <kind> <name>` | Who pulled an entity in, and what still needs it. |
| `palm find <path>` | Which entity wrote a file. |
| `palm audit [kind] [names...]` | Scan installed files for hidden Unicode and edits; `--strip` removes the characters. |
| `palm completion bash\|zsh\|fish` | Print a shell completion script. |
| `palm cache info\|clean` | Size of the origin cache, or remove it. |

Kinds: `skill` (`sk`), `agent` (`ag`), `instruction` (`ins`), `command` (`cmd`), `hook` (`hk`),
`mcp`, `plugin` (`pl`), `origin` (`orig`), `target` (`tg`), and `all` for `get`. Plurals work.

Global flags: `-g`, `-t/--target <ids>`, `--dry-run`, `--force` (overwrite files palm does not
own or you changed), `-y/--yes`, `--offline`, `--verbose`, `--json`, `--no-color`.

## Where files go

Project scope, per target. `-g` writes the user-level equivalents under your home directory
(`$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, `$COPILOT_HOME`, `$GEMINI_CLI_HOME` and `$XDG_CONFIG_HOME`
are honoured).

| kind | claude | codex | copilot |
|---|---|---|---|
| skill | `.claude/skills/<n>/` | `.agents/skills/<n>/` | `.agents/skills/<n>/` |
| agent | `.claude/agents/<n>.md` | `.codex/agents/<n>.toml` | `.github/agents/<n>.agent.md` |
| instruction | `.claude/rules/<n>.md` | block in `AGENTS.md` | `.github/instructions/<n>.instructions.md` |
| command | `.claude/commands/<n>.md` | `~/.codex/prompts/<n>.md` (global only) | `.github/prompts/<n>.prompt.md` (project only) |
| hook | merged into `.claude/settings.json` | merged into `.codex/hooks.json` | `.github/hooks/<n>.json` |
| mcp | `.mcp.json` | `.codex/config.toml` | `.vscode/mcp.json` |

| kind | cursor | gemini | opencode |
|---|---|---|---|
| skill | `.agents/skills/<n>/` | `.agents/skills/<n>/` | `.agents/skills/<n>/` |
| agent | `.cursor/agents/<n>.md` | `.gemini/agents/<n>.md` | `.opencode/agents/<n>.md` |
| instruction | `.cursor/rules/<n>.mdc` (project only) | block in `GEMINI.md` | `.opencode/instructions/<n>.md` + `opencode.json` |
| command | `.cursor/commands/<n>.md` | `.gemini/commands/<n>.toml` | `.opencode/commands/<n>.md` |
| hook | merged into `.cursor/hooks.json` | merged into `.gemini/settings.json` | not supported (skipped with a note) |
| mcp | `.cursor/mcp.json` | `.gemini/settings.json` | `opencode.json` |

The shared `.agents/skills` directory is written once. Claude Code does not read it, so skills
for Claude also go to `.claude/skills`. Hook scripts are copied to `.palm/hooks/<n>/` (gitignored
by `palm init`) or `~/.palm/hooks/<n>/`.

## palm.yaml and palm.lock.yaml

`palm.yaml` lists what you asked for. Commit it.

```yaml
targets: [claude, codex]
skills:
  - tdd@mattpocock
plugins:
  - superpowers@superpowers
mcp:
  - name: context7
    registry: io.github.upstash/context7
```

`palm.lock.yaml` records what palm wrote. Commit it too.

```yaml
version: 2
entries:
  - kind: skill
    name: tdd
    origin: mattpocock
    ref: v1.2.3
    sha: 6acc160…
    contentHash: sha256:…
    transform: 1                 # rendering version; a newer palm re-renders older entries
    targets: [claude, codex]
    files:
      - { path: .claude/skills/tdd/SKILL.md, hash: "sha256:…" }
```

The lock has no timestamps, so the same install gives the same file on every machine. Each file
carries the hash palm wrote: palm refuses to overwrite or delete a file you changed since then,
unless you pass `--force`. A bare `palm install` deploys the locked commit, not the newest tag.

## Targets

palm picks targets in this order: `--target claude,codex`, `targets:` in `palm.yaml`, `targets`
in `~/.palm/config.yaml`, the harness directories it finds, then a picker. At project scope the
first install saves the result to `palm.yaml`, so the next developer gets the same harnesses. At
global scope palm saves `targets` to `config.yaml` only when you pass `--target` or run
`palm config set targets claude,codex`; detected targets are never saved there. `palm get targets`
shows the result and where it came from.

## Origins

An **origin** is a git repository (optionally a subdirectory, at a ref) or a local directory.
`palm install origin` accepts `owner/repo`, `owner/repo/sub/dir`, `github:owner/repo`, any
`https://` or `git@` URL with an optional `#ref`, a local path, or a `marketplace.json` (each
plugin it lists becomes an origin). palm fetches and indexes the origin before it saves it, so a
typo is reported and never stored. Without a ref palm uses the latest semver tag, else the
default branch; `#^1.2` style ranges resolve against the tags. The alias is the repository name,
or the owner when the name is generic (`mattpocock/skills` becomes `mattpocock`).

palm detects the layout: APM packages, marketplaces, plugin manifests, then conventions
(`**/SKILL.md`, `agents/*.md`, `*.instructions.md`, `rules/*.mdc`, `hooks/hooks.json`,
`.mcp.json`). When a repository needs help, give it a layout descriptor:

```sh
palm install origin openai/skills --alias openai-curated --layout 'skills=skills/.curated/*'
```

palm stores it with the origin in `~/.palm/config.yaml` as
`layout: { skills: ["skills/.curated/*"] }` (other keys: `agents`, `commands`, `instructions`,
`hooks`, `mcp`, `exclude`, `include`, `nameFrom`).

## Secrets in MCP servers

`${VAR}` placeholders in an MCP server's env, headers, URL or args are secrets.

- Project scope (default `env-ref`): palm writes each harness's own environment reference and
  tells you which variables to export. No secret value lands in a project file.
- Global scope (default `literal`): palm reads the value from your environment or asks for it
  (masked) and writes it into the user-level config, created with mode 0600.
- `--secrets env-ref|literal` overrides the default for one run; `palm config set secrets.project
  literal` changes it for good. The lockfile only ever holds the `${VAR}` placeholder.

## Consent and safety

Before palm writes a hook or a stdio MCP server, it lists every command it would allow to run
and asks once. Without a terminal it needs `--yes`; `--dry-run` lists them without asking. Text
entities (skills, agents, instructions, commands) are never gated. palm refuses entities that
contain hidden Unicode such as bidi overrides or tag characters; inspect them with `palm audit`,
remove them with `palm audit --strip`, or install anyway with `--force`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | failure, including an install where one target failed |
| 2 | usage error |
| 70 | internal error (`--verbose` prints the stack trace) |
| 130 | cancelled at a prompt |

## How palm differs from Microsoft APM

- palm installs repositories as they are: Claude, Cursor and Codex plugin repos, marketplaces and
  plain skill collections, as well as APM packages (`apm.yml`).
- palm writes each harness's native format (Codex `.toml` agents, Copilot `.agent.md`, Cursor
  `.mdc` rules) and merges hooks and MCP servers into its config; there is no compile step.
- Installing an agent installs the skills, MCP servers and instructions it names; uninstalling it
  removes them unless something else still needs them.
- MCP servers come from origins, the official MCP registry or ad hoc definitions, with a secret
  policy per scope.
- Project and global scope use the same commands (`-g`), and `palm create` writes to a local `mine`
  origin.

## What palm does not do

- Windows: untested; macOS and Linux are supported.
- Telemetry: none, and no update check. Network calls go only to your origins and the MCP registry.
- A central registry: origins are git repositories you pick; the MCP registry is for MCP servers.

## Links

[Documentation](https://paliontech.github.io/palm) ·
[CONCEPTS.md](CONCEPTS.md) (resources per harness) · [DESIGN.md](DESIGN.md) (architecture) ·
[CONTRIBUTING.md](CONTRIBUTING.md) (development; run `npm run verify` before every commit) ·
[SECURITY.md](SECURITY.md) (reporting a vulnerability)
