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
| **registry** | A named list of origins. There is one implicit registry: the user's configured origins (plus the MCP registry for MCP servers). No remote palm index. | source |
| **target** | A harness that reads files from well-known paths: `claude`, `codex`, `copilot`, `cursor`, `gemini`, `opencode`. | destination |
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

### target locations

Paths are relative to projectRoot (project scope) or `~` (global scope).
`~/.claude` honours `$CLAUDE_CONFIG_DIR`; `~/.codex` honours `$CODEX_HOME`; `~/.copilot` honours
`$COPILOT_HOME`; `~/.gemini` honours `$GEMINI_CLI_HOME` (as `$GEMINI_CLI_HOME/.gemini`: the
variable replaces Gemini's home, not its config dir); `~/.config/opencode` honours
`$XDG_CONFIG_HOME` (as `$XDG_CONFIG_HOME/opencode`). Each override is a global-scope boundary.

| kind | claude | codex | copilot | cursor |
|---|---|---|---|---|
| skill | `.claude/skills/<n>/` · `~/.claude/skills/<n>/` | `.agents/skills/<n>/` · `~/.agents/skills/<n>/` | `.agents/skills/<n>/` · `~/.agents/skills/<n>/` | `.agents/skills/<n>/` · `~/.agents/skills/<n>/` |
| agent | `.claude/agents/<n>.md` · `~/.claude/agents/<n>.md` | `.codex/agents/<n>.toml` · `~/.codex/agents/<n>.toml` | `.github/agents/<n>.agent.md` · `~/.copilot/agents/<n>.agent.md` | `.cursor/agents/<n>.md` · `~/.cursor/agents/<n>.md` |
| instruction | `.claude/rules/<n>.md` · `~/.claude/rules/<n>.md` | managed block in `AGENTS.md` · `~/.codex/AGENTS.md` | `.github/instructions/<n>.instructions.md` · `~/.copilot/instructions/<n>.instructions.md` | `.cursor/rules/<n>.mdc` · (no user scope: skip + warn) |
| command | `.claude/commands/<n>.md` · `~/.claude/commands/<n>.md` | (no project scope: skip + warn) · `~/.codex/prompts/<n>.md` | `.github/prompts/<n>.prompt.md` · (skip + warn) | `.cursor/commands/<n>.md` · `~/.cursor/commands/<n>.md` |
| hook | merged into `.claude/settings.json` · `~/.claude/settings.json` | merged into `.codex/hooks.json` · `~/.codex/hooks.json` | `.github/hooks/<n>.json` · `~/.copilot/hooks/<n>.json` | merged into `.cursor/hooks.json` · `~/.cursor/hooks.json` |
| mcp | `.mcp.json` · `~/.claude.json` (`mcpServers`) | `.codex/config.toml` · `~/.codex/config.toml` (`[mcp_servers.<n>]`) | `.vscode/mcp.json` (`servers`) · `~/.copilot/mcp-config.json` (`mcpServers`) | `.cursor/mcp.json` · `~/.cursor/mcp.json` |

| kind | gemini | opencode |
|---|---|---|
| skill | `.agents/skills/<n>/` · `~/.agents/skills/<n>/` (shared; `$GEMINI_CLI_HOME` set → `$GEMINI_CLI_HOME/.gemini/skills/<n>/`, since Gemini then reads `$GEMINI_CLI_HOME/.agents/skills`) | `.agents/skills/<n>/` · `~/.agents/skills/<n>/` (shared; `OPENCODE_DISABLE_EXTERNAL_SKILLS` = `1`/`true` → `.opencode/skills/<n>/` · `~/.config/opencode/skills/<n>/`) |
| agent | `.gemini/agents/<n>.md` · `~/.gemini/agents/<n>.md` (strict schema: name, description, `kind: local`, display_name, tools in Gemini names, model, temperature / max_turns / timeout_mins) | `.opencode/agents/<n>.md` · `~/.config/opencode/agents/<n>.md` (`mode: subagent`, `permission` from the tool lists, `provider/model` only; other keys stripped) |
| instruction | managed block in `GEMINI.md` · `~/.gemini/GEMINI.md` | `.opencode/instructions/<n>.md` + item in `opencode.json#/instructions` · `~/.config/opencode/instructions/<n>.md` + absolute path in `~/.config/opencode/opencode.json#/instructions` |
| command | `.gemini/commands/<n>.toml` · `~/.gemini/commands/<n>.toml` (`description`, `prompt`; `$ARGUMENTS` → `{{args}}`) | `.opencode/commands/<n>.md` · `~/.config/opencode/commands/<n>.md` |
| hook | merged into `.gemini/settings.json` · `~/.gemini/settings.json` (`hooks`, Gemini event names, timeout in ms) | (no declarative hooks: skip + note) |
| mcp | `.gemini/settings.json` · `~/.gemini/settings.json` (`mcpServers`; `{url, type: http\|sse}`, `${VAR}`) | `opencode.json` · `~/.config/opencode/opencode.json` (`mcp`; `local`/`remote`, `{env:VAR}`) |

Gemini CLI and OpenCode rows were checked against docs and source on 2026-09-28 (research R7),
not against running CLIs. Gemini CLI loads workspace settings, commands, skills, agents and MCP
servers only in trusted folders. Plugins install as loose members for both (Gemini extensions are
user-level only and need Gemini's installer; OpenCode plugins are JS code). The stop dirs are
`.gemini`, `~/.gemini`, `.opencode` and `~/.config/opencode`.

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
files. Commands get the root substituted and, for claude/codex/gemini (cursor), the variable
exported (`CLAUDE_PLUGIN_ROOT="…" cmd`), as the harness would for a native plugin (Gemini CLI
sets none, but the scripts palm converts for it come from Claude plugins).

**Portable project hooks.** Project configs are committed, so a project-scope hook command
never contains an absolute path: the plugin root becomes `<project dir>/.palm/hooks/<n>`,
where `<project dir>` is what each harness documents (checked 2026-09-28). Global scope keeps
the absolute `$PALM_HOME/hooks/<n>`. `.palm/hooks` is gitignored, so after a fresh clone
`palm doctor` warns ("run `palm install` to restore hook assets after a fresh clone") and
`palm install` re-deploys the entries whose files are missing.

| harness | project dir in the command | source | status |
|---|---|---|---|
| claude | `$CLAUDE_PROJECT_DIR` ("the project root where the session started", exported to hook processes) | https://code.claude.com/docs/en/hooks | verified |
| cursor | `$CURSOR_PROJECT_DIR` ("Workspace root directory", always present); project hooks also "run from the project root" | https://cursor.com/docs/agent/hooks | verified |
| codex | `$(git rev-parse --show-toplevel 2>/dev/null \|\| pwd)`: no project-dir variable is documented; commands "run with the session `cwd`", and the docs recommend resolving repo scripts from the git top level because Codex may start in a subdirectory | https://learn.chatgpt.com/docs/hooks | idiom verified; the `pwd` fallback outside git is unverified |
| copilot | same git top level: no project-dir variable is documented, and the default working directory of a hook without `cwd` is not stated (`cwd` itself is "relative to repository root or absolute") | https://docs.github.com/en/copilot/reference/hooks-configuration | default cwd unverified, so palm does not rely on it |
| gemini | `$GEMINI_PROJECT_DIR`, set and expanded for hook commands (it also sets `CLAUDE_PROJECT_DIR` "for compatibility"); palm exports `CLAUDE_PLUGIN_ROOT` for converted Claude plugin scripts, which Gemini does not set | gemini-cli packages/core/src/hooks/hookRunner.ts, docs/hooks | source-verified (R7), not run |

These expressions assume the palm project root is the directory the harness treats as the
project (for codex/copilot, the git top level). A plugin root outside the project (never the
case for `.palm/hooks`) stays absolute.

A target's undeploy removes exactly the files the lock entry lists (and unmerges exactly its
`merged` records), never a whole directory: a hook's asset directory keeps files the entry does
not list, such as ones a newer install of the same name wrote or the user added.

Uninstall removes directories palm emptied, up to but never including the harness
config dirs (`.claude`, `.codex`, `.cursor`, `.github`, `.vscode`, `~/.copilot`, `.gemini`,
`.opencode`, `~/.config/opencode`);
the palm-owned containers `.agents/skills`, `.agents`, `.palm/hooks`, `.palm`
(project) and `$PALM_HOME/hooks` go once empty.

**Safety rules** (enforced in targets and engine): entity names are single path
segments (`[A-Za-z0-9][A-Za-z0-9._-]*`, no `..`) or the deploy is refused; a lock
path that resolves outside the scope (project root; or home / `$PALM_HOME` /
harness home overrides for global) is never deleted; symlinks are followed only
when their real target stays inside the origin, so a skill cannot smuggle
`~/.ssh/id_rsa` into `.claude/skills`; a deploy is a transaction: merges into shared
files are planned (computed, not written) with the whole files, conflicts are found before
anything is written, and a failure while writing restores every file the deploy touched
(merged files to their previous bytes and mode, created files and directories removed), so
the scope is byte-identical afterwards.

**Symlinked dotfiles.** Every write goes through `writeFileAtomic`, which writes through a
symlinked file (temp file and rename next to the link's final target), so a dotfiles-managed
`~/.claude/settings.json`, `~/.codex/config.toml` or a symlinked `palm.lock.yaml` stays a
link. Symlinked parent directories (`~/.claude -> ~/dotfiles/claude`) are written into, never
replaced.

## 3. Manifest (`palm.yaml`)

```yaml
targets: [claude, codex]           # written by the first install that places something (flag, config default, detection or pick)
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

Bare `palm install` (no args) syncs the manifest against the lock:

- An entry the lock already realises as written (same origin, a ref the lock's
  `ref`/`sha` satisfies, including semver ranges like `#^1.2`; the manifest's full
  target set; the current `transform`) with every file on disk is left alone, with
  no network access.
- Otherwise a locked entry is **replayed**: its origin is read at the locked `sha`
  (the checkout slot for that sha, fetched once if missing) and redeployed, keeping
  the locked `ref`. A newer tag on the origin never changes what a bare install
  deploys; `palm update` does that. Agent dependencies follow their own lock entries.
- A dependency the lock does not have (or whose pin in palm.yaml changed) is
  resolved fresh, like `palm install <kind> <name>`.
- An origin alias the lock names but this machine lacks is recreated from the
  lock's `url` (+ `root`) as a project origin in palm.yaml, with a warning; under
  `-g` that is a failure whose hint names the URL
  (`palm install origin <url> --alias <a> -g`).
- `targets:` is the full set: an entry deployed to a target palm.yaml no longer
  lists is redeployed to the remaining ones and the dropped target's files and merged
  keys are removed (target contraction).
- Lock entries with no manifest entry are reported (removed with `--prune`).
  `--secrets` applies to the sync as well.

`palm install --frozen` (CI): palm.yaml, palm.lock.yaml and the files must agree,
or it fails with `E_CONFLICT` listing every difference and writes nothing. It checks
that every manifest dependency has a direct lock entry with the same name/origin (and
a satisfying ref when pinned), that no lock entry is extraneous or orphaned, that
every entry has the resolved targets and the current `transform`, and that no locked
file was edited (hash). Missing files are then restored from the locked commits
(the only network access: fetching a locked sha that is not in the cache), and each
restored file must hash to the lock's value. It never writes palm.yaml,
palm.lock.yaml or config.yaml (an alias recreated from the lock lives only for the
run).

`targets:` makes a project machine-independent: the first project install that places
something writes the resolved set to palm.yaml when it has none (one info line says so), so
the next developer gets the same harnesses instead of whatever their machine detects. A run
that fails before that (an ambiguous name, a cancelled prompt, every item failing) saves
nothing. Global scope is different: config.yaml `targets` is the default for every project
without its own, so palm writes it only for an explicit `--target` with `-g` or
`palm config set targets`; what a machine happens to detect is never saved there.

## 4. Lockfile (`palm.lock.yaml`)

One entry per installed entity per scope. Everything needed to uninstall,
detect drift and edits, and reinstall deterministically. Version 2:

```yaml
version: 2
entries:
  - kind: skill
    name: wayfinder
    origin: mattpocock
    url: https://github.com/mattpocock/skills.git   # git origins: recreates a missing alias
    root: skills                 # git origins with a subdirectory root
    ref: v1.2.3
    sha: 3f2a...                 # bare `palm install` deploys exactly this commit
    path: skills/engineering/wayfinder
    contentHash: sha256:...      # the entity's source content
    transform: 2                 # TRANSFORM_VERSION the files were rendered with
    targets: [claude, codex]
    files:                       # everything palm wrote, scope-relative (project) or absolute (global)
      - path: .agents/skills/wayfinder/SKILL.md
        hash: sha256:...         # of the file as written (text hashed with LF line ends)
      - path: .claude/skills/wayfinder/SKILL.md
        hash: sha256:...
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

- **No timestamps**: nothing in the lock depends on the wall clock, so two developers
  installing the same thing produce the same file (no merge churn).
- **Deterministic writer**: entries sorted by kind (KINDS order), name (case-insensitive),
  origin, then name (code points, not locale); keys in a fixed order; `files` sorted by
  path; `targets` in TARGET_IDS order; LF line ends. Saving the same lock twice gives
  identical bytes.
- **Per-file hashes (edit-safe)**: before overwriting or deleting a file palm wrote,
  palm compares its on-disk hash with `files[].hash`. A file the user changed is
  refused with `E_CONFLICT` naming the file and `--force` (the entity is recorded as a
  failure and left as it was; the run goes on). An empty hash (lockfile v1, dry run)
  is never treated as edited. `Lock.modifiedFiles` / engine `modifiedFiles` expose the
  check (uninstall uses it too).
- **`transform`**: `TRANSFORM_VERSION` (src/core/types.ts) is bumped whenever a target
  renders the same entity to different bytes. An entry with an older transform is not
  "unchanged": the next install re-renders it instead of leaving stale output.
- **Partial state is recorded truthfully**: an entry lists only the targets and files
  that succeeded; an entity whose every target failed keeps its previous entry (or
  has none).
- **Version 1** files (timestamps `installedAt`, `files` as plain paths) load and are
  converted in memory (`hash: ''`, `transform: 0`); the next save writes version 2.
  Because `transform: 0` is older than any real version, the first install after the
  upgrade re-renders every entry and records the hashes.

## 5. Origins and the index

`config.yaml`:

```yaml
targets: [claude, codex, copilot, cursor]   # default for -g and for projects without their own; set only by --target -g or `palm config set targets`
origins:
  - alias: mattpocock
    type: git
    url: https://github.com/mattpocock/skills.git
    ref: v1.2.3            # optional: tag, branch, sha or semver range (^1.2); absent = latest semver tag, else default branch
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

Origin spec input forms accepted on the CLI (`palm install origin <spec>`):
`owner/repo`, `owner/repo/sub/dir`, `github:owner/repo`, any `https://`/`git@`
URL (optionally `#ref`), a local path, or a `marketplace.json` file, directory or URL,
which is expanded into one origin per plugin entry (`palm install origin <marketplace>`;
index/marketplace.ts reads or downloads it). `palm get origins` lists them,
`palm describe origin <alias>` shows one, `palm update origins [alias...]` refetches and
rescans, `palm uninstall origin <alias>` unregisters. The old `palm origin add|list|remove|update|import`
forms are hidden aliases.

**Refs.** `ref` (or `#ref`) is a tag, branch or sha, or a semver range: `^1.2`, `~1.2`,
`>=1.2 <2`, `1.x`, `v1`. A range is anything `semver.validRange` accepts that is not one exact
version or a sha (`isSemverRange`). `resolveRef` resolves it against the remote's tags
(`git ls-remote --tags --heads`): a branch or tag named exactly like the range wins (a `2.x`
maintenance branch, a moving `v1` tag); otherwise the highest tag satisfying the range
(`v`-prefixed tags allowed, prereleases only when the range names one); no match is
`E_ORIGIN` listing the nearest tags and `git ls-remote --tags <url>` as the hint. The checkout
records the requested range and the resolved tag (`checkout-ref-<range>.json`), the index and
the lock the resolved tag and its sha; a later fetch with the same range is a cache hit until
`palm update` (refresh) re-resolves it. No ref: the latest release tag, else the default branch.

Every origin in `config.yaml` or a project `palm.yaml` must carry an explicit, unique `alias` matching `^[a-z0-9][a-z0-9._-]*$` (palm never derives one on load: a missing or malformed alias is `E_PARSE` naming the file and the alias `palm install origin` would derive, a clash on add is `E_CONFLICT`), and `-o/--origin` on `list`, `search` and `info` selects an origin by alias, `owner/repo[/root]`, URL or local path (`matchOrigin`/`resolveOriginQuery`).

Default alias = repo name (`obra/superpowers` → `superpowers`), or the owner when
the repo name is generic (`skills`, `plugins`, `agents`, `prompts`, `rules`, `mcp`, …:
`mattpocock/skills` → `mattpocock`, `anthropics/skills` → `anthropics`); when the
alias is taken, `owner-repo`. A `root` subdir aliases to its last segment, then
`<base>-<lastSegment>`. `palm install origin … --layout kind=glob` (repeatable) stores a
layout descriptor; a marketplace install skips entries already registered (same
repo, root and ref) and indexes what it adds.

`originId` (cache dir name) = sanitized `host/owner/repo[/root]` with `/` → `__`;
local origins append a short hash of the raw path (`a/b` ≠ `a-b`). The index file is
`<originId>[@<ref>][~<layout hash>].index.json`, so two aliases of one repository with
different layouts share the checkout but not the index. The scanner receives the ref
actually checked out, so skills without their own version take the tag's.

**Origin URLs** pass one validator (`validateOriginUrl`) on input and when stored
origins are loaded: `https://`, `http://` and `git://` (warning), `ssh://`,
`file://`, `user@host:path`, absolute paths. Leading `-`, `ext::`/`fd::`/any `<x>::`
transport, other schemes and control characters are refused.

**Running git** (`src/core/git-exec.ts`, the only place palm spawns git):

- A clean environment, built from an allow list: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`,
  `LANGUAGE`, `LC_*`, `TMPDIR`, `XDG_CONFIG_HOME`, `SSH_AUTH_SOCK`, `GIT_SSH`,
  `GIT_SSH_COMMAND`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, the proxy
  variables (`http_proxy`, `https_proxy`, `all_proxy`, `no_proxy` and their upper-case forms)
  and CA bundles (`GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`, `SSL_CERT_FILE`, `SSL_CERT_DIR`), plus
  `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`. Everything else is dropped, in
  particular what would point git at another repository or config: `GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_COMMON_DIR`,
  `GIT_CEILING_DIRECTORIES`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`,
  `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, `GIT_ASKPASS`, `SSH_ASKPASS`. A palm started from a git
  hook therefore never touches the hook's repository.
- Every call: `-c protocol.ext.allow=never -c protocol.fd.allow=never
  -c protocol.file.allow=<user for local origins, else never> -c credential.interactive=false`,
  and `--` before positional URLs/refs.
- ssh never prompts: for an ssh remote palm sets `-c core.sshCommand=<the user's global
  core.sshCommand, or ssh> -o BatchMode=yes`; a user `GIT_SSH_COMMAND` gets `-o BatchMode=yes`
  appended when it runs OpenSSH and has no BatchMode; `GIT_SSH` (a bare program) is left alone.
- Timeouts: 120 s for `ls-remote`, `clone` and `fetch` (`E_NETWORK`, hint: check the network,
  `git ls-remote <url>`), 30 s for local steps (`E_GIT`, hint: `palm cache clean`), 20 s for
  `palm doctor`'s reachability ping. A timed-out fetch is never retried with a second clone.

The index for an origin is the `ScanResult` from `scanOrigin()`, cached at
`cache/<originId>.index.json` with the resolved sha. `palm update origins`
refetches and rescans. Install reads from the cache when present, otherwise
fetches first. The cache file records `format` (`INDEX_FORMAT` in core/cache, currently 2:
entities may carry `issues`) and a `cacheKey` (format, sha, root, layout). A file is only
used when its shape checks out (`format` matches, `cacheKey` a string, `entities` and
`warnings` arrays, every entity with string `kind`/`name`/`path` and an object `def`);
anything else, including an index written by an older palm, is a cache miss and the origin
is rescanned once, never an error. `palm get origins` and `describe origin` read the cache
without fetching (`readCachedIndex`) through the same check, so they show "not indexed" rather
than a malformed file.

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
   are surfaced as `warnings`, not fetched (`remote plugin "x" (<source>) not fetched → add it
   as an origin: palm install origin owner/repo[/path][#ref]`; a git-subdir source adds
   `--root <path>`). A single entry
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

**One walk.** The scanner lists the origin once (relevant files only: md/mdc/json/toml and
`apm.yml`, ignore rules applied, in-origin symlinks followed with loop protection) and builds
directory indexes from it: files per directory, child directories, skill directories per
parent. Plugin defaults (`skills/*`, `agents/`, `commands/`, `rules/`), declared paths and
the undeclared-member warning are lookups, not rescans of the file list. Declared plugin globs
and descriptor globs run fast-glob against the index (a filesystem adapter answered from it),
so they never walk the disk again and never match anything outside the origin or excluded by
the layout. A marketplace plugin inside an ignored directory (`examples/x`) is walked once and
merged into the index.

### Scan issues

After the rules, every entity except plugins is checked for hidden Unicode
(`src/lib/unicode.ts` `scanHiddenUnicode`, PLAN §2 item 11): critical = bidi overrides and
isolates (U+202A–U+202E, U+2066–U+2069), tag characters (U+E0000–U+E007F), variation
selectors 17–256 (U+E0100–U+E01EF); warning = zero-width and other invisible format
characters. Files checked: a skill's whole directory, walked like the deploy copy (COPY_SKIP,
symlinks only inside the origin, so ignored subdirectories such as `examples/` inside a skill
are included); the file of an agent, instruction, command, MCP config or hook set, and every
hook file merged into a plugin's hook set (inline manifest hooks and MCP servers: the
manifest). Binary files (a NUL byte in the first 8 KB) and files over 1 MB are skipped.

