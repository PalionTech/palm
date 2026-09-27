# palm

palm installs agent resources (skills, subagents, instructions, commands, hooks,
MCP servers and whole plugins) from git repositories into the places Claude Code,
Codex, GitHub Copilot and Cursor read them from. One command writes the right file
in the right format for every harness you use, records what it wrote in a lockfile,
and removes it again cleanly.

- [DESIGN.md](DESIGN.md): architecture and the full contract (paths, scan rules, install flow).
- [CONCEPTS.md](CONCEPTS.md): what skills, agents, plugins, hooks and MCP servers are, per harness.

## Install

Requires Node 22+ and git.

```sh
npm install && npm run build && npm link   # from a checkout; or: npm i -g .
palm --version
```

## Quick start

```sh
palm origin add mattpocock/skills           # a repo becomes an origin (alias: mattpocock)
palm origin add cursor/plugins/pstack --alias pstack
palm search tdd                              # find things across all origins
palm install skill tdd@mattpocock            # into every harness detected in this project
palm install skill unslop -g                 # -g: into your home directory instead
palm install skill tdd                       # several origins have it: a picker (E_AMBIGUOUS without a terminal)
palm install plugin superpowers              # all of a plugin's skills, agents, hooks, MCP servers
palm install agent comment-sicko             # plus the skills and MCP servers the agent names
palm install mcp io.github.upstash/context7  # from the MCP registry
palm install mcp fs -- npx -y @modelcontextprotocol/server-filesystem .
palm install mcp docs --url https://example.com/mcp --header 'Authorization=Bearer ${DOCS_TOKEN}'
palm create agent                            # wizard: writes it into your "mine" origin, then installs it
palm install                                 # later, or on another machine: install what palm.yaml lists
palm uninstall plugin superpowers
```

palm works out the targets in this order: `--target claude,codex` (saved to
`palm.yaml` / the global config), `targets:` in `palm.yaml`, the global default,
the harness directories it finds (`.claude/`, `.codex/` or `AGENTS.md`,
`.github/copilot-instructions.md`, `.cursor/`), then a prompt.

## Commands

| Command | What it does |
|---|---|
| `palm install [kind] <name[@origin][#ref]>...` (`i`, `add`) | Install entities; with no arguments install everything in `palm.yaml` (redeploying files deleted by hand; `--prune` removes extras). |
| `palm uninstall [kind] <name>...` (`remove`, `rm`) | Remove entities, reverse merged config, drop dependencies nothing else needs. |
| `palm list [kind]` (`ls`) | What is installed; `--available` lists what your origins offer. |
| `palm search <query> [--kind k] [--origin o]` | Search names and descriptions; `--kind mcp` also searches the MCP registry. |
| `palm info <kind> <name[@origin]>` | Origin, version, dependencies, files per harness. |
| `palm update [kind] [name]...` (`up`) | Refetch origins, reinstall what changed; `--dry-run` shows the plan. |
| `palm origin add\|list\|remove\|update\|import` | Manage origins; `import` expands a `marketplace.json`. |
| `palm create agent\|skill\|instruction\|command [name]` (`new`) | Author a new entity in `~/.palm/mine`, then install it. |
| `palm init` | Write `palm.yaml` (targets) for this project. |
| `palm targets` | Which harnesses are active, and why. |
| `palm config get\|set <key> [value]` | Global settings: `targets`, `secrets.project`, `secrets.global`, `mcpRegistryUrl`. |
| `palm doctor` | Check git, Node, harness dirs, lockfile drift and origin reachability. |

Global flags: `-g/--global`, `-t/--target`, `--dry-run`, `--force` (overwrite files
palm does not own), `-y/--yes`, `--offline` (cache only), `--verbose`, `--json`
(errors too: `{ "error": { "code", "message", "hint" } }`).

Kinds accept plurals (`palm install skills a b`). Without a kind, palm searches all kinds.

## Where things go

Project scope writes under the project root; `-g` writes under your home directory
(`~/.claude` honours `$CLAUDE_CONFIG_DIR`, `~/.codex` honours `$CODEX_HOME`).

| kind | claude | codex | copilot | cursor |
|---|---|---|---|---|
| skill | `.claude/skills/<n>/` | `.agents/skills/<n>/` | `.agents/skills/<n>/` | `.agents/skills/<n>/` |
| agent | `.claude/agents/<n>.md` | `.codex/agents/<n>.toml` | `.github/agents/<n>.agent.md` · `~/.copilot/agents/` | `.cursor/agents/<n>.md` |
| instruction | `.claude/rules/<n>.md` | managed block in `AGENTS.md` · `~/.codex/AGENTS.md` | `.github/instructions/<n>.instructions.md` | `.cursor/rules/<n>.mdc` (project only) |
| command | `.claude/commands/<n>.md` | `~/.codex/prompts/<n>.md` (global only) | `.github/prompts/<n>.prompt.md` (project only) | `.cursor/commands/<n>.md` |
| hook | merged into `.claude/settings.json` | merged into `.codex/hooks.json` | `.github/hooks/<n>.json` · `~/.copilot/hooks/` | merged into `.cursor/hooks.json` |
| mcp | `.mcp.json` · `~/.claude.json` | `.codex/config.toml` `[mcp_servers.<n>]` | `.vscode/mcp.json` (`servers`) · `~/.copilot/mcp-config.json` | `.cursor/mcp.json` |

