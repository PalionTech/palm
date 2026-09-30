# palm design contract (v3, palm 0.2)

palm installs agent configuration from git repositories into the directories that coding
agents read. It copies skills, agents, instructions, hooks and MCP servers from sources into
a project or a home directory, for six harnesses, records what it wrote in a lock, and proves
in CI that the committed files still match their sources. Nothing executable lands without a
review a person can perform.

This file is the contract every module is written against. `src/core/types.ts` is the
executable form of it; `API.md` lists the signatures per module. If a module needs something
the contract does not provide, extend the contract (types.ts, this file, API.md) rather than
inventing a private convention. PLAN.md holds the reasoning and the finding ids; this file
holds the rules.

## 1. Vocabulary

Five words, used the same way in the CLI, the files and the docs.

| Term | Meaning |
|---|---|
| source | A git repository, optionally a subdirectory at a ref, or a directory inside the project. Declared in the manifest of its scope, so it is a dependency of the project, never a per-user registration. GitHub repositories are written `owner/repo`; anything else gets a name and a `url:` or `path:`; an in-repo directory is `./dir`. A source may carry an optional `alias:` for typing. A marketplace or plugin manifest inside a source is only a hint palm uses to find entities. |
| entity | One skill, agent, instruction, hook or MCP server, named within its source. Five installable kinds. A plugin is a selector over the entities of a source (a kind in the index and the lock, never something a person installs as a unit). A command file in a source installs as a skill, with a note. |
| target | A harness: `claude`, `codex`, `copilot`, `cursor`, `gemini`, `opencode`. Declared once in the manifest, narrowed per entry with `targets:`. |
| generated file | Everything palm writes. Every path is listed in the lock. In a project, generated files are committed: git carries them to teammates and CI, and the diff is the review. |
| scope | `project` (the directory holding palm.yaml, found by walking up to the nearest `.git`) or `global` (`-g`, the home directory). Both use the same files and verbs. |

Activation of an instruction is one of `always` (always-on), `on-request` (a description,
loaded when relevant), `paths` (globs) and `manual` (`@name`). The index records it from the
source format; 0.2 targets keep today's placement, and 0.3 maps it where a harness lacks the
concept.

"Origin", "registry" and "capability" are not palm words. Messages, flags, files and docs
say "source".

## 2. Filesystem layout

### palm's own directories

```
$PALM_HOME (default ~/.palm)
  palm.yaml             # the global manifest (what is installed with -g); same format as a project's
  palm.lock.yaml        # the global lock; paths are tokens (<claude>/skills/x), never absolute
  applied.yaml          # this machine: the lock as last applied here, with real paths (AppliedRecord)
  assets/<source>/<entity>/   # scripts that global hooks and MCP servers run (the closure)
  kit/                  # the default in-repo source for `palm create -g` (declared as ./kit in ~/.palm/palm.yaml)
  cache/<sourceId>/     # git checkouts keyed by sha, and index files; safe to delete
```

```
<projectRoot>/
  palm.yaml             # what the team wants                     (committed)
  palm.lock.yaml        # what the sources resolved to and what was rendered   (committed)
  palm.local.yaml       # 0.3: personal additions                 (ignored)
  .palm/assets/<source>/<entity>/   # scripts hooks and MCP servers run     (committed, never marked generated)
  .palm/local/          # 0.3: the overlay's lock                 (ignored; the only ignored palm path)
  .palm/lock            # advisory lock for concurrent palm processes (created and removed per run)
```

`projectRoot` = nearest ancestor of cwd containing `palm.yaml`, else nearest ancestor
containing `.git`, else cwd. Discovery stops at the nearest `.git`: a nested `palm.yaml` in
another repository is another project. A project root equal to the home directory without a
palm.yaml is `E_USAGE` ("run inside a project or use -g"; a dotfiles `.git` in home is no
marker).

There is no `~/.palm/config.yaml`, no machine-state file in a project, no `createdDirs` and no
`.palm/hooks/`. Where git carries the outputs, git is the record of the machine. Where it does
not (the global scope; the 0.3 overlay), palm keeps the last applied lock and nothing more.
`palm init` adds `.palm/local/` and `palm.local.yaml` to `.gitignore`; every project write
that finds no such lines adds them once and says so.

### Target locations

Paths are relative to projectRoot (project scope) or tokens of the harness homes (global
scope; section 4 "Global tokens"). `~/.claude` honours `$CLAUDE_CONFIG_DIR`; `~/.codex`
honours `$CODEX_HOME`; `~/.copilot` honours `$COPILOT_HOME`; `~/.gemini` honours
`$GEMINI_CLI_HOME` (as `$GEMINI_CLI_HOME/.gemini`); `~/.config/opencode` honours
`$XDG_CONFIG_HOME` (as `$XDG_CONFIG_HOME/opencode`). Each override is a global-scope boundary.

| kind | claude | codex | copilot | cursor |
|---|---|---|---|---|
| skill | `.claude/skills/<n>/` · `<claude>/skills/<n>/` | `.agents/skills/<n>/` · `<agents>/skills/<n>/` | `.agents/skills/<n>/` · `<agents>/skills/<n>/` | `.claude/skills/<n>/` when claude is a target, else `.agents/skills/<n>/` · `<agents>/skills/<n>/` |
| agent | `.claude/agents/<n>.md` · `<claude>/agents/<n>.md` | `.codex/agents/<n>.toml` · `<codex>/agents/<n>.toml` | `.github/agents/<n>.agent.md` · `<copilot>/agents/<n>.agent.md` | `.cursor/agents/<n>.md` · `<cursor>/agents/<n>.md` |
| instruction | `.claude/rules/<n>.md` · `<claude>/rules/<n>.md` | managed block in `AGENTS.md` · `<codex>/AGENTS.md` | `.github/instructions/<n>.instructions.md` · `<copilot>/instructions/<n>.instructions.md` | `.cursor/rules/<n>.mdc` · (no user scope: skip + note) |
| hook | merged into `.claude/settings.json` · `<claude>/settings.json` | merged into `.codex/hooks.json` · `<codex>/hooks.json` | `.github/hooks/<n>.json` · `<copilot>/hooks/<n>.json` | merged into `.cursor/hooks.json` · `<cursor>/hooks.json` |
| mcp | `.mcp.json` · `<home>/.claude.json` (`mcpServers`) | `.codex/config.toml` · `<codex>/config.toml` (`[mcp_servers.<n>]`) | `.vscode/mcp.json` (`servers`) · `<copilot>/mcp-config.json` (`mcpServers`) | `.cursor/mcp.json` · `<cursor>/mcp.json` |

| kind | gemini | opencode |
|---|---|---|
| skill | `.agents/skills/<n>/` · `<agents>/skills/<n>/` (`$GEMINI_CLI_HOME` set: `<gemini>/skills/<n>/`) | `.agents/skills/<n>/` · `<agents>/skills/<n>/` (`OPENCODE_DISABLE_EXTERNAL_SKILLS` = `1`/`true`: `.opencode/skills/<n>/` · `<opencode>/skills/<n>/`) |
| agent | `.gemini/agents/<n>.md` · `<gemini>/agents/<n>.md` (strict schema) | `.opencode/agents/<n>.md` · `<opencode>/agents/<n>.md` (`mode: subagent`, `permission` from the tool lists, `provider/model` only) |
| instruction | managed block in `GEMINI.md` · `<gemini>/GEMINI.md` | `.opencode/instructions/<n>.md` + item in `opencode.json#/instructions` · `<opencode>/instructions/<n>.md` + item in `<opencode>/opencode.json#/instructions` |
| hook | merged into `.gemini/settings.json` · `<gemini>/settings.json` (Gemini event names, timeout in ms) | (no declarative hooks: skip + note) |
| mcp | `.gemini/settings.json` · `<gemini>/settings.json` (`mcpServers`) | `opencode.json` · `<opencode>/opencode.json` (`mcp`) |

A command-as-skill renders at the skill locations: `SKILL.md` with `name`, `description` and
the command body; `$ARGUMENTS` survives (a note says where a harness does not expand it).

Gemini CLI and OpenCode rows were checked against docs and source on 2026-09-28, not against
running CLIs; the 1.0 end-to-end job runs them. Gemini CLI loads workspace settings, commands,
skills, agents and MCP servers only in trusted folders. Plugins install as loose members for
both. The stop dirs are `.gemini`, `~/.gemini`, `.opencode` and `~/.config/opencode`.

The shared `.agents/skills` directory is written once even when several non-Claude targets are
active. Claude Code does not read `.agents/skills`; Cursor and OpenCode read both `.claude/skills`
and `.agents/skills` and dedupe by name, so claude plus cursor means one copy in
`.claude/skills`, and claude plus codex means two copies (noted in the lock).

Hook and MCP writers merge into existing files and preserve unrelated content and formatting
as far as practical (JSON: parse, modify, stringify with 2 spaces; TOML: `smol-toml`, whole
file re-stringified). Unmerging prunes containers palm emptied (`"SessionStart": []`,
`"hooks": {}`, `"mcpServers": {}`) and deletes a JSON file left as `{}`.

### Relocation and the asset closure

