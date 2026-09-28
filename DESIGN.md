# palm — design contract

`palm` is a package manager for agent resources. It installs skills, agents,
instructions, commands, hooks, MCP servers and plugins from git repositories
("origins") into the on-disk locations of AI coding harnesses ("targets").

This file is the contract every module is written against. `src/core/types.ts`
is the executable form of it. If a module needs something the contract does not
provide, extend the contract (types.ts + this file) rather than inventing a
private convention.

## 1. Vocabulary

| Term | Meaning | Primitive / composite |
|---|---|---|
| **instruction** | Always-on or path-scoped markdown context (`CLAUDE.md` rules, `.instructions.md`, `.mdc` rules, `AGENTS.md` sections). Advisory only. | primitive |
| **skill** | A directory with `SKILL.md` (Agent Skills spec) plus optional `scripts/`, `references/`, `assets/`. Loaded on demand. | primitive |
| **command** | A user-invoked `/name` prompt template (`commands/*.md`, `*.prompt.md`, Gemini `*.toml`). Legacy in most harnesses; skills supersede them. | primitive |
| **agent** | A subagent definition: one file with system prompt + delegation description + tool policy + model, which may *reference* skills and MCP servers by name. palm treats those references as dependencies, so installing an agent installs what it needs. | primitive with deps |
| **hook** | Lifecycle event + matcher → handler (shell command). Dialects differ per harness. | primitive |
| **mcp** | An MCP server connection spec (stdio command or HTTP URL + headers/env). Not content. | primitive |
| **plugin** | A distributable bundle: manifest + any of the above. Installing a plugin installs its members. | composite |
| **origin** | A place entities come from: a git repo (optionally a subdir at a ref) or a local directory. Scanned into an index. | source |
| **registry** | A named list of origins. v1 has one implicit registry: the user's configured origins. Remote index servers are a later concern. | source |
| **target** | A harness that reads files from well-known paths: `claude`, `codex`, `copilot`, `cursor` in v1. | destination |
| **scope** | `project` (files under the project root) or `global` (`-g`, files under the user's home). | destination |

"Capability" is not a packaging concept (it is MCP/A2A protocol feature
negotiation) and does not appear in palm.

## 2. Filesystem layout

### palm's own state

```
$PALM_HOME (default ~/.palm)
  config.yaml          # origins, default targets, preferences
  palm.yaml            # GLOBAL manifest (what is installed with -g)
  palm.lock.yaml       # GLOBAL lockfile
  cache/<originId>/    # git checkout of an origin at its resolved ref
  cache/<originId>.index.json   # scan result for that checkout
  mine/                # auto-created local origin (alias "mine") for `palm create`
    skills/<name>/SKILL.md
    agents/<name>.md
    instructions/<name>.md
    commands/<name>.md
  hooks/<entity>/      # copied hook scripts for global installs
```

### project scope

```
<projectRoot>/
  palm.yaml            # project manifest
  palm.lock.yaml       # project lockfile
  .palm/hooks/<entity>/  # copied hook scripts for project installs (gitignored by palm)
```

`projectRoot` = nearest ancestor of cwd containing `palm.yaml`, else nearest
ancestor containing `.git`, else cwd.

### target locations (v1)

Paths are relative to projectRoot (project scope) or `~` (global scope).
`~/.claude` honours `$CLAUDE_CONFIG_DIR`; `~/.codex` honours `$CODEX_HOME`.

| kind | claude | codex | copilot | cursor |
|---|---|---|---|---|
| skill | `.claude/skills/<n>/` · `~/.claude/skills/<n>/` | `.agents/skills/<n>/` · `~/.agents/skills/<n>/` | `.agents/skills/<n>/` · `~/.agents/skills/<n>/` | `.agents/skills/<n>/` · `~/.agents/skills/<n>/` |
| agent | `.claude/agents/<n>.md` · `~/.claude/agents/<n>.md` | `.codex/agents/<n>.toml` · `~/.codex/agents/<n>.toml` | `.github/agents/<n>.agent.md` · `~/.copilot/agents/<n>.agent.md` | `.cursor/agents/<n>.md` · `~/.cursor/agents/<n>.md` |
| instruction | `.claude/rules/<n>.md` · `~/.claude/rules/<n>.md` | managed block in `AGENTS.md` · `~/.codex/AGENTS.md` | `.github/instructions/<n>.instructions.md` · `~/.copilot/instructions/<n>.instructions.md` | `.cursor/rules/<n>.mdc` · (no user scope: skip + warn) |
| command | `.claude/commands/<n>.md` · `~/.claude/commands/<n>.md` | (no project scope: skip + warn) · `~/.codex/prompts/<n>.md` | `.github/prompts/<n>.prompt.md` · (skip + warn) | `.cursor/commands/<n>.md` · `~/.cursor/commands/<n>.md` |
| hook | merged into `.claude/settings.json` · `~/.claude/settings.json` | merged into `.codex/hooks.json` · `~/.codex/hooks.json` | `.github/hooks/<n>.json` · `~/.copilot/hooks/<n>.json` | merged into `.cursor/hooks.json` · `~/.cursor/hooks.json` |
| mcp | `.mcp.json` · `~/.claude.json` (`mcpServers`) | `.codex/config.toml` · `~/.codex/config.toml` (`[mcp_servers.<n>]`) | `.vscode/mcp.json` (`servers`) · `~/.copilot/mcp-config.json` (`mcpServers`) | `.cursor/mcp.json` · `~/.cursor/mcp.json` |


The shared `.agents/skills` directory is written **once** even when several
non-Claude targets are active. Claude Code does not read `.agents/skills`, so a
skill installed for claude + codex is copied to both `.claude/skills` and
`.agents/skills`.

Hook and MCP writers **merge** into existing files and must preserve unrelated
content and formatting as far as practical (JSON: parse/modify/stringify with 2
spaces; TOML: use `smol-toml`, re-stringify whole file, acceptable). Unmerging
prunes containers palm emptied (`"SessionStart": []`, `"hooks": {}`,
`"mcpServers": {}`) and deletes a JSON file left as `{}`.

Hook scripts referenced through `${CLAUDE_PLUGIN_ROOT}` are copied to
`.palm/hooks/<n>/` (project) or `$PALM_HOME/hooks/<n>/` (global): the whole plugin
root (scripts may read sibling files, e.g. superpowers reads
`skills/using-superpowers/SKILL.md`) minus docs, tests, CI and top-level README-type
files. Commands get the root substituted and, for claude/codex (cursor), the variable
exported (`CLAUDE_PLUGIN_ROOT="…" cmd`), as the harness would for a native plugin.

Uninstall removes directories palm emptied, up to but never including the harness
config dirs (`.claude`, `.codex`, `.cursor`, `.github`, `.vscode`, `~/.copilot`);
the palm-owned containers `.agents/skills`, `.agents`, `.palm/hooks`, `.palm`
(project) and `$PALM_HOME/hooks` go once empty.

**Safety rules** (enforced in targets and engine): entity names are single path
segments (`[A-Za-z0-9][A-Za-z0-9._-]*`, no `..`) or the deploy is refused; a lock
path that resolves outside the scope (project root; or home / `$PALM_HOME` /
harness home overrides for global) is never deleted; symlinks are followed only
when their real target stays inside the origin, so a skill cannot smuggle
`~/.ssh/id_rsa` into `.claude/skills`; a deploy that fails half-way removes the
files it created.

## 3. Manifest (`palm.yaml`)

```yaml
targets: [claude, codex]           # optional; falls back to config default / detection
origins:                           # optional project-local origins (same shape as config, alias required)
  - { alias: mattpocock, type: git, url: https://github.com/mattpocock/skills.git }
skills:
  - wayfinder@mattpocock
  - tdd@mattpocock#v1.2.3
agents:
  - comment-sicko@pstack
instructions: []
commands: []
hooks: []
mcp:
  - io.github.github/github-mcp-server        # MCP registry name
  - name: docs                                 # ad hoc definition
    transport: http
    url: https://example.com/mcp
    headers: { Authorization: "Bearer ${DOCS_TOKEN}" }
  - name: fs
    transport: stdio
    command: npx
    args: [-y, "@modelcontextprotocol/server-filesystem", "."]
plugins:
  - superpowers@superpowers
```

Dependency string grammar: `<name>[@<origin-alias>][#<ref>]`. Parse `#ref`
first, then `@origin` only when the text after the last `@` contains no `/`.
Names never contain `@` or `#`. A section emptied by uninstall is removed.

Bare `palm install` (no args) syncs the manifest: installs missing entries,
redeploys entries (and their dependencies) whose files were deleted by hand, and
reports lock entries with no manifest entry (removes them with `--prune`).
`--secrets` applies to the sync as well.

## 4. Lockfile (`palm.lock.yaml`)

One entry per installed entity per scope. Everything needed to uninstall,
detect drift, and reinstall deterministically.

```yaml
version: 1
entries:
  - kind: skill
    name: wayfinder
    origin: mattpocock
    url: https://github.com/mattpocock/skills.git
    ref: v1.2.3
    sha: 3f2a...
    path: skills/engineering/wayfinder
    contentHash: sha256:...
    installedAt: 2026-09-27T17:00:00Z
    targets: [claude, codex]
    files:                       # everything palm wrote, scope-relative (project) or absolute (global)
      - .claude/skills/wayfinder/SKILL.md
      - .agents/skills/wayfinder/SKILL.md
    merged:                      # entries palm inserted into shared files, for exact removal
      - file: .claude/settings.json
        pointer: /hooks/SessionStart
        value: { ... }           # the exact JSON inserted
    via: plugin:superpowers      # or agent:<name>, absent for direct installs
    deps:                        # plugin/agent entries: what they declared (members, skills, MCP servers, instructions)
      - { kind: skill, name: brainstorming }
```

`merged[].value` never holds a literal secret: values resolved under the `literal`
policy are recorded as their `${VAR}` placeholder, and unmerge treats a placeholder
as matching any text.

## 5. Origins and the index

`config.yaml`:

```yaml
targets: [claude, codex, copilot, cursor]   # default targets for -g and for projects without their own
origins:
  - alias: mattpocock
    type: git
    url: https://github.com/mattpocock/skills.git
    ref: v1.2.3            # optional; absent = latest semver tag if any, else default branch
  - alias: pstack
    type: git
    url: https://github.com/cursor/plugins.git
    root: pstack           # subdirectory
  - alias: mine
    type: local
    path: /Users/max/.palm/mine
  - alias: openai
    type: git
    url: https://github.com/openai/skills.git
    layout:                # optional descriptor overriding auto-detection
      skills: ["skills/.curated/*"]
```

Origin spec input forms accepted on the CLI (`palm origin add <spec>`):
`owner/repo`, `owner/repo/sub/dir`, `github:owner/repo`, any `https://`/`git@`
URL (optionally `#ref`), a local path, or a `marketplace.json` file/URL which is
expanded into one origin per plugin entry (`palm origin import`).

Every origin in `config.yaml` or a project `palm.yaml` must carry an explicit, unique `alias` matching `^[a-z0-9][a-z0-9._-]*$` (palm never derives one on load: a missing or malformed alias is `E_PARSE` naming the file and the alias `palm origin add` would derive, a clash on add is `E_CONFLICT`), and `-o/--origin` on `list`, `search` and `info` selects an origin by alias, `owner/repo[/root]`, URL or local path (`matchOrigin`/`resolveOriginQuery`).

Default alias = repo name (`obra/superpowers` → `superpowers`), or the owner when
the repo name is generic (`skills`, `plugins`, `agents`, `prompts`, `rules`, `mcp`, …:
`mattpocock/skills` → `mattpocock`, `anthropics/skills` → `anthropics`); when the
alias is taken, `owner-repo`. A `root` subdir aliases to its last segment, then
`<base>-<lastSegment>`. `palm origin add … --layout kind=glob` (repeatable) stores a
layout descriptor; `palm origin import` skips entries already registered (same
repo, root and ref) and indexes what it adds.

`originId` (cache dir name) = sanitized `host/owner/repo[/root]` with `/` → `__`;
local origins append a short hash of the raw path (`a/b` ≠ `a-b`). The index file is
`<originId>[@<ref>][~<layout hash>].index.json`, so two aliases of one repository with
different layouts share the checkout but not the index. The scanner receives the ref
actually checked out, so skills without their own version take the tag's.

**Origin URLs** pass one validator (`validateOriginUrl`) on input and when stored
origins are loaded: `https://`, `http://` and `git://` (warning), `ssh://`,
`file://`, `user@host:path`, absolute paths. Leading `-`, `ext::`/`fd::`/any `<x>::`
transport, other schemes and control characters are refused. Every git call runs
with `protocol.ext.allow=never`, `protocol.fd.allow=never`, `protocol.file.allow`
only for local origins, and `--` before positional URLs/refs.

The index for an origin is the `ScanResult` from `scanOrigin()`, cached at
`cache/<originId>.index.json` with the resolved sha. `palm origin update`
refetches and rescans. Install reads from the cache when present, otherwise
fetches first.

### Scan rules (priority order)

0. Ignore: `node_modules`, `test(s)`, `fixture(s)`, `eval(s)`, `example(s)`,
   `template(s)`, `docs`, `website`, `dist`, `build`; install outputs
   `.agents/skills`, `.claude/skills`, `.github/{skills,agents,instructions,prompts}`,
   `.cursor/rules`; root `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` (contributor guidance).
   Include dot-directories otherwise (openai/skills uses `skills/.curated`).
1. `layout` descriptor on the origin → use it, skip detection.
2. `apm.yml` with `.apm/` → APM package: primitives from `.apm/{skills,agents,instructions,prompts,hooks}`.
3. Marketplace file (`.claude-plugin/marketplace.json` > `.cursor-plugin/marketplace.json` >
   `.github/plugin/marketplace.json` > `.agents/plugins/marketplace.json`): each entry with a
   relative source becomes a `plugin` entity scanned at that path; entries with remote sources
   are surfaced as `warnings` ("remote plugin X → add as origin"), not fetched. A single entry
   with source `./` collapses into the root plugin. `strict:false` + `skills:[...]` = exact subset.
4. Per-plugin manifest (`.claude-plugin/plugin.json` > `.cursor-plugin/plugin.json` >
   root `plugin.json` with agent-plugins `$schema` > `.codex-plugin/plugin.json` >
   `gemini-extension.json`): pick ONE, never union. Claude semantics: `skills` adds to
   default `skills/` scan; `agents`/`commands` replace defaults; `hooks`/`mcpServers` merge
   with `hooks/hooks.json`/`.mcp.json`; hooks may be inline in the manifest.
5. Convention scan: root `SKILL.md` → one skill; else `**/SKILL.md` to depth 5
   (a SKILL.md under another SKILL.md is a sub-skill: record `parent`);
   agents `agents/**/*.md` + `**/*.agent.md` with `name`+`description` frontmatter (exclude
   `agents/openai.yaml`, README); commands `commands/*.md`, `commands/*.toml`, `prompts/*.prompt.md`;
   hooks `hooks/hooks.json`, `hooks/*/hooks.json`; mcp `.mcp.json`/`mcp.json` (wrapped or flat);
   instructions `rules/*.mdc`, `*.instructions.md`, `instructions/*.md`.

Names: skill = frontmatter `name` (fallback dirname; if invalid slug, slugify
dirname; if it differs from dirname keep frontmatter name and warn); agent =
file stem minus `.agent`, `name` with spaces → `displayName`; plugin =
manifest name → marketplace entry name → dirname; mcp = server key.
Version = frontmatter `metadata.version` → `version` → manifest `version` → tag.

## 6. Install flow (engine)

```
palm install [<kind>] <spec>... [-g] [--from <origin>] [--target a,b] [--dry-run] [--force] [--yes]
```

1. Resolve scope + targets (flag > manifest > config default > detection > interactive multiselect saved to manifest). The CLI first runs a pre-flight (`preflightInstall`: steps 3–5 without the picker or registry), so a name that matches nothing fails before any target prompt; `origin`/`registry` as the kind word and kind-less repository specs (`owner/repo`, git URLs, paths) are usage errors pointing at `palm origin add` / `--from`.
2. Parse kind (singular/plural/aliases, see `kinds.ts`). If the first arg is not a kind, search all kinds.
3. For each spec: parse `name[@origin][#ref]`; `--from` supplies/overrides origin and may be an unregistered spec (ad hoc origin, fetched but not saved unless `--save-origin`).
4. Ensure the relevant origins are fetched and indexed (fetch lazily; `--offline` uses cache only).
5. Match candidates: exact name within kind; if 0 → fuzzy suggestions + "add an origin" hint, exit 1; if 1 → proceed; if >1 → interactive picker showing `name  kind  origin  version  description`; non-TTY → error listing candidates with the `@origin` form to disambiguate. `--yes` picks the first only when candidates are identical content hashes.
6. Expand composites: plugin → members; agent → referenced `skills`/`mcpServers`/`instructions` (palm's `instructions:` frontmatter extension, `name[@origin]`) queued with `via: agent:<name>`. Resolution: an explicit `@origin` → only that origin; else the agent's own origin; else the origin the dependency was installed from before (so reinstalls never turn ambiguous); else all origins (picker; non-TTY → `E_AMBIGUOUS`). A dependency already installed another way is kept as is.
7. Materialize per target via `Target.deploy()`; collect written files + merged entries. An entry whose recorded files are missing counts as changed and is redeployed.
8. Write lock entries (plugin/agent entries record `deps`) and manifest entries (manifest gets the direct requests only, not `via` deps).
9. Print a summary table: what was installed where, warnings (hooks = executable code, MCP secrets placement).

Collision policy: if a destination file exists and is not in the lock → refuse
unless `--force` (then overwrite and record). If it is in the lock for the same
entity → overwrite silently (reinstall/update).

Uninstall reverses: remove `files`, remove `merged` values, drop `via` deps that
no other entry needs, update manifest. **Reference counting:** a `via` dependency
stays when the manifest lists it directly (it becomes direct) or when a remaining
entry lists it in `deps` (it is re-parented to that entry's `via`). The same rule
applies to dependencies a plugin/agent stopped declaring (update/sync).

`--target` with an explicit value is saved (palm.yaml `targets:` for project scope,
config.yaml for `-g`) when it differs from what is stored; an interactive pick is
saved the same way. `--dry-run` writes no harness file, lockfile, manifest or
config (origins are still fetched into the cache so the plan is real).

## 7. MCP specifics

Canonical `McpServerConfig` is harness-neutral. Sources:

- **origin**: `.mcp.json`/`mcp.json` in a plugin/origin (entity kind `mcp`).
- **registry**: official MCP registry (`https://registry.modelcontextprotocol.io`).
  `server.json` → prefer `remotes[0]` (http/sse url + headers), else `packages[0]`
  by registryType: npm → `npx -y <id>@<version> ...args`; pypi → `uvx <id>`;
  oci → `docker run -i --rm <id>`. `environmentVariables[]`/`headers[]` with
  `isSecret` become `secrets`.
- **ad hoc**: `palm install mcp <name> -- <command> [args...]` or
  `palm install mcp <name> --url <url> [--header K=V] [--env K=V]`.

Secret placement policy (`SecretPolicy`):
- `project` scope default `env-ref`: write harness-specific env references
  (claude `${VAR}`, cursor `${env:VAR}`, copilot `${env:VAR}`, codex `env_vars = ["VAR"]`,
  `bearer_token_env_var` for `Authorization: Bearer ${VAR}`, else `env_http_headers`)
  and print which vars to export. Claude refuses a config whose `${VAR}` is unset
  without a default, so **optional** secrets (registry `isRequired: false`, or
  `${VAR:-default}`) are written as `${VAR:-}` for Claude.
- `global` scope default `literal`: prompt (masked) for each secret not already in
  `process.env` and write the value into the user-private config file (created
  0600). An optional secret left empty (or unset without a TTY) drops its env
  entry/header instead of leaving a bare `${VAR}`.
- `--secrets env-ref|literal` overrides (also for a bare `palm install`). Never write
  literals into project files unless `--secrets literal` is explicit.
- Placeholders in `args` are detected as secrets too. Under `literal` they are
  substituted for every target; under `env-ref` Claude/Cursor/VS Code expand them,
  Codex does not (reported as a limitation in the summary).
- Runtime variables (`RUNTIME_VARS` in src/mcp/secrets.ts: `CLAUDE_PLUGIN_ROOT`,
  `CLAUDE_PROJECT_DIR`, `workspaceFolder`, `HOME`, …) are never secrets and are left
  exactly as written.
- HTTP servers without declared secrets: write url only; harnesses run OAuth on
  first connect (say so in the summary).

## 8. `palm create`

`palm create agent|skill|instruction|command [name]` — interactive wizard,
writes into the `mine` local origin (created + git-initialised on first use,
registered in config), rescans `mine`, then offers to install it now (default
yes) through the normal install path so dependencies get resolved with the
picker.

`create agent` asks: name (slug), description (when to delegate), model (select:
inherit/opus/sonnet/haiku/custom), tools (multiselect of Claude tool names,
optional), skills (multiselect from installed + all indexed skills, with a
search prompt), MCP servers (multiselect from installed + indexed + registry
search), instructions (optional), then opens `$EDITOR` (fallback: multiline
text prompt) for the system prompt. Output is the canonical agent file (Claude
frontmatter superset) with `skills:` and `mcpServers:` lists and, because Claude
agent files cannot carry instructions, an `instructions: [name@origin]` list that
only palm reads (targets never receive it). Installing the agent installs all
three as tracked dependencies (`via: agent:<name>`, recorded in `deps`).

## 9. Other commands

- `palm uninstall|remove|rm [<kind>] <name>... [-g]`
- `palm list|ls [<kind>] [-g] [-o origin] [--json]` — installed (from lock); `--available` lists the index grouped by origin; `-o` keeps one origin (installed view also accepts `mine`, `registry`, `adhoc`).
- `palm search <query> [--kind k] [-o origin] [--json]` — fuzzy over all indexes; `--kind mcp` also queries the registry.
- `palm info <kind> <name>` — description, origin, version, files, deps.
- `palm origin add|list|remove|update|import`
- `palm update [<kind> <name>...] [-g]` — refetch origins, reinstall entries whose content hash changed; `--dry-run` shows the plan (each entity once).
- `palm targets` — configured/detected targets; `palm config get|set <key> <value>`.
- `palm doctor` — checks git, harness dirs, cache health, lock/manifest drift (registry MCP servers match by registry name), origin reachability (through the same validated git wrapper).
- `palm info` / `palm list --available` show the scanner's warning when two plugins of one origin ship the same name (the first is indexed; `name@origin` resolves to it).
- `--json` also turns errors into `{ "error": { code, message, hint } }` on stdout.

## 10. Conventions

- TypeScript strict, ESM, Node ≥ 22. No default exports. Named exports only.
- Errors: throw `PalmError(code, message, hint?)`; the CLI prints `message` and `hint`, exit 1. Never `process.exit` outside `src/cli.ts`.
- All filesystem paths in function signatures are absolute unless the name ends in `Rel`.
- No global mutable state. Pass a `PalmContext` (see types) explicitly.
- Interactive prompts only in `src/ui/` and `src/create/`; core and engine never prompt. When a decision needs the user, engine calls `ctx.ui.pick()` / `ctx.ui.confirm()` which the CLI implements with `@clack/prompts` and tests implement with fakes.
- Tests: `vitest`, colocated under `test/<module>/`, using temp dirs and `PALM_HOME` overrides; never touch the real home. Shared helpers live in `test/support/` (`sandbox.ts` for temp dirs and files, `fakes.ts` for logger, UI, context and targets). `test/support/setup.ts` makes every worker hermetic: temp `HOME` and harness dirs (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `XDG_CONFIG_HOME`), global and system git config disabled, tokens and `GIT_DIR`-style overrides removed, and global `fetch` blocked (inject `fetchImpl`). CLI tests spawn `node dist/cli.js`, built once per run by a vitest `globalSetup`. Property tests use `fast-check` (`*.property.test.ts`).
- Tooling: Biome formats (2 spaces, single quotes, 100 columns) and lints; layer boundaries are enforced with `style/noRestrictedImports` per directory (`lib` → nothing; `domain` → lib and core/types, errors, kinds; `core` → lib, domain; `index`/`targets`/`mcp` → lib, domain, core; `engine` → those plus index, targets, mcp; `commands` → `create` → `ui`, never the reverse; `cli.ts` → commands, ui). `npm run lint` requires clean formatting and fails when any lint rule's count (including `biome-ignore` suppressions) exceeds `scripts/lint-baseline.json`. `npm run check:shape` fails when a file gains functions over 60 lines, over 4 parameters or nested deeper than 4 (`scripts/shape-baseline.json`). Both baselines only go down. `npm run verify` runs lint, typecheck, shape check, tests and build; the build is tsdown with code splitting.
- Logging: `ctx.log.info|warn|debug`; `--verbose` enables debug.