The shared `.agents/skills` directory is written once for codex, copilot and cursor.
Claude Code does not read it, so skills for Claude also go to `.claude/skills`. Hook
scripts are copied to `.palm/hooks/<n>/` (add `.palm/` to `.gitignore`; `palm init`
does) or `~/.palm/hooks/<n>/`.

## palm.yaml and palm.lock.yaml

`palm.yaml` lists what you asked for; commit it.

```yaml
targets: [claude, codex]
skills:
  - tdd@mattpocock
  - unslop@pstack
agents:
  - comment-sicko@pstack
plugins:
  - superpowers@superpowers
mcp:
  - name: context7
    registry: io.github.upstash/context7
  - name: docs
    transport: http
    url: https://example.com/mcp
    headers: { Authorization: "Bearer ${DOCS_TOKEN}" }
```

`palm.lock.yaml` records every file and merged config entry palm wrote, the commit
it came from and a content hash. Dependencies carry `via` (who pulled them in);
plugins and agents carry `deps` (what they declared). Removing an agent removes the
skills it pulled in unless another installed entry still lists them.

```yaml
version: 1
entries:
  - kind: skill
    name: tdd
    origin: mattpocock
    url: https://github.com/mattpocock/skills.git
    ref: v1.2.3
    sha: 6acc160…
    path: skills/engineering/tdd
    contentHash: sha256:…
    targets: [claude, codex]
    files:
      - .claude/skills/tdd/SKILL.md
      - .agents/skills/tdd/SKILL.md
```

## Origins

An origin is a git repository (optionally a subdirectory, at a ref) or a local
directory. `palm origin add` accepts `owner/repo`, `owner/repo/sub/dir`,
`github:owner/repo`, any `https://` or `git@` URL with an optional `#ref`, a local
path, or a `marketplace.json` (same as `palm origin import`). Without a ref palm
uses the latest semver tag, else the default branch. The alias defaults to the repo
name, or the owner when the repo name is generic (`mattpocock/skills` →
`mattpocock`).

palm scans each origin and figures out its layout: APM packages (`apm.yml`),
marketplaces (`.claude-plugin/marketplace.json` and friends), plugin manifests,
then plain conventions (`**/SKILL.md`, `agents/*.md`, `*.instructions.md`,
`rules/*.mdc`, `hooks/hooks.json`, `.mcp.json`). Dot directories are included, so
`openai/skills` (`skills/.curated/*`) works as is. When a repo needs help, give it a
layout descriptor:

```sh
palm origin add openai/skills --alias openai-curated --layout 'skills=skills/.curated/*'
```

which is stored in `~/.palm/config.yaml`:

```yaml
origins:
  - alias: openai-curated
    type: git
    url: https://github.com/openai/skills.git
    layout:
      skills: ["skills/.curated/*"]   # also: agents, commands, instructions, hooks, mcp, exclude, include, nameFrom
```

## Secrets in MCP servers

`${VAR}` placeholders in an MCP server's env, headers, URL or args are secrets.

- Project scope (default `env-ref`): palm writes each harness's own environment
  reference (`${VAR}` for Claude, `${env:VAR}` for Cursor and VS Code,
  `env_vars` / `bearer_token_env_var` / `env_http_headers` for Codex) and tells you
  what to export. Optional secrets become `${VAR:-}` for Claude, which otherwise
  refuses a config with an unset variable.
- Global scope (default `literal`): palm reads the value from your environment or
  asks for it (masked) and writes it into the user-level config, created with mode
  0600. An optional secret you skip is left out entirely.
- `--secrets env-ref|literal` overrides either default; `palm config set
  secrets.project literal` changes it permanently. The lockfile never stores a
  secret value, only its `${VAR}` placeholder.
- HTTP servers without secrets get only their URL; the harness runs OAuth on first connect.

## How palm differs from Microsoft APM

- **Installs from any repo as it is.** APM expects packages with `apm.yml`; palm also
  indexes Claude/Cursor/Codex plugin repos, marketplaces and plain skill collections,
  and reads APM packages too.
- **Four harnesses, native formats.** Agents become Claude `.md`, Codex `.toml`,
  Copilot `.agent.md` and Cursor `.md`; hooks and MCP servers are merged into each
  harness's own config instead of a compiled `AGENTS.md`.
- **Agents are packages.** Installing an agent resolves the skills, MCP servers and
  instructions it names, and uninstalling it removes them unless something else still
  needs them.
- **MCP from three sources.** Origins, the official MCP registry and ad hoc
  definitions, with a per-scope secret policy.
- **Global and project scope** with the same commands (`-g`), and a local `mine`
  origin that `palm create` writes to.

## Known limitations

- MCP servers inside plugins that reference `${CLAUDE_PLUGIN_ROOT}` point at files palm
  does not copy (hook scripts are copied; server binaries are not).
- Codex cannot expand variables in MCP `args` or `url`; use `--secrets literal` or move
  the value into `env`.
- No project-level Codex prompts, no user-level Copilot prompt files and no Cursor user
  rules exist, so those combinations are skipped with a note.
- When two plugins in one origin ship the same name, only the first is indexed
  (`palm info` and `palm list --available` show the warning).
- Remote marketplace entries are reported, not fetched: add them with `palm origin add`.
- Only one registry (your configured origins plus the MCP registry); no remote palm index.
- Windows has not been tested.

## Development

```sh
npm test               # vitest
npm run typecheck      # tsc --noEmit
scripts/e2e.sh         # end to end against real GitHub repos in a throwaway HOME (needs network)
```