One rule, resolved at index time (`SourceReference`): a reference to the plugin root
(`${CLAUDE_PLUGIN_ROOT}`, `$CLAUDE_PLUGIN_ROOT`, `${CLAUDE_PLUGIN_ROOT:-x}`,
`${CLAUDE_PLUGIN_ROOT-x}`, `${CURSOR_PLUGIN_ROOT}`, `${PLUGIN_ROOT}`, `${extensionPath}`), a
relative path (`./x`, `x/y`) in a hook `command`, an MCP `command`, an `args[]` item or `cwd`
that names a file or directory in the source (resolved against the hooks file's directory for
APM layouts, else the plugin root), and the project-dir variables (`$CLAUDE_PROJECT_DIR`,
`$CURSOR_PROJECT_DIR`, `$GEMINI_PROJECT_DIR`, translated to the target's idiom). A reference
that resolves to nothing in the source is recorded with `unresolved` set: a missing file keeps
its form, and `eval`, `$(…)`, backticks, `~/…` and `$HOME/…` get the form `unresolvable`.
Either becomes a critical `unresolvable-reference` issue: install refuses that hook or server
with the offending line, and palm never merges a command it could not resolve.

```
x hook do-stop-guard from agency: cannot relocate "./scripts/do-stop-guard.sh"
  no such file under .apm/hooks/ in source agency at 8145505
  a hook command must name a file relative to its hooks.json, ${CLAUDE_PLUGIN_ROOT}, or the project dir
```

Rendering: a resolved reference becomes `<PROJECT>/<assetsRoot>/<rel>`, quoted, where
`<assetsRoot>` is `.palm/assets/<source>/<entity>` for git sources and the source's own
directory for in-repo sources (`inPlace`: nothing is copied, `"$CLAUDE_PROJECT_DIR"/agent-kit/hooks/x.sh`,
so a script edit is live). `<source>` in the asset path is the manifest key with `/` replaced
by `__` and a leading `./` dropped. `<rel>` is the source-relative path, so closure files keep
their source-relative paths below the asset root (`.palm/assets/<source>/<entity>/<source-relative path>`,
for example `.palm/assets/trailofbits__skills/gh-cli/plugins/gh-cli/hooks/x.sh`). Global scope
renders `"$HOME"/.palm/assets/<source>/<entity>/<rel>`, never an absolute path (`$PALM_HOME`
when it is set is written as `"${PALM_HOME:-$HOME/.palm}"`). A command that names the plugin
root also exports the harness's root variable (table below) as the plugin root inside the
asset directory, `<PROJECT>/<assetsRoot>/<plugin root rel>`
(`CLAUDE_PLUGIN_ROOT="$CLAUDE_PROJECT_DIR"/.palm/assets/trailofbits__skills/gh-cli/plugins/gh-cli bash …`),
so a script that reads the variable finds its siblings; a PowerShell command gets the relocated
paths without the `VAR=` prefix (`relocateCommand`, `src/targets/relocate.ts`).

| harness | `<PROJECT>` in the command | root variable exported |
|---|---|---|
| claude | `"$CLAUDE_PROJECT_DIR"` | `CLAUDE_PLUGIN_ROOT` |
| cursor | `"$CURSOR_PROJECT_DIR"` | `CURSOR_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` |
| gemini | `"$GEMINI_PROJECT_DIR"` | `CLAUDE_PLUGIN_ROOT` |
| codex, copilot | `"$(git rev-parse --show-toplevel 2>/dev/null \|\| pwd)"` | `CLAUDE_PLUGIN_ROOT` |
| global (-g) | `"$HOME"` | same |
| opencode | skipped with a persisted note (no declarative hooks) | none |

What is copied is the closure, never the whole source (`HookSet.closure`): the directory
holding the hook definition (`hooks/` in a plugin, the JSON's folder in an APM layout) plus
every source path a command names, at the level named (`workflows/`, `scripts/x.sh`), listed
once at index. Never copied: `SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `*-plugin/`
manifests, `marketplace.json`, `plugin.json`, `.git*`, `node_modules`, so harnesses that scan
downward find nothing under `.palm/assets`. Modes are preserved as git records them (755 or
644), and the executable bit is part of the exec hash;
symlinks are dereferenced (a link leaving the source refuses the entity). The asset directory
of an entry holds exactly the closure files the lock lists; undeploy removes those and prunes
empty parents up to `.palm/assets`.

`.palm/assets/` is committed and deliberately not marked `linguist-generated`, because
reviewers read it. A clone without palm has native files, the assets and working hooks;
nothing exits 127.

### Safety rules

Enforced in targets and engine:

- Entity names are single path segments (`[A-Za-z0-9][A-Za-z0-9._-]*`, no `..`) or the deploy
  is refused.
- Every write and delete checks the destination's real path: it must lie inside the scope root
  (project root; or home, `$PALM_HOME` and the harness home overrides under `-g`). A path that
  resolves outside is refused, naming the link and its target (never a raw ENOENT). Inside,
  palm follows the link and never replaces a symlink with a file. A dangling link whose target
  would lie inside the scope is created through; outside, refused.
- A source that overlaps an output directory is refused, at declaration and again at every
  install: if realpath(source root) contains, equals or is contained in realpath(any output
  directory of any active target, or `.palm/assets`), the error names both and the fix
  (`x source "kit" (./.claude) overlaps the claude output directory .claude/; move the sources
  (for example ./agent-kit) and declare that`). A local source at `.` is scanned with every
  output directory and every lock-owned path excluded.
- palm never deletes or overwrites a path whose real path is inside a declared source,
  `--force` included. Before apply, the engine checks the real path of every rendered path
  against the real paths of the declared local sources; a hit is `E_SOURCE` for that entity
  (targets never see the source list).
- A literal secret found in a source is never written, `--force` included, and it is not a
  refusal of the entity: the index redacts it, the render writes `${KEY}` in its place, and the
  install summary says which variable to export (section 8).
- Only `skills/*/SKILL.md`, or what the layout declares, are entities; a nested
  `references/*/SKILL.md` is content.
- Symlinks inside a source are followed only when their real target stays inside the source,
  so a skill cannot smuggle `~/.ssh/id_rsa` into `.claude/skills`.
- A deploy is a transaction: `Target.render` computes every file and fragment without writing;
  `Target.apply` checks collisions first (a whole file that exists, is not owned by the entry
  and differs from the render is `E_CONFLICT` before anything is written; an identical file is
  adopted silently), then applies fragments and files, journaling each path (bytes and mode,
  or absent plus the nearest existing directory) just before writing it; a failure restores the
  journal newest first, so the scope is byte-identical afterwards.
- Symlinked dotfiles: every write goes through `writeFileAtomic`, which writes through a
  symlinked file (temp file and rename next to the link's final target), so a dotfiles-managed
  `~/.claude/settings.json`, `~/.codex/config.toml` or a symlinked `palm.lock.yaml` stays a
  link. Symlinked parent directories (`~/.claude -> ~/dotfiles/claude`) are written into, never
  replaced.
- Two palm processes on one scope serialise on `<scope>/.palm/lock` (project) or
  `$PALM_HOME/lock` (global): the advisory lock of `core/git withLock` (O_EXCL create, pid and
  host inside, stale after 10 minutes or a dead pid, 60 s wait).

## 3. Manifest (`palm.yaml`)

```yaml
targets: [claude, cursor]

sources:
  mattpocock/skills:                    # GitHub shorthand: the name is owner/repo
    ref: v1.2.3                         # tag, branch, sha, or a range such as ^1.2 (the one home of version intent)
    skills: [tdd, handoff]
  obra/superpowers:
    ref: ^4
    plugins:
      - name: superpowers
        exclude: [skill:brainstorming, hook:superpowers]
  acme-kit:                             # a chosen name: url: or path: is required
    url: https://gitlab.acme.com/platform/agent-kit.git
    root: kit
    ref: ^1
    alias: kit                          # optional short name
    layout: { agents: [people/*.md] }   # consumer override of layout detection, rarely needed
    agents: [reviewer]
    instructions:
      - { name: db-conventions, targets: [claude, codex], at: packages/database }
  ./agent-kit:                          # in-repo directory, rendered from the working tree
    skills: [review]
    hooks: [quality]

mcp:                                    # hand-declared servers, keyed by config name
  docs:
    url: https://example.com/mcp
    headers: { Authorization: "Bearer ${DOCS_TOKEN}" }
  xcodebuild:
    command: npx
    args: [-y, xcodebuildmcp@latest]
```

Rules:

- The source key is the name. A key matching `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$` with no
  `url:`/`path:` is a GitHub repository; a key of three or more such segments
  (`owner/repo/sub/dir`) is that GitHub repository with `root: sub/dir` stored. A key that is
  `.` or starts with `./`, `../` or `/` is a local path (project scope stores it
  project-relative; a path outside the project is `E_SOURCE`, checked whenever the scope
  opens). Any other key needs `url:` (any form `validateSourceUrl` accepts) or `path:`. Names and aliases
  are unique, case-insensitively; a clash is `E_PARSE` naming both.
- Entries are strings (the name) or objects `{ name, targets?, at?, only?, exclude?, render? }`.
  `targets` narrows the scope's set (a target outside it is `E_PARSE`). `only`/`exclude` apply
  to a plugin entry and list members as `kind:name` (`skill:tdd`, `hook:superpowers`).
  `at` is stored and shown in 0.2 and honoured in 0.3. `render` is reserved.
- The same name may appear under two sources only with different kinds; the CLI asks for the
  source when a bare name is ambiguous (`palm remove <source> <name>`).
- `mcp:` at the top level holds servers written by hand, by `install mcp` flags or by
  `install mcp --snippet`; keys are config names (`isSafeName`).
- Old format detection: a top-level `origins:` list, kind lists at the top level, or `name@alias`
  strings anywhere is `E_USAGE`: `x palm.yaml is in the 0.1 format` with the hint `palm migrate`.
- The loader keeps unknown keys and the file's comments and order (`Manifest.save` patches).
  A section emptied by removal is dropped; a source with no entries left is dropped from
  palm.yaml (its lock entry goes with it).
- Under `-g`, `~/.palm/palm.yaml` has the same shape; its `targets:` is the global set (the only
  remaining "setting"). Project sources are invisible under `-g`, and the error says so
  (`x "kit" is a project source; -g uses the sources in ~/.palm/palm.yaml`).

The effective set of a scope is `resolve(palm.yaml)` (0.3: `∪ resolve(palm.local.yaml)
− disable`). Every command works on the effective set rendered for the scope's targets.

## 4. Lockfile (`palm.lock.yaml`)

```yaml
version: 3
sources:
  mattpocock/skills:
    url: https://github.com/mattpocock/skills.git
    ref: v1.2.3                 # the intent copied from palm.yaml when resolved
    sha: 6acc160d…
    descriptor: convention
  obra/superpowers:
    url: https://github.com/obra/superpowers.git
    ref: ^4
    resolved: v4.0.3            # the tag a range resolved to
    sha: a1b2c3d…
    layout: { skills: [skills/*] }
    descriptor: plugin-manifest
  ./agent-kit:
    path: agent-kit
    tree: sha256:10934f8…       # source tree hash at the last render
    descriptor: convention
entries:
  - kind: skill
    name: tdd
    source: mattpocock/skills
    path: skills/tdd
    content: sha256:1f2e…
    render: { claude: sha256:9a0b…, cursor: sha256:9a0b… }
    files: [.claude/skills/tdd/SKILL.md]
    notes: ["cursor reads .claude/skills; no second copy"]
  - kind: skill
    name: brainstorming
    source: obra/superpowers
    via: plugin:superpowers
    path: skills/brainstorming
    content: sha256:…
    render: { claude: sha256:… }
    files: [.claude/skills/brainstorming/SKILL.md, .claude/skills/brainstorming/references/x.md]
  - kind: plugin
    name: superpowers
    source: obra/superpowers
    path: .
    content: sha256:…
    render: {}
    files: []
    deps: [{ kind: skill, name: brainstorming }, { kind: hook, name: superpowers }]
  - kind: hook
    name: quality
    source: ./agent-kit
    path: hooks/hooks.json
    content: sha256:77d0…
    render: { claude: sha256:c4d5… }
    files: []
    merged:
      - { file: .claude/settings.json, at: /hooks/Stop, id: palm:hook:quality:0, key: sha256:3e01a9f2 }
    exec:
      commands:
        - { id: Stop//-, command: 'bash "$CLAUDE_PROJECT_DIR"/agent-kit/hooks/quality.sh' }
      hash: sha256:5d41c3b0…
    trust: [sha256:5d41c3b0…]
  - kind: hook
    name: gh-cli
    source: trailofbits/skills
    via: plugin:gh-cli
    path: plugins/gh-cli/hooks/hooks.json
    content: sha256:…
    render: { claude: sha256:…, cursor: sha256:… }
    files: [.palm/assets/trailofbits__skills/gh-cli/plugins/gh-cli/hooks/persist-session-id.sh, …]
    merged: [ … ]
    exec:
      commands:
        - { id: SessionStart//-, command: 'bash "$CLAUDE_PROJECT_DIR"/.palm/assets/trailofbits__skills/gh-cli/plugins/gh-cli/hooks/persist-session-id.sh' }
        - { id: PreToolUse//Bash, command: 'bash "$CLAUDE_PROJECT_DIR"/.palm/assets/trailofbits__skills/gh-cli/plugins/gh-cli/hooks/intercept-github-curl.sh' }
      closure: { root: .palm/assets/trailofbits__skills/gh-cli, files: 8, tree: sha256:9f1c… }
      hash: sha256:a7cc7911…
    trust: [sha256:a7cc7911…]
```

Rules:

- The lock holds no absolute path, home directory, hostname, timestamp, machine fact, per-file
  hash, `createdDirs`, top-level `targets`, secret value or fragment value. A newcomer's lock for
  the same manifest is byte-identical to a veteran's.
- Every source an entry names is in `sources`, with enough (url, root, sha, layout, descriptor)
  to rebuild its index anywhere from the sha alone. On a clean clone, a bare install writes
  neither palm.yaml nor the lock for git sources.
- `content` is `hashPath` of the entity's source (directory or file). `render.<target>` is the
  render hash: sha256 over the sorted list of `(lock path, mode, sha256 of content)` of the
  files the target writes plus `(file, at, key, canonical JSON of the value)` of the fragments it
  merges, computed by `renderHashOf(rendered)` (domain) from `Target.render` alone. Its inputs
  are in lock form: paths are lock paths, and the target hands over file contents and fragment
  values with the expanded home directory and `$PALM_HOME` replaced by `<home>` and `<palm>`,
  and every secret value by its `${VAR}` reference plus a marker naming the variables written
  literally (the secrets policy). So a global render hashes the same on every machine (the
  absolute paths of a global Codex MCP entry included) and a rotated secret does not move it,
  while the bytes on disk keep the real paths. Two hashes per entry per target, not one per
  file.
- `files` lists every path palm wrote for the entry (lock form, sorted, directories by their
  files, closure files included). `merged` lists fragments by `(file, at, id, key)`: `id` is
  palm's identity, `key` finds the fragment on disk (section 2 "merged" and `LockMerged`).
  "Changed" (found by key, value differs) and "missing" (not found) are distinct states, so one
  plugin's removal cannot take another plugin's hook.
- `exec` and `trust` are section 7. `declined: true` marks a program the user said no to, or
  one that `install <source> --all` left out (section 6).
- `notes` persist what install printed once (dropped fields, skipped targets, "from command",
  "cursor reads .claude/skills"), and `describe` shows them.
- `targets` appears only when the entry is narrowed below the scope's set; the scope's set
  lives in palm.yaml.
- Deterministic writer: `sources` by name (code points), entries sorted by kind (KINDS order),
  name (case-insensitive), source, then name (code points); keys in the order above; `files`
  sorted; `render` in TARGET_IDS order; LF line ends; a header comment. Saving the same lock
  twice gives identical bytes.
- Version 1 and 2 files are read only by `palm migrate`; every other command reports
  `x palm.lock.yaml is version 2 (palm 0.1)` with the hint `palm migrate`.

### Global tokens

Under `-g` every lock path starts with a token: `<home>` (the home directory), `<palm>`
(`$PALM_HOME`), `<agents>` (`~/.agents`), `<claude>`, `<codex>`, `<copilot>`, `<cursor>`,
`<gemini>`, `<opencode>` (each harness home, override applied). `ScopePaths.abs` expands them
and `lockForm` produces them; a global lock is therefore portable between machines whose
overrides differ. `$PALM_HOME/applied.yaml` (`AppliedRecord`) records the real paths, per-file
hashes and fragments of the lock as last applied here, plus the lock's hash; a bare
`palm install -g` diffs the lock against it and the disk, so a removal that arrives through a
pulled `~/.palm/palm.lock.yaml` reaches every machine.

### Source tree hash

For a local source, `tree` is sha256 over the sorted `(relative path, mode bit, sha256 of
content with CRLF normalised to LF)` of every file under the source root. The scan's ignore
list does not apply (no `SCAN_IGNORE_DIRS`), so an edit anywhere in an entity moves the tree.
Left out are only `COPY_SKIP` (`.git`, `node_modules`, `.DS_Store`, `*.zip`), install output
directories and `.palm` at any depth, the root-level repository files (`AGENTS.md`,
`CLAUDE.md`, …), and for a source at `.` every lock-owned path (`isTreeExcluded`,
`src/domain/ignore.ts`). The source is the truth: a bare install re-hashes local
trees and re-renders entries whose `content` changed, updating `tree` and the entry hashes, and
`check` fails on drift (`x source ./agent-kit changed since palm.lock.yaml (tree 10934f8 →
f18c42f); run palm install and commit palm.lock.yaml`). A renamed directory is `E_SOURCE` on
every command. A local source refuses `ref` (`x a directory has no refs; use file://<path> for
a tagged checkout`).

## 5. Sources and the index

### Input forms

`palm install <source> …` and `Source` keys accept: `owner/repo`, `owner/repo/sub/dir`
(becomes `root`), `github:owner/repo`, any `https://`, `http://` (warning), `git://`
(warning), `ssh://`, `file://` URL or scp-like `user@host:path` address, optionally with
`#ref`, and a local path (absolute, `~/…`, `./…`). On the first `install <source> <names>` of
an undeclared source, palm declares it in palm.yaml: GitHub shorthand under its `owner/repo`
key, and a subdirectory under the full input as its name (`owner/repo/sub/dir`, with
`root: sub/dir` stored); a URL under a name derived from the repository (`repo`, or
`owner-repo` when taken; `--as <name>` overrides); a path under its project-relative `./dir`
key (a path outside the project is `E_SOURCE`). `#ref` becomes the source's `ref:`. Without
`#ref`, a newly declared git source gets its ref written explicitly and reported: with release
tags, `ref: ^M.m` of the latest one (`i ref ^1.2 saved to palm.yaml (latest tag v1.2.3); edit
ref: to track main`, where `main` is the repository's default branch); without tags, the
default branch by name (`i ref main saved to palm.yaml; edit ref: to pin a tag`). Re-declaring
an already declared location under a new `--as` name renames the source in palm.yaml and the
lock and prints `~ source <old> → <new> (renamed)` (`~ source acme → kit (renamed)`); another
ref is `~ source acme: ref ^1.2 → main` and needs confirmation or `--yes`.

A source with no names and no `--all` is fetched and indexed, listed, and not saved.

### Refs

`ref` is a tag, branch or sha, or a semver range: `^1.2`, `~1.2`, `>=1.2 <2`, `1.x`, `v1`. A
range is anything `semver.validRange` accepts that is not one exact version or a sha
(`isSemverRange`). `resolveRef` resolves it against the remote's tags (`git ls-remote --tags
--heads`): a branch or tag named exactly like the range wins (a `2.x` maintenance branch, a
moving `v1` tag); otherwise the highest tag satisfying the range (`v`-prefixed tags allowed,
prereleases only when the range names one); no match is `E_SOURCE` listing the nearest tags and
`git ls-remote --tags <url>` as the hint. The lock records `ref` (the intent), `resolved` (the
tag) and `sha`. A later fetch with the same range is a cache hit until `palm update`
re-resolves it. `update` moves the sha within the range; `update --to <ref>` moves the intent
in palm.yaml.

### Cache ids and checkouts

`sourceId` (cache dir name) = sanitized `host/owner/repo[/root]` with `/` → `__`; local
sources append a short hash of the real path. Checkouts live in `<cache>/<sourceId>/sha-<sha>/`
(one per sha, fetched once) with the record `sha-<sha>.json` beside (url, sha, and the ref
intents that resolved to it); the index file is
`<sourceId>@<sha>[~<layout hash8>].index.json` (local: `<sourceId>@<tree8>…`). A checkout of a
sha the lock names is the only network access a bare install needs. `palm cache clean` removes
`$PALM_HOME/cache` (sources stay declared).

### Running git

`src/core/git-exec.ts` is the only place palm spawns git:

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
  -c protocol.file.allow=<user for local sources, else never> -c credential.interactive=false`,
  and `--` before positional URLs/refs.
- ssh never prompts: for an ssh remote palm sets `-c core.sshCommand=<the user's global
  core.sshCommand, or ssh> -o BatchMode=yes`; a user `GIT_SSH_COMMAND` gets `-o BatchMode=yes`
  appended when it runs OpenSSH and has no BatchMode; `GIT_SSH` (a bare program) is left alone.
- Timeouts: 120 s for `ls-remote`, `clone` and `fetch` (`E_NETWORK`, hint: check the network,
  `git ls-remote <url>`), 30 s for local steps (`E_GIT`, hint: `palm cache clean`). A timed-out
  fetch is never retried with a second clone.
- Source URLs pass one validator (`validateSourceUrl`) on input and when the manifest loads:
  `https://`, `http://` and `git://` (warning), `ssh://`, `file://`, `user@host:path`, absolute
  paths. Leading `-`, `ext::`/`fd::`/any `<x>::` transport, other schemes and control
  characters are refused.
- `git` runs with `cwd` inside the cache only; palm never runs git inside the project except
  read-only `git ls-files`, `git check-ignore` and `git rev-parse --show-toplevel` for the checks
  in sections 6 and 8, and `git diff --stat` after an update, each with the clean environment
  and a 30 s timeout, and each optional
  (no git, no repository: the check is skipped with a note).

### Index

The index for a source is the `ScanResult` of `scanSource()`, cached with the sha (or tree)
and the layout hash. The cache file records `format` (`INDEX_FORMAT`, now 3) and a `cacheKey`
(format, sha or tree, root, layout); a file is used only when its shape checks out (`format`
matches, `cacheKey` a string, `entities` and `warnings` arrays, every entity with string
`kind`/`name`/`path` and an object `def`); anything else is a cache miss and the source is
rescanned once, never an error. The index stores redacted hashes for secret-shaped values, never
the values (section 8).

### Scan rules (priority order)

0. Ignore: `node_modules`, `test(s)`, `fixture(s)`, `eval(s)`, `example(s)`,
   `template(s)`, `docs`, `website`, `dist`, `build`; install outputs
   `.agents/skills`, `.claude/skills`, `.github/{skills,agents,instructions,prompts}`,
   `.cursor/rules`, `.palm`; root `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` (contributor guidance).
   Include dot-directories otherwise (openai/skills uses `skills/.curated`).
1. `layout` descriptor on the source: use it, skip detection.
2. `apm.yml` with `.apm/`: APM package: primitives from `.apm/{skills,agents,instructions,prompts,hooks}`.
   `dependencies.apm` is never followed: one warning lists them with the `palm install
   <owner/repo>` commands.
3. Marketplace file (`.claude-plugin/marketplace.json` > `.cursor-plugin/marketplace.json` >
   `.github/plugin/marketplace.json` > `.agents/plugins/marketplace.json`): each entry with a
   relative source becomes a `plugin` entity scanned at that path; entries with remote sources
   are surfaced as `warnings`, not fetched (`remote plugin "x" (<source>) not fetched: declare
   it: palm install owner/repo[/path][#ref] <names>`). A single entry with source `./`
   collapses into the root plugin. `strict:false` + `skills:[...]` = exact subset.
4. Per-plugin manifest (`.claude-plugin/plugin.json` > `.cursor-plugin/plugin.json` >
   root `plugin.json` with agent-plugins `$schema` > `.codex-plugin/plugin.json` >
   `gemini-extension.json`): pick one, never union. Claude semantics: `skills` adds to
   default `skills/` scan; `agents`/`commands` replace defaults; `hooks`/`mcpServers` merge
   with `hooks/hooks.json`/`.mcp.json`; hooks may be inline in the manifest.
5. Convention scan: root `SKILL.md` → one skill; else `**/SKILL.md` to depth 5
   (a SKILL.md under another SKILL.md is a sub-skill: record `parent`);
   agents `agents/**/*.md` + `**/*.agent.md` with `name`+`description` frontmatter (exclude
   `agents/openai.yaml`, README); commands `commands/*.md`, `commands/*.toml`, `prompts/*.prompt.md`
   (indexed as skills with `fromCommand`, note `from command <file>`); hooks `hooks/hooks.json`,
   `hooks/*/hooks.json`; mcp `.mcp.json`/`mcp.json` (wrapped or flat);
   instructions `rules/*.mdc`, `*.instructions.md`, `instructions/*.md`.

Names: skill = frontmatter `name` (fallback dirname; if invalid slug, slugify dirname; if it
differs from dirname keep frontmatter name and warn); a command-as-skill = file stem; agent =
file stem minus `.agent`, `name` with spaces → `displayName`; plugin = manifest name →
marketplace entry name → dirname; mcp = server key; hook = a plugin's hook set is named after
the plugin, `hooks/<name>/hooks.json` is named `<name>`, and a root `hooks/hooks.json` outside a
plugin is named after the last path segment of the source's name (`agent-kit` for
`./agent-kit`, `skills` for `mattpocock/skills`). A skill and a command with one name in
one source: the skill wins, the command is dropped with a warning.
Version = frontmatter `metadata.version` → `version` → manifest `version` → tag.

Activation: `.mdc` `alwaysApply: true` → `always`; `globs` → `paths`; a description without
globs → `on-request`; neither → `manual`. `*.instructions.md` `applyTo` → `paths`, else
`always`. `instructions/*.md` and APM instructions → `always`. `.claude/rules` `paths:` →
`paths`, else `always`.

One walk: the scanner lists the source once (relevant files only: md/mdc/json/toml and
`apm.yml`, ignore rules applied, in-source symlinks followed with loop protection) and builds
directory indexes from it. Plugin defaults (`skills/*`, `agents/`, `commands/`, `rules/`),
declared paths and the undeclared-member warning are lookups, not rescans. Declared plugin
globs and descriptor globs run fast-glob against the index, so they never walk the disk again
and never match anything outside the source or excluded by the layout.

After the rules, hooks and MCP servers get their references resolved (section 2) and their
closure listed; an unresolved reference is a critical `unresolvable-reference` issue.

### Scan issues

Every entity except plugins is checked for hidden Unicode (`src/lib/unicode.ts`
`scanHiddenUnicode`): critical = bidi overrides and isolates (U+202A–U+202E, U+2066–U+2069),
tag characters (U+E0000–U+E007F), variation selectors 17–256 (U+E0100–U+E01EF); warning =
zero-width and other invisible format characters. Files checked: a skill's whole directory
(walked like the deploy copy), the file of an agent, instruction, MCP config or hook set, every
hook file merged into a plugin's hook set, and every file of a hook's or server's closure, so a
trojan-source character in a script the hook runs refuses the hook at install. Binary files (a
NUL byte in the first 8 KB) and files over 1 MB are skipped.

Secret-shaped literals (section 8) in MCP `env`, `headers`, `args`, `url`, hook commands and
closure files become `secret-literal` issues (a warning inside a closure file, whose script is
copied as it is); the index stores `<redacted sha256:8>` in place of the value. A literal secret
is not a refusal of the entity: the render writes the `${KEY}` reference in its place and the
install summary says which variable to export; `--force` never writes the literal.

Each finding is one `Entity.issues` entry `{ code, severity, message, file }`; each affected
entity also adds one line to `ScanResult.warnings`. Entities without findings have no `issues`
key. A critical hidden-Unicode or unresolvable-reference issue refuses the entity at install
with no override (fork the repository).

## 6. Engine

### Install with names

```
palm install <source> [[kind:]name…] [--all] [-g] [--dry-run] [--review] [--force] [--yes] [--allow-exec …] [--secrets literal]
```

1. Scope guards (section 2; a declared local source outside the project is `E_SOURCE`), then
   take the scope lock. Load the manifest and the lock (`E_USAGE` + `palm migrate` for old
   formats).
2. Resolve `<source>`: a declared name or alias; else CLI input (section 5) fetched and indexed
   without saving. No names and no `--all`: print what it offers (kind, name, description,
   version; hooks and stdio servers marked "a program; asks before installing") with a
   pasteable next line, exit 0.
3. Match names within that source only (`[kind:]name`, case-insensitive; `kind:` required only
   when one name means two kinds: `E_AMBIGUOUS` listing `kind:name` forms). Nothing matches:
   `E_NOT_FOUND` whose first line is a pasteable command (fuzzy suggestion from the source, else
   `palm install <source>` to list). `plugin:<n>` (or a name that is a plugin) expands to its
   members, recorded as `plugins:` in palm.yaml with the members' lock entries carrying `via`;
   `only`/`exclude` from the request narrow it. An agent's `skills:`/`mcpServers:` are not
   installed: one info line names `palm install <source> <names>` for them.
4. Determine targets: palm.yaml `targets`, else detection (project scope: written to palm.yaml
   by the first install that places something, one info line says so; `-g`: `~/.palm/palm.yaml`
   `targets`, else detection, written the same way), narrowed by `--targets` on the request
   (written per entry). No interactive target picker.
5. Render every (entity, target) with `Target.render` (pure) and compute `render` hashes.
   Refusals become failures with a runnable hint: critical issues (no override for hidden
   Unicode and unresolvable references), a whole-file collision with a foreign file (`--force`
   replaces it), an edited owned file (`--force`), a secret decision `refused` for a literal the
   user typed. A literal from a source is no refusal: it renders as `${KEY}` (section 8).
6. Exec units (section 7): build one per hook entry and stdio server from the renders and the
   closure; units whose hash the lock already trusts pass; the rest go through `askConsent`
   (prompt, `--allow-exec`, or `E_UNTRUSTED_EXEC` without a terminal). A declined unit installs
   nothing for that entry (`declined: true`), the run goes on. `install <source> --all` leaves
   executables out without a prompt and prints, per skipped program:

   ```
   ! hook <name>  runs a program on your machine; not installed
       see it:      palm install <source> <name> --dry-run
       install it:  palm install <source> <name>
   ```

   They are recorded as declined, so bare installs stay quiet. A program named explicitly
   (`palm install <source> <name>`) goes through consent, and `--allow-exec` entries on the
   command line still allow a program under `--all`. `--review` (install and update) pages every
   script body through `Output.page` before the prompt, and with `--dry-run` instead of it.
7. Secrets (section 8): `decideSecret` per destination; `resolveSecrets` only under `literal`.
8. Apply per (entity, target) through `Target.apply` (transaction per target; a failed target
   leaves the others, status `partial`, exit 1). The closure files are part of the render
   (`Rendered.files`, with their modes), so the asset directory is written in the same
   transaction. Before overwriting a re-rendered or updated entity, find what the person
   changed since palm wrote it (`src/engine/edits.ts`). At risk is only what the entry owns and
   the new render would overwrite or drop. First, offline: per target, hash the entry's files on
   disk the way `renderHashOf` hashes a render's `files` (lock path, mode, sha256 of the
   content, tokenised as in section 4), with its fragments read by key from their shared files
   and hashed as a render's fragments, and compare with the lock's `render.<target>`: equal
   means nothing there is an edit. Else compare file by file with the render at the locked sha
   (from the cache); a file that differs is `! modified (kept)` and a failure
   (`palm install <source> <name> --force` overwrites it). When neither decides (the locked
   commit is not cached and the remote no longer has it; an in-repo source moved on), every
   path at risk is kept: `! modified (kept)` with the note `locked commit <sha7> unavailable;
   palm install <source> <kind:name> --force overwrites`, exit 1. palm never overwrites a path
   it could not check.
9. Replace the previous entry: undeploy only what the new entry no longer lists (files by path,
   fragments by `(file, at, key)`), after the new deploy succeeded; an edited file the new entry
   no longer lists is kept (and no longer palm's), never deleted.
10. Save the lock and the manifest after every entity and again in `finally`; SIGINT stops after
    the current entity (exit 130); a second Ctrl-C ends palm at once.
11. Print the status lines, then every failure (`x kind name from source → target: message` and
    the hint), then the warnings, then `N installed. Commit palm.yaml, palm.lock.yaml and
    <dirs> together.` (project scope, first install).

Statuses: `+ installed` (written on every target), `~ updated` (a new sha or content of a git
source), `~ re-rendered` (another render: a target added, a secrets policy changed, a changed
in-repo source),
`↺ restored` (a missing generated file put back), `= unchanged` (render equals lock and disk
equals render on every target), `! modified (kept)` (disk differs from the render; kept;
`palm install <source> <name> --force` restores), `! partial` (one target refused or failed;
the lock keeps what succeeded per target; exit 1), `⊘ skipped` (a target has nothing for this
kind, noted), `- removed`, `x failed` (nothing written). `unchanged` promises exactly what it
says; `check` reports every other state.

Failures are never exit 0. A request that names nothing throws (`E_NOT_FOUND`, `E_AMBIGUOUS`,
`E_SOURCE`); per-entity and per-target problems are `failures` and the CLI exits 1.

### Bare install (sync)

`palm install` with no arguments makes the disk match palm.yaml and the lock, offline when the
cache holds every sha:

- Effective set E = entries of palm.yaml (0.3: ∪ overlay − disables), rendered for the scope's
  targets. Lock L. Disk D (project: the files; global: `applied.yaml` plus the files).
- In E, not in L (a hand edit of palm.yaml, a new clone whose lock is behind): resolve, render,
  apply, add to L. A source not in `sources` is resolved from palm.yaml (network) and added.
- In L, not in E (an entry removed from palm.yaml by hand or by a teammate): undeploy by the
  lock (files by path when the disk matches the render, else `! kept <file>: you changed it
  since palm wrote it (palm remove <source> <name> --force)`); drop from L.
- In both: recompute the render from the cache (fetching a locked sha only when it is not
  cached; a local source is re-hashed and re-rendered when its tree changed, `~ re-rendered`).
  Render equals `L.render` and every file equals the render: `= unchanged`. A file missing:
  `↺ restored`. A file differing from the render: `! modified (kept)`, exit 1. A fragment
  missing: restored; changed: `! modified (kept)`. Render differs from `L.render` (a changed
  local source, an edited pin, a palm upgrade that renders differently): first find the edits
  as in "Install with names" step 8 (the disk against `L.render`, then the render at the
  locked sha; an edit, or a path neither can check, is `! modified (kept)`, exit 1), then
  apply and update L; a changed in-repo source reports `~ re-rendered`.
- A ref in palm.yaml that the lock's `ref` no longer equals (an edited pin) is resolved fresh.
- Exec units are replayed from `trust`; a unit whose hash is not trusted asks (or fails without
  a terminal), never silently.
- The lock is written only when something in it changed (a new entry, a moved local tree, a
  new trust). On a clean clone with committed outputs and a current lock, a bare install writes
  nothing and prints `= unchanged` per entry.
- `--dry-run` prints what it would do with `would install` / `would restore` and writes
  nothing.

Under `-g` the same three-way diff runs with `applied.yaml` as the machine record; after a
successful run it is rewritten.

### Remove

`palm remove [source] [[kind:]name…] [--exclude] [-g] [--force] [--yes]`: select by name (and
kind when ambiguous; and source when the name exists in two sources: `E_AMBIGUOUS` listing
`palm remove <source> <name>`), undeploy exactly the lock's files and fragments (a fragment by
`(file, at, key)`; a JSON, TOML or markdown file left empty is deleted; emptied directories are
pruned up to but never including the harness config dirs; `.palm/assets/<source>/<entity>` goes
with the entry), update the lock and palm.yaml (a source with no entries left is dropped).
Already absent: `i <name> is not installed`, exit 0. A file the user changed since palm wrote it
(disk differs from the render): the entity stays installed and locked, `x <kind> <name>: <file>
was modified since install` with the hint `palm remove <source> <name> --force`, exit 1. A
plugin member: `x brainstorming belongs to plugin superpowers: exclude it for the team (palm
remove obra/superpowers brainstorming --exclude) or remove the plugin`; `--exclude` adds
`skill:brainstorming` to the plugin entry's `exclude:` and removes the member. Removing a plugin
removes its members unless another plugin still declares one (kept, re-parented, a warning
names the command that removes both).

### Update

`palm update [sources…] [--to <ref>] [--dry-run] [--review] [-g] [--yes] [--allow-exec …]`:

1. Plan (nothing in the scope is written): for each selected source (all when none), resolve
   the ref intent against the remote (`ls-remote`), fetch the new sha into the cache, index it,
   and compare every entry: `~ updated` (new content), `+ added` / `- removed` (plugin members
   the new version declares or dropped), `= unchanged`, `x failed` (unreachable source, an
   entry the source no longer has), `⊘ skipped` (a local source; `update` never touches local
   sources, a bare install does). `--to <ref>` moves the intent in palm.yaml for the named
   sources. Every entry whose exec hash changes or is new is listed with the unit (section 7).
2. Print the plan:

   ```
   Update plan (project scope)
   mattpocock/skills   ^1.2   v1.2.0 (3f2a1c9) → v1.2.3 (8be01d4)
   ~ updated    skill   tdd
   acme-kit            ^1     v1.1.0 (5c0d2e1) → v1.1.1 (61ec102)
   + added      skill   review (plugin:kit)
   = unchanged  agent   reviewer
   ~ updated    hook    team-skills
   ! hook team-skills: setup.sh changed (sha256:b3f09e41… → 6d2a0c57…); d shows the diff
   ! you changed these files since palm wrote them; palm overwrites them only with --force:
       .claude/skills/tdd/SKILL.md  (skill tdd)
   ```

   `--review` prints, before the question, every changed executable's script bodies as a
   unified diff against the trusted version (and, from 0.3, a text diff of every changed skill,
   instruction and agent), paged on a terminal. `--dry-run` is the outdated report: it prints the plan and
   the source rows and exits 0 (1 with `--strict` when anything is behind its intent).
3. Ask `Apply N changes? [y/N]` (default No; No changes nothing, exit 0). Without a terminal
   `--yes` is required, else `E_NON_INTERACTIVE` naming `palm update … --yes`. `--yes` never
   covers executables: changed and new units go through consent separately (section 7).
4. Apply: install the changed entries as in "Install with names"; move `sources.<n>.sha` and
   `resolved`; write the lock; print `git diff --stat` of the scope when git is present.

`update` moves the sha within intent, and re-pins entries whose content did not change, so
`--dry-run` goes quiet after an update.

### Check

`palm check [-g] [--json]` is read-only and runs every check, in this order, printing one line
per check (`✓ manifest and lock agree`, `x 2 files differ from the lock`), then one line per
problem with the command that fixes it, then `no problems` only when both the fail and the warn
count are zero. Exit 1 on any `fail`; warnings alone exit 0. `--json`: `{ ok, checks: [{ id,
label, status, problems: [{ entity, file, message, fix }] }], warnings }`.

| id | fails when | fix line |
|---|---|---|
| `manifest-lock` | an entry of palm.yaml has no lock entry, a lock entry has no manifest entry, a source's `ref` differs from the lock's, a `sources` entry lacks url/sha, an `@source` or `kind:name` in `only/exclude` names nothing | `palm install` |
| `lock-disk` | a listed file is missing or its content differs from the render (recomputed from the cache; a sha not cached is fetched, the one network access); a fragment is missing or changed | `palm install` (restore) / `palm install <source> <name> --force` (edited) |
| `local-sources` | a local source's tree differs from `sources.<n>.tree` | `palm install` and commit palm.lock.yaml |
| `exec-trusted` | an entry has `exec` whose hash is not in `trust`, or a merged command on disk differs from `exec.commands` | `palm install --allow-exec <key>=<hash>` |
| `hook-scripts` | a command in `exec.commands` names a file that is missing or not executable | `palm install` |
| `secrets` | a generated file that git tracks, or one readable by others, holds a secret-shaped literal; lists every `${VAR}` the installed servers need and whether it is set (unset: warning) | `palm install <source> <name> --force` after fixing the source, or `export VAR` |
| `git-ignored` | an output directory or `.palm/assets` is ignored by git (`git check-ignore`), so teammates will not receive the files | edit `.gitignore` |
| `sources-declared` | a lock source is not in palm.yaml, or a declared local source is missing on disk | `palm install` / restore the directory |
| `links` | an output path resolves outside the scope, a dangling link under an output dir, a declared source overlapping an output directory | move the source |
| `hidden-unicode` | a critical finding in a generated file (warning for zero-width) | fix the source; `palm install --force` |
| `double-load` | (warning) a harness would load one entity twice (`AGENTS.md` and `.cursor/rules`; two skill copies for cursor) | 0.3 carrier rule |
| `block-size` | (warning) a root `AGENTS.md`/`GEMINI.md` block above 24 KiB; fail above the harness cap | move entries with `at:` (0.3) |

Checks that need git run only when the scope is inside a repository; otherwise they are listed
as `skipped (not a git repository)`. `check` never fetches for a local source, never prompts,
never writes.

### Migrate

`palm migrate [-g] [--dry-run]` (0.2 only; removed in 0.3) reads the old palm.yaml, palm.lock.yaml
(v1 or v2) and `~/.palm/config.yaml`, and writes the new manifest and lock:

- Every alias the lock references becomes a `sources` entry keyed by `owner/repo` when the URL
  is a GitHub repository, else by the alias, with url, root, layout and the locked ref; the
  alias is kept as `alias:` when it differs from the key. A source that came from config.yaml
  prints `~ palm.yaml: source acme added from ~/.palm/config.yaml, needed by 3 entries; commit it`.
- `name@alias#ref` becomes an entry under its source; when entries of one source disagree on
  refs, the most common ref wins and a warning lists the others (`i tdd was pinned to v1;
  mattpocock/skills now tracks v1.2.3; pin the source or split it`).
- A plugin becomes a `plugins:` entry with `exclude:` for members that were uninstalled; a
  command becomes a skill of the same name; a registry MCP server is copied from the rendered
  `.mcp.json` (or the harness file that has it) into `mcp:`; `--target` leaks (an entry on a
  target the scope set lacks) become per-entry `targets:` with a note; an `@mine` entry warns
  and names the directory to copy the file into.
- `.palm/hooks/<n>` is deleted after the assets are re-copied from the cache at the locked sha
  into `.palm/assets/<source>/<n>` (fetched when missing); `.gitignore`'s `.palm/` line becomes
  `.palm/local/`; the executables re-vendored are printed once for the one consent (the trust
  goes into the new lock).
- Then a bare install adopts identical files, and the report lists the files to commit.
- Under `-g`: absolute paths become tokens; literal secrets in the harness files are listed with
  the rotate message; `~/.palm/config.yaml` is left in place and reported as unused
  (`i ~/.palm/config.yaml is no longer read; delete it`).

`--dry-run` prints the new palm.yaml to stdout and writes nothing.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success (also `--help`, `--version`, bare `palm`); warnings never change it |
| 1 | failure: any `PalmError` except `E_USAGE` and `E_CANCELLED`; an engine result with a failed, partial or modified outcome or a `failures` array; `check` with a failed check; an internal error (printed with `this is a palm bug; report it with --json output`) |
| 2 | usage: commander errors (unknown command or option, missing argument) and `E_USAGE` |
| 130 | cancelled: `E_CANCELLED` (Esc or Ctrl-C in a prompt, a declined plan); nothing more is printed |

`src/cli.ts` is the only place that exits (`src/commands/main.ts` computes the code). The
exit-code list is in the docs, not in `--help`.

## 7. Executable content and consent

Executable material is anything palm writes that makes a harness, or a program it starts, run
code: hook commands (per event and matcher) and stdio MCP servers (command, args, cwd,
environment keys), together with the scripts those reach (the closure). Prompt hooks
(`type: prompt`) are text sent to the model: listed, never called a command, never gated.
Skills that cite scripts (`scripts/*.py`) are listed by `describe`, not gated: the harness gates
the model's shell.

One exec unit per hook entry and per stdio server (`ExecUnit`, `src/exec/units.ts`):
`hash = sha256(canonical commands in id order ‖ events ‖ matchers ‖ env keys ‖ cwd ‖
closure tree)`, where `canonical` is the command before per-harness rendering (placeholders
intact), and the closure tree is the Merkle hash over sorted relative paths, executable bit and
content. Unit ids are `<Event>//<matcher or ->[#n]` in Claude event names for hooks and `stdio`
for an MCP server. A commit bump with the same hash, a new target and a palm version do not
move it; any change to a command, a byte or the executable bit of a closure script (git
sources; in-repo sources below), an env key or cwd does.

Consent semantics:

- Shown, terminal or not, before anything is written: per unit, kind, name, source, commit
  (short sha, ref, author date), each command as event, matcher and canonical text, each
  target's rendered command and the file it lands in, the closure size and per script `path
  mode size sha256:8` (first three, then `… N more`). `v` prints every script body from the
  pinned commit in the cache, paged; on update `d` prints a unified diff against the trusted
  version. A summary line comes first: `This install adds 2 programs that will run on your
  machine.` (`This update …` on update). `--review` on install and update prints every script
  body (`Output.page`) before the question, and with `--dry-run` instead of it. Prompt hooks follow as `Also 2 prompt hooks (text sent to the model; no program
  runs): fp-check Stop, SubagentStop.`
- The default answer is No. Enter declines.
- `--yes` accepts defaults for everything that is not executable (pickers, "apply plan"). It
  never consents.
- Consent is recorded once, in the lock (`trust: [hash]` on the entry), and replayed without
  any flag: a unit whose hash is trusted installs silently on install, bare install and in CI.
  The lock diff is the team's consent record: one hash line beside readable `command:` lines.
- Re-consent triggers: a new unit; any change of the hash; a trust entry removed. Not
  triggers: a commit bump with the same hash, a new target, a palm version.
- Non-interactive consent is hash-pinned: `--allow-exec hook:gh-cli@trailofbits/skills=<hash>`
  (comma-separated for several; the hash may be a prefix of at least 16 hex characters, and the
  line palm prints carries the full hash; the key is `<kind>:<name>@<source name>`, and
  `mcp:<name>@manifest` for a server declared under `mcp:` in palm.yaml). `--allow-exec all`
  works only on a terminal; without one it is `E_USAGE`. A unit not covered without a terminal
  is `E_UNTRUSTED_EXEC`; its `review:` line repeats the command as typed plus `--dry-run
  --review`, its `then:` line the command plus the `--allow-exec` entries:

  ```
  x 2 programs need your consent and there is no terminal
    review:  palm install --dry-run --review
    then:    palm install --allow-exec hook:gh-cli@trailofbits/skills=sha256:a7cc7911f2bd0a61d9686cbc62fcfb17c8e8276fa2ea5aa0c69e646a0b23ad60,mcp:team-helper@acme-kit=sha256:75aafd9baefdaaee905cd992fe17dbe17b4fa390f7f487399d6a57f282682c79
  ```

- Declining a plugin's hook installs the rest (`declined: true`), so bare installs do not ask
  again; `palm install <source> hook:<name>` asks again.
- `check` fails on an untrusted unit and on a merged command that differs from `exec.commands`.
- palm never runs what it installs; it runs only git (the script viewer pages through
  `$PAGER`).
- In-repo sources have no closure in the exec hash: their scripts run in place, and the pull
  request diff is the review of a script edit.

The prompt:

```
This install adds 2 programs that will run on your machine.

  1. hook gh-cli  from trailofbits/skills  (commit 82fe822, v2.1.0, 2026-07-14)
     SessionStart          bash "$CLAUDE_PROJECT_DIR"/.palm/assets/trailofbits__skills/gh-cli/plugins/gh-cli/hooks/persist-session-id.sh
     PreToolUse  Bash      bash "$CLAUDE_PROJECT_DIR"/.palm/assets/trailofbits__skills/gh-cli/plugins/gh-cli/hooks/intercept-github-curl.sh
     targets: claude (.claude/settings.json), cursor (.cursor/hooks.json)
     scripts: 8 files, 21 KB  ->  .palm/assets/trailofbits__skills/gh-cli/  (committed with your repo)
       plugins/gh-cli/hooks/persist-session-id.sh     755   612 B   sha256:1b9e04c2
       plugins/gh-cli/hooks/intercept-github-curl.sh  755   1.1 KB  sha256:77d0a9f1
       ... 6 more  (v shows every script)
  2. mcp team-helper  from acme-kit  (commit 61ec102, v1.1.1)
     stdio  node ".palm/assets/acme-kit/team-helper/server.js"   env: none
     targets: claude (.mcp.json), cursor (.cursor/mcp.json)

  Also 1 prompt hook (text sent to the model; no program runs): fp-check Stop.

palm never runs these itself. If you say yes, their hashes go into palm.lock.yaml,
so teammates and CI install them without being asked; any change asks again.

Allow these 2 programs to run?  [y/N/v=view scripts]
```

Deliberately not built: a minimum-age or new-maintainer gate, injection scans of prose,
sandboxing or executing scripts to inspect them, signature verification (PLAN.md section 6).

## 8. Secrets

`src/secrets` scans and decides; targets render.

What is scanned, and when: MCP `env` values, `headers`, `args`, URLs (userinfo, `token=`),
hook commands, every file in a closure, and palm.yaml itself, at index (source content),
install and update (values about to be written) and check (what is on disk). Shapes: known
prefixes (`sk-`, `ghp_`, `github_pat_`, `gho_`, `xox[abp]-`, `AKIA`, `AIza`, `glpat-`,
`-----BEGIN`), `Bearer <token>`, and any value of 20 or more characters with entropy above 3.5
bits per character under a key matching `/(key|token|secret|password|authorization)/i`.
Runtime variables (`RUNTIME_VARS` in `src/lib/placeholders.ts`: `CLAUDE_PLUGIN_ROOT`,
`CLAUDE_PROJECT_DIR`, `workspaceFolder`, `HOME`, …) are never secrets and are left as written.

Decisions (`decideSecret`):

- A literal that arrives from a source is never written: palm writes `${<KEY>}` and says so
  (`! docs: headers.Authorization held a literal token in the source; written as
  ${DOCS_TOKEN}; export it before starting Claude Code`). `--force` does not override. It is
  not a refusal of the entity: the index redacts the value, the render writes the reference,
  and the install summary says which variable to export.
- A literal typed by the user (`--env X=sk-…`, `--header`, a value in palm.yaml `mcp:`) in
  project scope needs `--secrets literal`; without it palm writes the reference and names the
  variable. With it, palm warns when the destination is inside a git worktree and not ignored
  (`git check-ignore`), so a new `.mcp.json` that git would commit warns before it is tracked.
- Global scope writes environment references only. `literal` is allowed only when the
  destination's real path lies outside every git worktree (`git rev-parse --show-toplevel` on
  the destination's directory fails): `x ~/.cursor/mcp.json resolves to
  ~/dotfiles/cursor/mcp.json, a tracked file; refusing to write a literal secret there (use
  env-ref, or --force)`.
- `--dry-run` runs the same decision and prints it (`would write the literal value of
  BRAVE_API_KEY into ~/.codex/config.toml (mode 600)`).
- The rendered policy is part of the render hash: after `palm install -g --secrets env-ref`
  the entry is `~ re-rendered (secrets: literal → env-ref)`.
- Values are never cached: the index stores `<redacted sha256:8>`, scans run on the checkout,
  and the cache directory is mode 0700. Under `literal`, `resolveSecrets` reads `process.env`
  and asks with masked prompts only on a terminal (`E_NON_INTERACTIVE` otherwise, hint
  `--secrets env-ref`).
- `check` fails on a literal in a tracked or world-readable file, and lists every required
  variable and whether it is set (warning).
- When palm replaces a literal it found on disk (a generated file it owns), it prints the
  rotate message: `! inbound: .cursor/mcp.json held a literal value for x-inbound-api-key
  (tracked in git). palm replaced it with ${INBOUND_API_KEY}. The old value stays in git
  history: rotate it. export INBOUND_API_KEY before starting Cursor.`

Env-ref syntax per harness: claude and gemini `${VAR}` (optional secrets `${VAR:-}` for
Claude, which refuses an unset variable without a default), copilot CLI `${VAR}`, cursor and
VS Code `${env:VAR}`, codex `env_vars = ["VAR"]` and `bearer_token_env_var` for
`Authorization: Bearer ${VAR}`, else `env_http_headers`, opencode `{env:VAR}`. Every JSON/TOML
file of a harness that can hold secrets (the MCP config, `settings.json`, `hooks.json`,
`opencode.json`, `mcp-config.json`) is created 0600 at global scope, and a file palm writes a
literal secret into is set to 0600 even when it existed. HTTP servers without declared secrets:
url only; harnesses run OAuth on first connect (said in the summary).

## 9. MCP servers

An MCP server is declared once and rendered into every target's file and syntax. Four ways in,
none of them a registry:

1. From a source: `palm install <source> mcp:<name>` takes the server from the source's
   `.mcp.json` or plugin manifest, like any other entity (a stdio server is an exec unit).
2. From the README snippet: `palm install mcp --snippet -` reads a `{ "mcpServers": { … } }`
   block (or the flat form, or the VS Code `servers` form) from stdin, `--snippet server.json`
   from a file (`--json` stays the global flag for machine-readable output), and converts every
   server in it (`parseMcpJson`): `command`, `args`, `env`,
   `cwd`, `url`, `headers`, `type` become an `mcp:` entry in palm.yaml; a secret-shaped literal
   in the snippet becomes `${NAME}` with a notice; an existing name is `E_CONFLICT` unless
   `--force`.
3. By flags: `palm install mcp docs --url https://example.com/mcp --header
   'Authorization=Bearer ${DOCS_TOKEN}'` for a remote server; `palm install mcp xcodebuild
   --command npx --arg -y --arg xcodebuildmcp@latest --env KEY=${KEY}` for stdio
   (`--transport http|sse|stdio` when it cannot be inferred).
4. By hand, under `mcp:` in palm.yaml, and a bare `palm install`.

The lock records a hand-declared server as an entry with `source: manifest` and `path: mcp/<n>`;
the `--allow-exec` key of such a stdio server is `mcp:<name>@manifest`.
`get mcp` shows every server with the variables it needs and whether they are set;
`describe mcp <name>` prints the rendered block for each harness. A stdio server goes through
consent; a remote server does not, and the prompt says which is which.

## 10. Command grammar and output

Every command is `palm <verb> …`. Eight verbs; `--help` fits on one screen and lists no exit
codes.

| Verb | Aliases | Arguments |
|---|---|---|
| `init` | | `[--target <ids>] [--here]`; `-g [--target <ids>]` writes `~/.palm/palm.yaml` |
| `install` | `add`, `i` | `<source> [--grep text]` (listing); `<source> [[kind:]name…] [--all] [--as name] [--targets ids] [--at dir] [--review]`; bare; `mcp <name> [flags]`; `mcp --snippet <file or ->` |
| `remove` | `uninstall`, `rm` | `[source] <[kind:]name…> [--exclude]` |
| `update` | `up` | `[sources…] [--to ref] [--dry-run] [--strict] [--review]` |
| `check` | | `[--json] [--quiet]` |
| `get` | `list`, `ls` | `[kind] [names…] [-s/--source s] [--files]`; `get sources`, `get targets`, `get all` |
| `describe` | `info` | `<[kind:]name, path or file name>`; `<source> <name>`; `source <s>`; `target <t>` |
| `create` | `new` | `<kind> <name> [--in dir] [--description text]` |

Utilities: `migrate [--dry-run] [--review]` (0.2), `completion bash|zsh|fish`, `cache clean
[--yes]` (bare `cache` prints its help). `init --targets` and `install --target` are accepted
as the other spelling. `palm help <word>` for a word that is no command is `unknown command`,
exit 2.
Global flags: `-g`, `--dry-run`, `--force`, `-y/--yes`, `--allow-exec <list|all>`, `--offline`,
`--json`, `--secrets env-ref|literal`, `--local` (0.3; `E_USAGE` "palm.local.yaml arrives in
0.3" in 0.2). Colour follows the terminal (`NO_COLOR` honoured); there is no `--no-color` and
no `--verbose` (debug lines with `PALM_DEBUG=1`).

Kind words for `get` and `describe`: singular, plural and short names (`sk`, `ag`, `ins`, `hk`,
`mcp`, `pl`), plus `source`/`sources`/`src`, `target`/`targets`/`tg`, `all` (get only). `cmd`,
`command(s)` map to skills with a note. `origin`/`orig` map to `source` for one release.

Hidden aliases for one release: `palm install [kind] name@alias` (the alias resolved against
palm.yaml: a source name or alias, else the one declared source whose repository or owner it is,
else the alias's repository in `~/.palm/config.yaml`; unresolved it is `E_USAGE` with the 0.2
form; a `#ref` is `E_USAGE` naming `palm install <location>#<ref> <name>`) and `palm install
origin <spec>` (several repositories: one line each) print `i … is now: palm install …` and run
it; `doctor`, `audit`, `outdated`, `why`, `find`, `search`, `config` print one line naming the
replacement (`check`, `update --dry-run`, `describe`, `install mcp --snippet -`) and exit 2. The
removed install flags answer the same way: `--frozen` prints `palm check` and runs it; `--from`,
`--ref`, `--alias` and `--project` are `E_USAGE` ending with the 0.2 command line.

`install <source>` first word: a declared name or alias, `owner/repo…`, a URL, a path, or the
reserved word `mcp`. A first word that is none of these (`palm install superpowers`,
`palm install tdd`) is `E_USAGE` whose first line is the fix:

```
x "superpowers" is not a repository. palm installs from git repositories:
    palm install <owner/repo> [names...]      for example  palm install obra/superpowers
  Not sure which repository? https://github.com/search?q=superpowers+SKILL.md&type=code
```

Before that answer, palm looks the word up in what it knows: under `-g` a source of the project
(`acme is a source of this project; -g uses the sources in ~/.palm/palm.yaml only`), an installed
entry (`palm install <its source> grill`), a directory of the project (`palm install
./.agents-kit`), a declared source whose owner or repository the word is or whose name it nearly
is (`did you mean mattpocock/skills?`), a kind word (`rules` is instructions, with a code search
for that kind; an MCP server word points at `--snippet -`); the examples come from palm.yaml when
it declares sources.

The onboarding transcripts of PLAN.md section 4.9 are the reference for every message on that
path (Nora and Lena): no hint names a placeholder alone, every hint is a command that works when
pasted, the word "origin" appears nowhere, and nothing consults a network for a name. A hint
names a source by its palm.yaml key once declared, else as the person typed it (with its `#ref`
and `--as`); a name the source offers in two kinds is `kind:name`; every hint carries `-g` in the
global scope. `test/cli/hints.test.ts` feeds every hint palm prints back through the grammar.

Per command:

- `palm init [--target …] [--here] [-g]`: writes `targets:` (detected, or the flag) to palm.yaml
  (`~/.palm/palm.yaml` with `-g`) and, in a project, the two ignore lines. Detected targets are
  printed with their evidence (`i found claude (.claude/), codex (AGENTS.md)`), and on a terminal
  the person may change the set first. With nothing found, the hint names the harnesses of the
  home directory. Inside a directory that has a manifest above it in the same repository:
  `x packages/jobs is inside project /work/carbon (palm.yaml). Add entries with --at
  packages/jobs, or start a separate project here: palm init --here`. It never writes outside
  the cwd and prints the path it wrote.
- `palm get [kind] [names…] [-s source] [--files]`: installed entries from the lock: kind, name,
  source, ref (`v1.2.3`, `^1.2 → v1.2.3`, `tree 10934f8`), targets, files count, `via`, and a
  footer with the bytes each harness loads at every session (rules and skill descriptions).
  `--files` prints every generated path with its entry, so `grep` replaces `find`. A server
  declared in palm.yaml shows the source `palm.yaml`; an `at` column appears when an entry has
  `at:`; the `layer` column arrives with palm.local.yaml in 0.3 (JSON keeps `layer`; `get mcp
  --json` adds each server's `variables`). An unknown `--source` is `E_NOT_FOUND` with the name
  it nearly is. `get sources` is the source table (name, alias, kind, ref, sha or tree, entries);
  `get targets` prints `root: <dir>` and each harness, whether it is active and its config dir
  (JSON `{ root, items }`); `get all` shows the three.
- `palm describe <name or path>`: description, source, version, files per harness, notes, what
  selected it (a plugin, palm.yaml), exec commands and trust state, the variables an MCP server
  needs, `at:`. Given a path (absolute, `~/…`, relative) or a bare file name that one installed
  path ends with, the entity that wrote it (`file`, `inside`, `merged`). A name two entries
  answer to is `E_AMBIGUOUS` with one `palm describe <source> <kind:name>` line each.
  `describe <source> <name>` describes that source's entity, from the lock when installed, else
  from the source's index (`offered by <source>, not installed`, with the install line). `describe source <s>`: url or path, ref, sha, root, layout, detection rule, counts
  per kind, index warnings. `describe target <t>`: where each kind goes in this scope
  (`Target.placements`: the layout's paths with the converters' file names, `<name>` for the
  entity, env overrides included; the shared skill directory follows the scope's targets).
- `palm create <kind> <name> [--in dir] [--description text]`: writes a template (`skill` →
  `<dir>/skills/<name>/SKILL.md`, `agent` → `<dir>/agents/<name>.md`, `instruction` →
  `<dir>/instructions/<name>.md`, `hook` → `<dir>/hooks/<name>/hooks.json` with an example
  script) into the in-repo source `<dir>` (default `./agent-kit`; `~/.palm/kit` under `-g`),
  declares the source in palm.yaml when absent (`+ source ./agent-kit → palm.yaml`), and
  installs the entity. No prompts, no editor; an existing file is `E_CONFLICT`. A `kind` of
  `command` is `E_USAGE` naming `create skill`.
- `palm cache clean [--yes]` removes `$PALM_HOME/cache`; without a terminal it needs `--yes`.
- `palm completion bash|zsh|fish` prints a static script generated from the command tree.
- `--dry-run` tables say what would happen (`would install`, `would restore`), never
  `installed`; the JSON statuses are `would-install`, `would-update`, `would-re-render`,
  `would-restore`, `would-remove`.
- Install, sync, update and remove print a line per entry that changed; unchanged entries are the
  closing count (a run that named them prints them), a note shared by rows prints once, skipped
  entries of one source share one line, and a kept edit adds the keep-it line (`palm create
  <kind> <name>`). A removal names the files it kept (`kept 2 files, owned by …`, `kept 42 files
  inside source ./skill`, `RemoveResult.kept`). The update plan counts unchanged entries (`= 105
  unchanged`), prints `latest <tag>` for a pinned source, and its JSON versions are `{ ref, sha }`.
- `palm check` groups the problems of one entity that differ only by file (`skill tdd: 8 files
  are missing (…)`); `--json` keeps each; `--quiet` prints the problems alone; a check that could
  not run (status `skip`) prints `-`, never `✓`. `palm migrate` ends with `palm check` and exits 1
  when it fails.

### Output contract

One writer (`src/ui/output.ts`) is created per run and is `ctx.log` for the command, so all
output goes through it.

- Data (tables, detail rows) goes to stdout. Status lines carry a symbol: `+` added or
  installed, `-` removed, `~` updated or re-rendered, `↺` restored, `=` unchanged, `⊘` skipped,
  `x` error or failed, `!` warning, modified or partial, `i` info.
- Warnings are collected while the command runs and printed once at the end, on stderr,
  under a `Warnings` heading. An `i` line said twice in one run (by the engine and the command)
  prints once. Errors are printed last: `x message` and a hint line that names
  a command to run; an error that the same command with another flag fixes carries
  `retryWith` and its hint repeats the command line with that flag. Each failure is printed
  once (stderr); the status table marks the item `x failed`.
- `--json`: stdout holds exactly one JSON document and nothing else; every other line goes to
  stderr. Lists become `{ "items": [...] }`; every document has `warnings: []`; an error is
  `{ "error": { code, message, hint }, "warnings": [] }`.
- Colours come from picocolors; `NO_COLOR=1` and a non-TTY stdout turn them off.
- Startup: the command tree is registration only; each command's module (and the engine, git,
  yaml and clack behind it) is imported when that command runs, so `palm --help` loads
  commander and picocolors only.

## 11. Conventions

- TypeScript strict, ESM, Node ≥ 22. No default exports. Named exports only.
- Errors: throw `PalmError(code, message, hint?)`; the CLI prints `x message` and the hint (a
  command to run). Codes: `E_USAGE`, `E_NOT_FOUND`, `E_AMBIGUOUS`, `E_CONFLICT`, `E_SOURCE`,
  `E_GIT`, `E_NETWORK`, `E_PARSE`, `E_TARGET`, `E_IO`, `E_NON_INTERACTIVE`, `E_CANCELLED`,
  `E_UNTRUSTED_EXEC`, `E_SECRET`, `E_CHECK`, `E_INTERNAL`. Never `process.exit` outside
  `src/cli.ts`; `src/commands/main.ts` (`EXIT`, `exitCodeFor`) maps every outcome to one exit
  code (section 6).
- All filesystem paths in function signatures are absolute unless the name ends in `Rel` or
  `Lock` (lock form).
- No global mutable state. Pass a `PalmContext` explicitly.
- Interactive prompts only in `src/ui/` and `src/exec/consent.ts` (through `ctx.ui`); core,
  domain, index, targets and engine never prompt. When a decision needs the user, engine calls
  `ctx.ui.pick()` / `ctx.ui.confirm()` / `ctx.ui.consent()`, which the CLI implements with
  `@clack/prompts` and tests implement with fakes.
- Tests: `vitest`, colocated under `test/<module>/`, using temp dirs and `PALM_HOME` overrides;
  never touch the real home. Shared helpers live in `test/support/` (`sandbox.ts` for temp dirs
  and files, `fakes.ts` for logger, UI, context and targets). `test/support/setup.ts` makes every
  worker hermetic: temp `HOME` and harness dirs (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `COPILOT_HOME`, `XDG_CONFIG_HOME`), global and system git config disabled, tokens and
  `GIT_DIR`-style overrides removed, and global `fetch` blocked. CLI tests spawn `node
  dist/cli.js`, built once per run by a vitest `globalSetup` (`PALM_TEST_DIST=<dir>` builds into
  `<repo>/<dir>` instead, `PALM_SKIP_DIST_BUILD=1` reuses the existing build); the rest call
  `runCli` in process. Property tests use `fast-check` (`*.property.test.ts`).
- Tooling: Biome formats (2 spaces, single quotes, 100 columns) and lints; layer boundaries are
  enforced with `style/noRestrictedImports` per directory (section 12). `npm run lint` requires
  clean formatting and fails when any lint rule's count exceeds `scripts/lint-baseline.json`.
  `npm run check:shape` fails when a file gains functions over 60 lines, over 4 parameters or
  nested deeper than 4 (`scripts/shape-baseline.json`). Both baselines only go down. `npm run
  knip` fails on any unused file, export or dependency. `npm run verify` runs lint, typecheck,
  shape check, knip, tests and build; the build is tsdown with code splitting.
- Logging: `ctx.log.info|warn|debug`; `PALM_DEBUG=1` enables debug.
- Prose: no em dashes, sentence-case headings, plain words, every hint a pasteable command.

## 12. Source layout

Layers, lowest first; each imports only the layers below it (enforced by Biome).

| Layer | What lives there |
|---|---|
| `src/lib` | palm-free primitives: fs (atomic and symlink-safe writes, `walkFiles`, `isSameFile`, `realpathInside`), json, canonical json, yaml, frontmatter, names, object, placeholders (`${VAR}` grammar), text, hidden-Unicode detection (`unicode.ts`), entropy |
| `src/domain` | the model: `Source`/`SourceSet` (from a manifest), `EntityRefSpec` (`kind:name`), `EntityKey`/`LockKey`/`Via`, `Manifest` (v3), `Lock` (v3 as a collection), `ScopePaths` (tokens), `MergedRecord` (tagged union with id and key), `renderHashOf`, `AppliedRecord`, skip lists, the pure placeholder helpers `detectSecrets`, `allSecrets`, `requiredSecretNames`, `optionalSecretNames` (`secret-refs.ts`) |
| `src/core` | types and errors, kinds, source input parsing, context, paths, git (`git-exec` is the only place palm spawns git), the index cache (scanner injected), hashing (`hashPath`, `treeHash`) |
| `src/secrets` | a leaf layer: shapes and entropy (`scan.ts`, which re-exports the placeholder helpers of `domain/secret-refs.ts`), the decision per destination (`policy.ts`), value resolution under `literal` (`resolve.ts`) |
| `src/index` | the scanner: `scanner.ts` orchestrates, `detect.ts` picks the rule, `rules/` holds one module per scan rule, `files.ts` is the one-walk `FileIndex`, `references.ts` resolves plugin-root and relative references and lists closures, then the hidden-Unicode and secret passes |
| `src/targets` | one `TargetSpec` per harness over a shared `GenericTarget`: kind renderers fill a `Rendered` (no IO beyond reading the source), an `Applier` checks collisions, merges, journals and rolls back; converters render agents, instructions, command-as-skills, hooks and MCP entries per harness; `assets.ts` reads closures into the render (and copies them for `migrate`) |
| `src/exec` | exec units and hashes (`units.ts`), consent (`consent.ts`: prompt text, `--allow-exec`, viewer, diff), trust bookkeeping over lock entries (`trust.ts`) |
| `src/engine` | the operations: `resolve.ts` (sources to checkouts and indexes), `render.ts` (entity to renders and hashes), `diff.ts` (the three-way diff), `install.ts`, `sync.ts`, `remove.ts`, `update.ts`, `check.ts`, `migrate.ts`, `query.ts`, `targets.ts` |
| `src/commands`, `src/create`, `src/ui` | the CLI: grammar and registration (`program.ts`, lazy `dispatch.ts`), one module per command, the template writer, the one output writer and the prompts |

Import rules: `lib` → nothing; `domain` → lib, core/types, core/errors, core/kinds; `core` →
lib, domain; `secrets`, `targets` → lib, domain, core; `index` → lib, domain, core, secrets
(secrets is a leaf layer below index); `exec` → lib, domain, core plus targets (for rendered
commands); `engine` → those plus index, secrets, exec, targets; `commands` → `create` → `ui`,
never the reverse; `cli.ts` → commands, ui. The pure placeholder helpers live in
`src/domain/secret-refs.ts` so targets use them without importing secrets.

## 13. Reserved for 0.3

The names below are fixed now so nothing is renamed later; the behaviour is one sentence each
and is not implemented in 0.2.

- `palm.local.yaml` (`LocalManifest`) and `.palm/local/lock.yaml`: personal additions
  (targets, sources, entries) rendered to the same paths and added to `.git/info/exclude`;
  `--local` on install and remove; `disable:` is out of scope.
- `at:` (`ManifestEntryObject.at`, `LockEntry.at`): placement root for block-based targets and
  nested skill directories; derived from an instruction's paths when absent.
- `LockEntry.carrier`: one carrier per (entity, harness) when several harnesses read one file.
- `Activation` mapping: on-request and manual instructions become skills where a harness lacks
  the concept, with a note; never widened silently.
- The hook mapping table: documented one-to-one event and matcher equivalents with the harness
  version each row was verified against; everything else skipped with a note.
- Agent field tables: per-harness mapping with a warning for a lost restriction and a note for
  a lost capability.
- `palm import apm.yml|skills-lock.json`, `update --review` text diffs of prose, the load-cost
  footer of `get`.