Each affected file becomes one `Entity.issues` entry:

```ts
{ code: 'hidden-unicode', severity: 'critical' | 'warning',   // worst finding in the file
  message: 'skills/x/SKILL.md: 2 hidden characters, first U+202E RIGHT-TO-LEFT OVERRIDE at line 8',
  file: 'skills/x/SKILL.md' }                                  // origin-relative
```

The code point named is the first finding of the file's worst severity. Each affected entity
also adds one line to `ScanResult.warnings`, so consumers that ignore `issues` still show it:
`hidden-unicode: <kind> "<name>" (<worst severity>): <worst issue message>[; <n> more files]`.
Entities without findings have no `issues` key.

## 6. Install flow (engine)

```
palm install [<kind>] <spec>... [-g] [--from <origin>] [--target a,b] [--dry-run] [--force] [--yes]
```

1. Resolve scope + targets (flag > manifest > config default > detection > interactive multiselect; `findTargets` saves nothing, the CLI calls `persistTargets` once the install placed something, see §3). Scope guards: at project scope a `projectRoot` equal to the home directory without palm.yaml is `E_USAGE` ("run inside a project or use -g"; a dotfiles `.git` in home is no marker: `isHomeAsProject`, the rule `find` and `audit` apply too); a project origin whose alias a user origin uses for another source is `E_CONFLICT` naming both, a local project origin outside the project is `E_ORIGIN`; under `-g` project origins are ignored. The CLI first runs a pre-flight (`preflightInstall`: steps 3–5 without the picker or registry), so a name that matches nothing fails before any target prompt; `registry` as the kind word and kind-less repository specs (`owner/repo`, git URLs, paths) are usage errors pointing at `palm install origin` / `--from`; `palm install origin <spec>` registers an origin (§9).
2. Parse kind (singular/plural/aliases, see `kinds.ts`). If the first arg is not a kind, search all kinds.
3. For each spec: parse `name[@origin][#ref]`; `--from` supplies/overrides origin and may be an unregistered spec (ad hoc origin, fetched but not saved unless `--save-origin`).
4. Ensure the relevant origins are fetched and indexed (fetch lazily; `--offline` uses cache only).
5. Match candidates: exact name within kind; if 0 → fuzzy suggestions + "add an origin" hint, exit 1; if 1 → proceed; if >1 → interactive picker showing `name  kind  origin  version  description`; non-TTY → error listing candidates with the `@origin` form to disambiguate. `--yes` picks the first only when candidates are identical content hashes.
6. Expand composites: plugin → members; agent → referenced `skills`/`mcpServers`/`instructions` (palm's `instructions:` frontmatter extension, `name[@origin]`) queued with `via: agent:<name>`. Resolution: an explicit `@origin` → only that origin; else the agent's own origin; else the origin the dependency was installed from before (so reinstalls never turn ambiguous); else all origins (picker; non-TTY → `E_AMBIGUOUS`). A dependency already installed another way is kept as is.
7. Executable consent: every hook (dialect, event → command) and every stdio MCP server (command + args) among the items this run will write is listed once; interactive runs confirm once (default yes, no → `E_CANCELLED`, nothing written); non-interactive runs need `--yes` (else `E_NON_INTERACTIVE`, hint naming `--yes`); `--dry-run` lists them without asking. Text entities are never gated; entries that are unchanged are not asked again, and neither are the lines a caller already had allowed (`InstallOptions.consented`: `palm update` lists them in its plan and its one confirmation covers them).
8. Per item (`engine/deploy.ts`): the pure `planDeployment` decides from the lock (keep / unchanged / add missing targets / full deploy replacing the previous install); refusals (hidden Unicode with severity `critical` unless `--force` (hint: review the origin's files; `palm install … --force` accepts them, then `palm audit` shows them), edited files unless `--force`, `--frozen` content mismatch) become failures; `resolveMcpSecrets` (notes `requires secret A` / `optional secret B (unset)`, the same words in a dry run); `deployToTargets` (one target's error does not stop the others); `buildLockEntry` hashes every written file. An entry whose recorded files are missing counts as changed and is redeployed.
9. The previous install is removed only **after** the new deploy succeeded, and only what the new one no longer writes (files by path, except a case variant that is the same file on disk; merged records by file + pointer, appended array items (hook entries, OpenCode `/instructions`) also by value), so a transport change (url → command), a renamed instruction or a failed redeploy never leaves stale keys or a half-removed entity.
10. The lock (plugin/agent entries record `deps`) and manifest (direct requests only, not `via` deps) are saved after **every** item, and again in `finally`: a crash or Ctrl-C leaves a lock that matches the disk. SIGINT during an install sets a flag: the loop stops after the current item, saves, and throws `E_CANCELLED` (exit 130); a second Ctrl-C ends palm at once.
11. Print a summary table, then every failure (`x kind name@origin → target: message` + hint) and the warnings.

**Failures are never exit 0.** `InstallResult.failures` lists each target that failed,
each refused entity (edited files, hidden Unicode, `--frozen`) and each origin that
could not be fetched (a manifest dependency during sync, a lock replay); a request
that names nothing still throws (`E_NOT_FOUND`, `E_AMBIGUOUS`) outside a sync.
An outcome whose every target failed has status `failed`. The CLI exits 1 when
`failures` is not empty.

Collision policy: if a destination file exists and is not in the lock → refuse
unless `--force` (then overwrite and record). If it is in the lock for the same
entity → overwrite on reinstall/update, unless its hash shows the user edited it
(then refuse unless `--force`).

Uninstall reverses: remove `files`, remove `merged` values, drop `via` deps that
no other entry needs, update manifest. **Reference counting:** a `via` dependency
stays when the manifest lists it directly (it becomes direct) or when a remaining
entry lists it in `deps` (it is re-parented to that entry's `via`). The same rule
applies to dependencies a plugin/agent stopped declaring (update/sync).

After an install that placed something, `--target` with an explicit value is saved when it
differs from what is stored (palm.yaml `targets:` for project scope, config.yaml for `-g`); an
interactive pick is saved the same way at project scope; any other resolved set is saved to
palm.yaml when it has none. Detection and picks never reach config.yaml.
`palm install <kind> <name> --target x` adds targets to an installed entry; only a
bare `palm install` treats the set as exact (contraction). `--dry-run` writes no
harness file, lockfile, manifest or config (origins are still fetched into the cache
so the plan is real).

Scoped MCP names stay distinct: a registry server's config key is its short name,
unless another server already holds that key, in which case it is the namespace-scoped
`<namespace label>-<short name>` (`@a/mcp` → `mcp`, then `@b/mcp` → `b-mcp`); the key
is recorded in palm.yaml (`name:`) and reused on every reinstall.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success (also `--help`, `--version`, bare `palm`) |
| 1 | failure: any `PalmError` except `E_USAGE`, `E_CANCELLED` and `E_INTERNAL`; an engine result that reports a failed outcome (`outcomes[].status === 'failed'` or a `failures` array); `palm doctor` with a failed check |
| 2 | usage: commander errors (unknown command or option, missing argument) and `E_USAGE` |
| 130 | cancelled: `E_CANCELLED` (Esc or Ctrl-C in a prompt, or a declined confirmation); nothing more is printed |
| 70 | internal: an unexpected error or an `E_INTERNAL` PalmError (a palm bug); the stack trace only with `--verbose` |

`src/cli.ts` is the only place that exits (`src/commands/main.ts` computes the code).

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

## 9. Command grammar and output

Every command is `palm <verb> [kind] [names...] [flags]` (kubectl style). The kind word
accepts singular, plural and short names; a first word that is no kind is a name.

| Verb | Aliases | Kinds | Without a kind |
|---|---|---|---|
| `install` | `add`, `i` | skill, agent, instruction, command, hook, mcp, plugin, origin | searches every entity kind; no names: sync palm.yaml |
| `uninstall` | `remove`, `rm`, `delete` | same | matches every entity kind |
| `get` | `list`, `ls` | same plus `target`, `all` | everything installed |
| `describe` | `info` | one entity, origin or target | usage error |
| `update` | `up` | installed entities; `origins` refreshes indexes | everything installed |
| `create` | `new` | skill, agent, instruction, command (§8) | usage error |
| `search` | | entity kinds; the kind word counts only when a query follows | every kind plus the MCP registry |

Short names: `sk` skill, `ag` agent, `ins` instruction, `cmd` command, `hk` hook, `mcp`,
`pl` plugin, `orig` origin, `tg` target. `all` works with `get` only. A verb given a kind it
does not take (`palm install target`) is `E_USAGE` naming a command that does work.

Utilities stay top level: `init`, `doctor`, `outdated [kind]`, `why <kind> <name>`,
`find <path>`, `audit [kind] [names...] [--strip]`, `config get|set`, `completion bash|zsh|fish`,
`cache info|clean`. The old forms `palm origin add|list|remove|update|import` and
`palm targets` are hidden aliases of `install|get|uninstall|update origin` and `get targets`.

- `palm install origin <spec> [--alias a] [--ref r] [--root dir] [--layout kind=glob] [--project]`:
  parse the spec, fetch and index it (`getIndex` on the unsaved spec), then save it with
  `addOrigin` (config.yaml, or palm.yaml with `--project`). When fetching or indexing fails
  nothing is saved, and the hint names a command that shows why (`git ls-remote <url>`). With
  `--project` a local origin must live inside the project (`E_ORIGIN` before anything is fetched,
  the rule every install applies) and palm.yaml stores its path relative to the project, so a
  clone finds it. `palm install <kind> <name> --from <spec> --save-origin` registers the origin
  the same way: config.yaml, or palm.yaml with `--project`.
  A `marketplace.json` (by file name, or a local `.json` whose content has a `plugins` array,
  or an `https://` URL) adds each plugin it lists as an origin, each fetched and indexed first;
  entries already registered (same repository, root and ref) are skipped.
- `palm uninstall origin <alias>...` unregisters (installed entities stay installed).
- `palm get [kind] [names...] [-o origin] [--available]`: installed entries from the lock;
  `--available` lists the indexes grouped by origin; `-o` keeps one origin (alias,
  `owner/repo[/root]`, URL or local path; the installed view also accepts `mine`, `registry`,
  `adhoc`). `get origins` is the origin table (`--verbose`: detection rule, sha, index
  warnings); `get targets` shows each harness, whether it is active, where the active set comes
  from (`--target`, palm.yaml, the global config, or detection) and its config dir; `get all`
  shows installed entities, origins and targets.
- `palm describe <kind> <name[@origin]>`: description, origin, version, dependencies, files per
  harness. `describe origin <alias>`: url or path, ref, sha, root, layout, detection rule,
  counts per kind, index warnings, checkout and index file (the scan time only with `--verbose`,
  so the output repeats). `describe target <id>`: where each
  kind goes in this scope (a dry-run deploy of a sample entity per kind, so the paths are the
  ones the target really writes, env overrides included).
- `palm uninstall [kind] <names...>`: undeploy, delete what palm wrote, reverse merged config,
  drop `via` dependencies nothing else needs (reference counted), update palm.yaml. A file the
  user changed since palm wrote it (hash differs from the lock) is left on disk and listed as kept,
  with the hint to repeat the command with `--force`. A target that cannot undeploy or a file that
  cannot be removed (EACCES …) is reported with `x`, the entry stays in the lock with what is still
  on disk, and the command exits 1.
- `palm update [kind] [names...]`: plan first, then ask. A dependency is refreshed through the
  root of its `via` chain. The plan refetches each origin's index once and compares the lock with
  it, writing nothing in the scope:

  ```
  Update plan (project scope)
  ~ updated    skill   tdd                       mattpocock  v1.0.0 (3f2a1c9) → v1.1.0 (8be01d4)
  + added      skill   review (plugin:kit)       pstack
  - removed    skill   old-helper (plugin:kit)   pstack
  = unchanged  agent   reviewer                  pstack      v2.3.0
  x failed     skill   lint                      gone        unreachable origin "gone": …
  ! you changed these files since palm wrote them; palm overwrites them only with --force:
      .claude/skills/tdd/SKILL.md  (skill tdd)
  ! this update writes a command that runs on your machine:
      hook fmt (claude): PostToolUse → ./fmt.sh
  ```

  `~ updated` = new content (`from → to` as ref and sha, or `content <hash>` when the ref did not
  move), an older rendering (`transform`) or files removed by hand; `+`/`-` = members or agent
  dependencies the new version declares / no longer declares. Nothing to change: "Nothing to
  update.", exit 0. `--dry-run` prints the plan only. Otherwise a terminal asks `Apply N changes?`
  (`… and allow those commands to run?` when the plan lists hook or stdio MCP commands; that one
  answer is the executable consent too) (default No; No changes nothing, exit 0); without a
  terminal `--yes` is required, else
  `E_NON_INTERACTIVE` naming `palm update … --yes`. Applying reinstalls the changed roots with
  `installEntities`. Failures (an unreachable origin or registry, a root its origin no longer has,
  a failed deploy) are listed and exit 1; a dependency its origin dropped is kept with a warning.
  `--json`: `{ plan, outcomes, failures, warnings }`. `palm update origins [alias...]` refetches
  and rescans (all when none is named); a failed origin is reported and the command exits 1.
- `palm outdated [kind] [-g] [--json]`: one row per direct install, `kind name origin current
  wanted latest`. `current` is the locked ref and sha; `wanted` what palm.yaml's `#ref` (or the
  origin's ref) names on the remote now: a tag or branch as is, a semver range (`#^1.2`, `#~1.2`)
  its highest matching tag, no ref the latest release; `latest` the newest release tag, else the
  default branch. Remote refs come from `git ls-remote` (never the cache, never a fetch), with each
  tag's commit (annotated tags peeled) and each branch's head: an entry counts as outdated only
  when the wanted commit differs from the locked one, so a second tag on the locked commit is no
  update. `palm update` then reinstalls what changed in content. Registry MCP servers come from
  the registry. Local origins and ad hoc MCP servers show `-`; an unreadable remote or
  `--offline` shows `?` with a warning. Informational: always exit 0.
- `palm why <kind> <name[@origin]> [-g] [--json]`: `installed by` palm.yaml (section) or the
  plugin/agent that pulled it in, the `chain` up to what palm.yaml lists
  (`skill shared ← agent alpha ← palm.yaml (agents)`), and `needed by`: every installed plugin or
  agent that declares it (they keep it on uninstall). An entry nothing lists gets the uninstall
  hint.
- `palm find <path> [-g] [--json]`: which lock entry wrote a file: the path as given (absolute,
  `~/…`, relative to the working directory) or relative to the scope root; matches a listed file,
  a path inside a listed directory, a config file an entry merged a fragment into, or a directory
  holding listed files (each entry with the number of its files under it). Searches the
  project and the global lock (only global with `-g`, or when the project would be home). Exit 1
  when no entry owns the path, 2 when no searched scope has a lockfile.
- `palm search [kind] <query...> [-o origin] [--refresh]`: fuzzy over all indexes; without a
  kind or origin, or with `mcp`, the MCP registry too.
- `palm cache info` (path, size, checkouts, index files) and `palm cache clean [--yes]`
  (removes `$PALM_HOME/cache`; origins stay registered and are fetched again on next use;
  without a terminal it needs `--yes`).
- `palm completion bash|zsh|fish` prints a static script generated from the command tree
  (verbs, aliases, utilities, kind words, flags per verb).
- `palm doctor` checks git, harness dirs, cache size, lock/manifest drift (registry MCP servers
  match by registry name), hook assets, files palm wrote that the user edited since
  (`N palm-owned files modified since install (see palm audit)`, a warning) and origin
  reachability (through the same validated git wrapper).
- `palm init [--target …]` writes `targets:` to palm.yaml and adds `.palm/` to `.gitignore`,
  creating the file inside a git repository that has none.
- `--dry-run` tables say what would happen (`would install`, `would update`), never `installed`.
- `palm audit [kind] [names...] [-g] [--strip]` scans every file palm owns (each lock entry's
  `files`, v1 path strings and v2 `{ path, hash }` alike; project and global scope, only global
  with `-g` or when the project root is the home directory) for hidden Unicode
  (`src/lib/unicode.ts`): critical = bidi overrides and isolates (U+202A–U+202E,
  U+2066–U+2069), tag characters (U+E0000–U+E007F), variation selectors 17–256
  (U+E0100–U+E01EF); warning = zero-width and other invisible format characters (Cf: U+200B–U+200F,
  U+2060–U+2064, U+FEFF after offset 0, U+00AD, …; a ZWJ inside an emoji sequence is not
  reported). Per file: severity counts and the first code point with line:column; it also
  reports drift (a file missing, or its hash differing from the lock's). `--strip` removes
  every finding from those files (a leading BOM stays), writes atomically and records the new
  hash for files that matched the lock; `--dry-run` shows what it would remove. Lock paths
  outside the scope are never read. Exit 0 when no critical finding is left (warnings and drift
  are printed), 1 otherwise; `--json` is `{ scanned, files, remaining: { critical, warning },
  drifted }`.

### Output contract

One writer (`src/ui/output.ts`) is created per run and is `ctx.log` for the command, so all
output goes through it.

- Data (tables, detail rows) goes to stdout. Status lines carry a symbol: `+` added or
  installed, `-` removed, `~` updated, `=` unchanged, `x` error, `!` warning, `i` info.
- Warnings are collected while the command runs and printed once at the end, on stderr,
  under a `Warnings` heading. Errors are printed last: `x message` and a hint line that names
  a command to run.
- `--json`: stdout holds exactly one JSON document and nothing else; every other line goes to
  stderr. Lists become `{ "items": [...] }`; every document has `warnings: []`; an error is
  `{ "error": { code, message, hint }, "warnings": [] }`.
- Colours come from picocolors: `NO_COLOR=1` and `--no-color` turn them off.
- Startup: the command tree is registration only; each command's module (and the engine, git,
  yaml and clack behind it) is imported when that command runs, so `palm --help` loads
  commander and picocolors only (26 ms median of 10, against 18 ms for bare node, 2026-09-29).

## 10. Conventions

- TypeScript strict, ESM, Node ≥ 22. No default exports. Named exports only.
- Errors: throw `PalmError(code, message, hint?)`; the CLI prints `x message` and the hint (a command to run). Never `process.exit` outside `src/cli.ts`; `src/commands/main.ts` (`EXIT`, `exitCodeFor`) maps every outcome to one exit code:

  | Code | When |
  |---|---|
  | 0 | success, including `--help` and `--version`; warnings never change it (`palm audit` with only zero-width warnings or drift exits 0) |
  | 1 | failure: a `PalmError` other than `E_USAGE`/`E_CANCELLED`/`E_INTERNAL`, a failed engine outcome, or `ExitSignal(1)` from a command that printed its own report (`palm update origins` with a failed origin, `palm audit` with a critical finding left, `palm doctor` with a failed check) |
  | 2 | usage: commander errors (unknown command, option or argument) and `E_USAGE` |
  | 70 | internal: an unexpected exception or `E_INTERNAL` (stack trace with `--verbose`) |
  | 130 | cancelled: `E_CANCELLED` (Esc or Ctrl-C in a prompt, a declined confirmation); nothing more is printed |
- All filesystem paths in function signatures are absolute unless the name ends in `Rel`.
- No global mutable state. Pass a `PalmContext` (see types) explicitly.
- Interactive prompts only in `src/ui/` and `src/create/`; core and engine never prompt. When a decision needs the user, engine calls `ctx.ui.pick()` / `ctx.ui.confirm()` which the CLI implements with `@clack/prompts` and tests implement with fakes.
- Tests: `vitest`, colocated under `test/<module>/`, using temp dirs and `PALM_HOME` overrides; never touch the real home. Shared helpers live in `test/support/` (`sandbox.ts` for temp dirs and files, `fakes.ts` for logger, UI, context and targets). `test/support/setup.ts` makes every worker hermetic: temp `HOME` and harness dirs (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `XDG_CONFIG_HOME`), global and system git config disabled, tokens and `GIT_DIR`-style overrides removed, and global `fetch` blocked (inject `fetchImpl`). CLI tests spawn `node dist/cli.js`, built once per run by a vitest `globalSetup` (`PALM_TEST_DIST=<dir>` builds into `<repo>/<dir>` instead, `PALM_SKIP_DIST_BUILD=1` reuses the existing build); the rest call `runCli` in process. Property tests use `fast-check` (`*.property.test.ts`).
- Tooling: Biome formats (2 spaces, single quotes, 100 columns) and lints; layer boundaries are enforced with `style/noRestrictedImports` per directory (`lib` → nothing; `domain` → lib and core/types, errors, kinds; `core` → lib, domain; `index`/`targets`/`mcp` → lib, domain, core; `engine` → those plus index, targets, mcp; `commands` → `create` → `ui`, never the reverse; `cli.ts` → commands, ui). `npm run lint` requires clean formatting and fails when any lint rule's count (including `biome-ignore` suppressions) exceeds `scripts/lint-baseline.json`. `npm run check:shape` fails when a file gains functions over 60 lines, over 4 parameters or nested deeper than 4 (`scripts/shape-baseline.json`). Both baselines only go down; src, test and scripts have no findings and no suppressions. `npm run knip` fails on any unused file, export or dependency. `npm run verify` runs lint, typecheck, shape check, knip, tests and build; the build is tsdown with code splitting.
- Logging: `ctx.log.info|warn|debug`; `--verbose` enables debug.

## 11. Source layout

Layers, lowest first; each imports only the layers below it (enforced by Biome, see §10).

| Layer | What lives there |
|---|---|
| `src/lib` | palm-free primitives: fs (atomic and symlink-safe writes, `walkFiles`, `isSameFile`), json, yaml, frontmatter, names, object, placeholders (`${VAR}` grammar), text, hidden-Unicode detection (`unicode.ts`) |
| `src/domain` | the model: `DepRef`, `EntityKey`/`LockKey`/`Via`, `Lock` (lockfile v2 as a collection: find, upsert, via graph, `planRemoval`, `modifiedFiles`), `Manifest`, `ScopePaths`, `Origin`/`OriginSet`, `MergedRecord` (tagged union over the stored pointers), secrets, skip lists |
| `src/core` | types and errors, kinds, config.yaml (`config-file`), origin registration (`config`), origin input parsing, context, paths, git (`git-exec` is the only place palm spawns git), the index cache (scanner injected), hashing |
| `src/index` | the scanner: `scanner.ts` orchestrates, `detect.ts` picks the rule, `rules/` holds one module per scan rule (descriptor, apm, marketplace, plugin-manifest, convention), `files.ts` is the one-walk `FileIndex`, then the hidden-Unicode pass |
| `src/targets` | one `TargetSpec` per harness (claude, codex, copilot, cursor, gemini, opencode) over a shared `GenericTarget`: kind planners fill a `DeployPlan` (no IO), a `Writer` checks collisions, applies it and rolls back on failure; converters render agents, instructions, commands, hooks and MCP entries per harness |
| `src/mcp` | the MCP registry client, `server.json` conversion, secret resolution (prompts), ad hoc definitions |
| `src/engine` | the operations: `plan.ts` (resolve and expand requests), `deploy.ts` (pure `planDeployment`, refusals, secrets, deploy, lock entry, stale removal), `install.ts` (scope guards, consent, per-item persistence), `uninstall.ts`, `sync.ts` (bare install, `--frozen`), `update.ts` (plan, then apply), `outdated.ts`, `why.ts`, `find.ts`, `query.ts`, `resolve-targets.ts` |
| `src/commands`, `src/create`, `src/ui` | the CLI: grammar and registration (`program.ts`, lazy `dispatch.ts`), one module per command, the authoring wizards, the one output writer and the prompts |

`src/cli.ts` only calls `runCli` and exits. Module signatures are in API.md; `src/lib/README.md`
lists the primitives.
