# palm 1.0: what palm should be

Status: proposal, 2026-09-29. Written from the twenty-persona study of palm 0.1.0
(164 findings, ids F001 to F164), the census of user critiques of competing managers,
and three design proposals (minimalist, team state, safety and fidelity). Persona names
and finding ids refer to the study reports. The 0.1.0 plan this replaces is in git at
commit 0c18490.

## 1. Summary

palm copies skills, agents, rules, hooks and MCP servers from git repositories into the
directories that coding agents read, records what it copied in a lock, and proves in CI
that the committed files still match their sources.

0.1.0 does the copying well. Twenty personas, replaying real repositories, praised the
placement, the exact uninstall, the pinned restore and the zero-diff adoption of files
they already had. One said yes, one said yes with conditions, eighteen said maybe, none
said no. The maybes trace back to three design mistakes, not to bugs.

1. The lockfile plays three roles at once. It is the team's resolution, this machine's
   record of the disk, and the ledger for consent. On a second machine it cannot answer
   the questions it gets asked (F054, F055, F059, F060, F098, F157).
2. Origins are registered per user but consumed per project. A teammate's clone lacks
   the alias the lock names, so a bare install rewrites palm.yaml or fails (F013, F028,
   F036, F037, F042).
3. Executable content is treated as text. Hooks are copied as whole plugin trees into an
   ignored directory, consent defaults to yes and is given by `--yes`, and nothing shows
   a reviewer what a script does (F067, F077, F078, F079, F082, F084, F131, F137).

The plan fixes the three at the model level and removes everything the smaller model no
longer needs. The result has eight verbs and three utilities instead of sixteen verbs,
one pin instead of two, one file format instead of two, no user-level registry, and no
feature the study could not tie to a persona who needed it.

Decisions taken on 2026-09-30 by the maintainer: the source comes first on the command
line, "origin" becomes "source", the MCP registry client goes and the `create` wizard
shrinks to a template writer, and all six targets stay.

## 2. Where 0.1.0 is good

Everything in this list stays, with the same behaviour.

- Exact uninstall, including entries merged into shared config files. Foreign entries in
  the same file survive (ten personas).
- Byte-identical files are adopted without `--force`. Jan's 26 committed APM files
  produced a zero diff.
- Exact pinned restore. Chris restored five of five pinned skills where skills.sh
  restored one of five.
- Files you edited are never overwritten or deleted (ten personas).
- Hidden-Unicode refusal on every write path, hook scripts included. It found real
  zero-width characters in three repositories.
- Path traversal and symlink guards on source content.
- Plugin members install without their siblings; shared members are reference counted.
- Per-harness conversion of scoped rules and of MCP environment references.
- No prompt without a terminal; every refusal prints the exact line to rerun.
- Clean `--json`, a deterministic lock, precise messages from the CI check.
- A missing source is rebuilt from the lock's URL; relative in-repo sources travel with
  the repository.
- Provenance: which entity wrote a file, and why an entity is installed.
- Speed: 101 entries in about a second, a 44-plugin marketplace indexed in under three.
- The `$HOME` guard and did-you-mean suggestions, including for APM's virtual paths.

## 3. Method

Compress. The minimalist proposal reduced palm to four concepts and six verbs: sources
per project, generated files always committed, no global scope, no registry, no wizard,
no plugin kind, no hook translation, four targets. It serves the three stories that matter
most (Jan's APM swap, Priya's clone, Ivan's hook review) and abandons Raj, Dmitri, Marco,
Johnny, Mei and the maintainer's own setup.

Expand. Each thing the minimalist cut was put against the evidence again.

| cut by the minimalist | evidence for keeping it | verdict |
|---|---|---|
| global scope (`-g`) | the dotfiles story in the critique census (two machines); Raj, Dmitri; the maintainer installs one skill globally | keep, same model as a project |
| personal layer | must-get-right 4 in the census (Claude issues 14920 and 14202, Codex 18115); Mei, Elena | keep, additions only |
| plugin as a unit | Dana's 44-plugin marketplace, where `--all` is wrong | keep as a selector, not a kind |
| Gemini and OpenCode | chosen by the maintainer; the research pass was unverified, not wrong | keep, verified before 1.0 |
| hook translation | one hook set for four harnesses is a real need; ten personas hit mistranslation (F052) | keep documented one-to-one mappings only, skip the rest with a note |
| managed `AGENTS.md` block | Codex reads nothing else; the data loss in the census was APM rewriting a whole file, not a block | keep, with one carrier per harness |
| MCP registry search | nine findings; the census counted 25,125 servers with hundreds unreachable; one persona wanted it | remove; every MCP README ships a JSON snippet, and palm reads that instead |
| `create` and `mine` | the wizard cost Elena three tries; `mine` leaked into palm.yaml (F065); the maintainer values a fast way to start a skill | keep `create` as a prompt-free template writer into an in-repo source; remove the wizard and `mine` |
| `command` kind | Claude and Cursor merged commands into skills; Codex and Copilot deprecate prompt files | remove; a command installs as a skill |
| agent dependency resolution | partial installs (F102), removals that took dependents (F018) | remove; print the command instead |
| `--frozen`, `doctor`, `audit`, `outdated` | four gates that disagreed with each other (F115, F116, F157) | fold into `check` and `update --dry-run` |

Compress again. Each kept item was made to share a mechanism that already exists. The
overlay uses the manifest grammar, the global scope uses the project model, plugins use
the entry filter, hooks use one relocation rule and one mapping table. Section 4 is the
result.

## 4. The final picture

### 4.1 The job

palm installs agent configuration from git repositories into a project or a home
directory, for six harnesses, reproducibly, with a human review before anything
executable lands.

It is for one person setting up a machine, and for a team that wants every clone and
every CI run to hold the same files. It is not a marketplace, a registry, a runtime or an
authoring tool.

### 4.2 Concepts

Five words, used the same way in the CLI, the files and the docs.

Source. A git repository, optionally a subdirectory at a ref, or a directory inside the
project. Declared in palm.yaml, so it is a dependency of the project and never a per-user
registration. GitHub repositories are written `owner/repo`; anything else gets a name and
a `url:` or `path:`. A source may carry an optional `alias:` for typing. A source may ship
a marketplace or plugin manifest; palm reads it to find entities, and that is all a
manifest does.

Entity. One skill, agent, instruction, hook or MCP server, named within its source. Five
kinds. A plugin is a selector over the entities of a source, not a kind. A command found
in a source installs as a skill, with a note.

Target. A harness: claude, codex, copilot, cursor, gemini, opencode. Declared once in
palm.yaml, narrowed per entry with `targets:`.

Generated file. Everything palm writes. Every path is listed in the lock. In a project,
generated files are committed. Git carries them to teammates and CI, and the diff is the
review.

Scope. A project (the directory holding palm.yaml, found by walking up to the nearest
`.git`) or the home directory (`-g`). Both use the same files and verbs.

### 4.3 Files

| file | holds | committed | written by |
|---|---|---|---|
| `palm.yaml` | what the team wants: targets, sources with ref and layout, entries with filters | yes | `init`, `install`, `remove`, `update --to`, your editor |
| `palm.lock.yaml` | what the sources resolved to and what was rendered: per source url, root, ref, sha and layout snapshot; per entry the source hash, one render hash per target, the file list, merged-entry identities, executable hashes, trust and notes | yes | `install`, `remove`, `update` |
| `palm.local.yaml` | personal additions: extra targets, sources and entries for this checkout | no, ignored | `install --local`, `remove --local`, your editor |
| `.palm/assets/<source>/<entity>/` | scripts that hooks and MCP servers run, copied from remote sources at their source-relative paths (`<source>` is the source name with `/` as `__`) | yes | `install`, `update` |
| `.palm/local/` | the overlay's lock and its exclude bookkeeping | no, ignored | the overlay commands |
| `~/.palm/palm.yaml`, `~/.palm/palm.lock.yaml` | the global scope, same format; harness homes appear as tokens such as `<claude>/skills/x`, never as absolute paths | your choice (dotfiles) | the same verbs with `-g` |
| `~/.palm/applied.yaml` | the lock as last applied on this machine, with real paths | never | every `-g` command that writes |
| `~/.palm/cache/` | checkouts keyed by sha, and indexes | never | fetch and index; safe to delete |

There is no `~/.palm/config.yaml`, no machine-state file in a project and no
`createdDirs`. Where git carries the outputs, git is the record of the machine. Where it
does not (the global scope, the personal overlay), palm keeps the last applied lock and
nothing more.

palm.yaml:

```yaml
targets: [claude, cursor]

sources:
  mattpocock/skills:                    # GitHub shorthand
    ref: v1.2.3                         # tag, branch, sha, or a range such as ^1.2
    skills: [tdd, handoff]
  obra/superpowers:
    ref: ^4
    plugins:
      - name: superpowers
        exclude: [skill:brainstorming, hook:superpowers]
  acme-kit:
    url: https://gitlab.acme.com/platform/agent-kit.git
    root: kit
    ref: ^1
    layout: { agents: [people/*.md] }   # consumer override, rarely needed
    agents: [reviewer]
    instructions:
      - { name: db-conventions, targets: [claude, codex], at: packages/database }
  ./agent-kit:                          # in-repo directory, rendered from the working tree
    skills: [review]
    hooks: [quality]

mcp:
  docs:
    url: https://example.com/mcp
    headers: { Authorization: "Bearer ${DOCS_TOKEN}" }
```

palm.lock.yaml, abbreviated:

```yaml
version: 3
sources:
  mattpocock/skills: { url: https://github.com/mattpocock/skills.git, ref: v1.2.3, sha: 6acc160, descriptor: convention }
  ./agent-kit: { tree: sha256:10934f8 }
entries:
  - kind: skill
    name: tdd
    source: mattpocock/skills
    path: skills/tdd
    content: sha256:1f2e
    render: { claude: sha256:9a0b, cursor: sha256:9a0b }
    files: [.claude/skills/tdd/SKILL.md]
    notes: ["cursor reads .claude/skills; no second copy"]
  - kind: hook
    name: quality
    source: ./agent-kit
    content: sha256:77d0
    render: { claude: sha256:c4d5 }
    merged:
      - { file: .claude/settings.json, at: /hooks/Stop, id: palm:hook:quality:0, key: sha256:3e01a9f2 }
    exec:
      commands:
        - { id: Stop//-, command: 'bash "$CLAUDE_PROJECT_DIR"/agent-kit/hooks/quality.sh' }
      hash: sha256:5d41
    trust: [sha256:5d41]
```

Two hashes per entry per target, not one per file (F062: 758 lines for four entries).
Merged entries carry an identity independent of their value, so an edited hook is
"modified", not "missing", and removing one plugin cannot take another plugin's hook
(F130).

### 4.4 Commands

Eight verbs. `--help` fits on one screen.

| verb | aliases | what it does |
|---|---|---|
| `palm init [--target t] [--here]` | | Write palm.yaml with the detected targets. Refuses inside a directory that has a manifest above it in the same repository unless `--here` (F127). |
| `palm install <source> [names] [--all]` | `add`, `i` | Without names: fetch, index, print what the source offers with a pasteable next line, save nothing. With names or `--all`: render, record the source and the entries in palm.yaml and the lock. `kind:name` only when one name means two kinds (F022). |
| `palm install` | | Bare: make the disk match palm.yaml and the lock. Renders new entries, re-renders in-repo sources that changed, adopts identical files, keeps edited files with exit 1, deletes generated files the lock no longer lists. Offline when the cache holds every sha. |
| `palm remove [source] <names>` | `uninstall`, `rm` | Delete exactly the lock's files and merged entries for those names, prune emptied containers, update both files. Already absent: an `i` line, exit 0 (F119). For a plugin member it asks whether to exclude it for the team or drop it for you (`--exclude`, `--local`). |
| `palm update [sources] [--to ref] [--dry-run] [--review]` | `up` | Re-resolve refs within their ranges (`--to` moves the range), print changed entities and every new or changed executable, ask (default no), write. `--review` prints script bodies and a text diff of changed skills and rules. `--dry-run` is the outdated report. |
| `palm check [--json]` | | Read-only gate for CI. Fails when palm.yaml, the lock, the generated files or an in-repo source disagree, when a hook names a missing script, when a generated file holds a secret literal, when an executable is not trusted, or when an output directory is ignored by git. Warns on double loads and on rules above a harness limit. Prints every check it ran and one line per problem with the command that fixes it (F019, F115). |
| `palm get [kind] [names] [--source s] [--files]` | `list`, `ls` | What is installed: source, ref, sha, targets, file counts, layer (team or local), and the bytes each harness loads at every session (F156). `--files` prints every generated path with its entry. |
| `palm describe <name or path>` | `info` | One entity: source, version, files per harness, notes, what selected it (a plugin, the overlay), what depends on it. Given a path, the entity that wrote it. `describe source <s>` and `describe target <t>` stay. |
| `palm create <kind> <name> [--in dir]` | `new` | Write a template for a skill, agent, instruction or hook into the project's in-repo source (default `./agent-kit`, declared in palm.yaml on first use; `~/.palm/kit` under `-g`), then install it. No prompts, no editor, no `mine` (F065, F066, F069). |
| `palm install mcp <name> [flags]`, `palm install mcp --snippet <file or ->` | | Declare an MCP server by hand or from a README snippet; section 4.12. |

Utilities: `completion`, `cache clean`, and `migrate` (0.2 only, section 8).

Flags: `-g`, `--all`, `--allow-exec <id=hash>`, `--yes` (non-consent prompts only),
`--force`, `--dry-run`, `--json`, `--local`, `--offline`. Exit codes: 0, 1 (a refusal
or a failed check), 2 (usage), 130 (cancelled). Colour only on a terminal.

The old grammar works for one release as hidden aliases. `install skill tdd@mattpocock`
resolves the alias through palm.yaml, and `install origin` prints the new form and runs it.

### 4.5 Invariants

Each one names the findings it closes. A change that breaks one of these is a bug,
whatever feature it serves.

1. palm.yaml and palm.lock.yaml contain no absolute path, home directory, hostname,
   timestamp or machine fact (F059, F104, F108, F110).
2. Every source an entry names is declared in the same palm.yaml, and the lock holds
   enough (url, root, sha, layout) to rebuild it anywhere (F013, F028, F034, F036).
3. On a clean clone, a bare install writes neither palm.yaml nor the lock for remote
   sources (F060).
4. Every generated file is a function of palm.yaml, the lock and the sources; `check`
   recomputes it and fails on any difference (F054, F058, F098, F115).
5. Version intent has one home, the source's `ref:`; the lock records the resolved sha;
   `update` moves the sha within the range and `--to` moves the range (F014, F029, F038,
   F099, F100, F101, F139).
6. An in-repo source is the truth: a bare install re-renders from the working tree, and
   `check` fails on drift (F040, F098).
7. Edits are detected against the lock's render hash, so a pull that moves the lock is
   an upgrade, never "your edits" (F058, F143).
8. A removal is exact and symmetric: only the paths and merged entries the lock lists,
   matched by identity, and removing something absent is not an error (F085, F119, F130).
9. palm never writes or deletes outside the scope root through a symlink, and never
   touches a source's own files; a source that overlaps an output directory is refused on
   real paths (F124, F145).
10. Nothing executable reaches a harness file without a hash-pinned consent in the lock
    or on the command line; `--yes` never consents; the default answer is no (F078,
    F079, F084).
11. A changed executable hash asks again, on install, update and bare install; an
    unchanged one is replayed silently on every machine (F084, F137).
12. Before consent, every target's rendered command, the file it lands in and the list
    of scripts are shown, with the script bodies one keypress away (F077).
13. Every script a hook runs is committed in the repository or lives in place in an
    in-repo source; a clone without palm has no dangling command (F067, F131, F132).
14. palm never merges a command it could not resolve (F131, F135).
15. No literal secret from a source is ever written; no literal secret is written into a
    git-tracked file; the index and the lock hold no secret values (F073, F074).
16. Each (entity, harness) pair has one carrier, so a harness loads an entity once
    (F045, F046, F053).
17. Activation is never widened silently; an on-request rule becomes a skill where the
    harness lacks the concept, with a note (F125, F126).
18. A dropped restriction on an agent is a warning; a dropped capability is information;
    both persist in the lock and show in `describe` (F043, F044, F047, F049).
19. `unchanged` means the render equals the lock and the disk equals the render on every
    target; `partial` exits 1; `check` says "no problems" only when it found none (F024,
    F115, F143).
20. Every error's first line is the command to run next, and no hint contains a
    placeholder alone (F001, F005, F019, F034).
21. palm never prompts without a terminal, and every prompt has a flag (F072).
22. Two palm processes on one scope serialise on a lock file (F057).
23. `--dry-run` reports exactly what the real run would write, secrets policy included
    (F075).

### 4.6 Harness fidelity

The rule: write where the harness loads it, once, with the author's activation. Where a
harness lacks the concept, map to that harness's on-request form, a skill, and say so.

Activation of an instruction is one of always-on, on-request (a description, loaded when
relevant), path-scoped (globs) and manual (`@name`).

| kind | claude | codex | copilot | cursor | gemini | opencode |
|---|---|---|---|---|---|---|
| instruction, always-on | `.claude/rules/<n>.md` | block in `AGENTS.md` | `.github/instructions/<n>.instructions.md` | `.cursor/rules/<n>.mdc` | block in `GEMINI.md` | `.opencode/instructions/<n>.md` |
| instruction, scoped to a directory | `paths:` | nested `<dir>/AGENTS.md` | `applyTo` | `.mdc` globs | nested `<dir>/GEMINI.md` | skill |
| instruction, scoped to a file glob | `paths:` | skill | `applyTo` | `.mdc` globs | skill | skill |
| instruction, on-request or manual | skill | skill | skill | `.mdc` | skill | skill |
| skill | `.claude/skills/<n>/` | `.agents/skills/<n>/` | `.agents/skills/` | `.claude/skills` when claude is a target, else `.agents/skills` | `.agents/skills/` | as cursor |
| agent | `.claude/agents/<n>.md` | `.codex/agents/<n>.toml` | `.github/agents/<n>.agent.md` | `.cursor/agents/<n>.md` | `.gemini/agents/<n>.md` | `.opencode/agents/<n>.md` |
| hook | merged into `.claude/settings.json` | merged into `.codex/hooks.json` | `.github/hooks/<n>.json` | merged into `.cursor/hooks.json` | merged into `.gemini/settings.json` | skipped, noted |
| hook scripts | `.palm/assets/<source>/<entity>/`, committed; in place for in-repo sources | same | same | same | same | none |
| mcp | `.mcp.json` | `.codex/config.toml` | `.vscode/mcp.json` | `.cursor/mcp.json` | `.gemini/settings.json` | `opencode.json` |

One carrier per harness. Cursor, OpenCode and Copilot read the root `AGENTS.md`; Claude
reads it when there is no `CLAUDE.md` or `CLAUDE.md` imports it; Gemini reads it only
when its settings list it. When codex is a target, the `AGENTS.md` block carries every
always-on instruction for those readers too, and no second file is written for them; the
lock records `carrier: AGENTS.md` per target. Cursor and OpenCode read both
`.claude/skills` and `.agents/skills` and dedupe by name, so claude plus cursor means one
copy. palm never edits `CLAUDE.md`. A root block above 24 KiB warns; above the harness's
documented cap it refuses without `--force` (F125).

Hooks. A source ships hooks in one dialect, almost always Claude's. palm merges that
dialect into the harness it belongs to. It maps to other harnesses only through a shipped
table of documented one-to-one event and matcher equivalents, each row carrying the
harness version it was verified against. An event or field with no row is skipped for
that target with a persisted note, never guessed (F052). Relocation follows one rule: a
reference to the plugin root (`${CLAUDE_PLUGIN_ROOT}` and its variants,
`${extensionPath}`, a relative path in a command, an argument or `cwd`) is resolved at
index time against the source and rendered as `<project dir>/.palm/assets/<source>/<entity>/<path>`
(`<path>` source-relative) in the harness's project-dir idiom, quoted (F133). Anything that resolves to nothing in
the source refuses that hook and prints the offending line. What is copied is the
directory holding the hook definition plus every source path a command names, never
`SKILL.md`, `AGENTS.md` or manifests (F082). In-repo sources are not copied; their scripts
run in place, so an edit is live.

Agents. A field is never copied into a harness that would misread it (F047). Tool lists
map per harness from a shipped table; a lost restriction is a warning, a lost capability
is information, both recorded (F043, F044).

Commands. A `commands/*.md` in a source is indexed as a skill and installed to the skill
paths. `$ARGUMENTS` survives in Claude and Cursor; where a harness does not expand it, a
note says so (F050).

### 4.7 Executable content and consent

Anything that makes a harness, or a program it starts, run code is executable material:
hook commands, stdio MCP commands with their arguments, cwd and environment keys, and the
scripts those reach. Each unit gets one hash over its canonical command (placeholders
intact, so a new target or a palm upgrade does not move it), its event and matcher, and a
tree hash of the scripts it reaches.

- Before writing, palm prints the units: kind, name, source, commit, event and matcher,
  the rendered command and file per target, and the script list with sizes and short
  hashes. `v` shows script bodies from the pinned commit. On update, `d` shows a unified
  diff against the trusted version.
- The default is no. `--yes` covers pickers and plan confirmations, never this prompt.
- Without a terminal the prompt is an error that prints the review command and the exact
  `--allow-exec hook:gh-cli@trailofbits/skills=sha256:<hash>` line. There is no
  `--allow-exec all` without a terminal.
- Consent is recorded in the lock as `trust:` hashes and replayed silently on every
  machine and in CI while the hash matches. A changed command, script byte, mode bit,
  environment key or cwd asks again. A commit bump with the same hash, a new target or a
  palm version does not.
- Declining a plugin's hook installs the rest and records the hook as declined, so bare
  installs stay quiet; asking for it by name asks again.
- Prompt hooks (`type: prompt`) are listed as text sent to the model, never called a
  command (F077).
- palm never runs what it installs.

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

palm never runs these itself. If you say yes, their hashes go into palm.lock.yaml,
so teammates and CI install them without being asked; any change asks again.

Allow these 2 programs to run?  [y/N/v=view scripts]
```

### 4.8 Secrets

palm scans MCP environment values, headers, arguments and URLs, hook commands, every
script in an asset directory and palm.yaml itself, at index, install, update and check.
Known prefixes (`sk-`, `ghp_`, `github_pat_`, `xox`, `AKIA`, `AIza`, `glpat-`,
`-----BEGIN`), `Bearer` tokens and high-entropy values under key names that mention key,
token, secret, password or authorization count as secrets.

- A literal that arrives from a source is never written. palm writes `${NAME}` and says
  so; `--force` does not override (F074).
- A literal you type in project scope needs `--secrets literal`, and palm warns when the
  destination is tracked by git.
- The global scope writes environment references only. A literal is allowed there only
  when the destination's real path lies outside every git worktree (Raj's dotfiles, F073).
- The index and the lock store redacted hashes, never values. The cache directory is mode
  0700.
- `check` fails on a literal in a tracked or world-readable file, and lists every variable
  the installed servers need and whether it is set.
- When palm replaces a literal it found on disk, it says the old value is still in git
  history and should be rotated.

Registry naming goes with the registry. The manifest's `headers:` and `env:` take
`${VAR}` references, rendered into each harness's syntax.

### 4.9 Onboarding

Nora, Claude Code only, an empty project with `.claude/`. Command 1 fails and its first
line is the fix; command 2 lists what the source offers and saves nothing; command 3 installs
everything but the program, which it names with the two commands that show and install it.

```
$ palm install superpowers
x "superpowers" is not a repository. palm installs from git repositories:
    palm install <owner/repo> [names...]      for example  palm install obra/superpowers
  Not sure which repository? https://github.com/search?q=superpowers+SKILL.md&type=code
$ palm install obra/superpowers
obra/superpowers  v4.0.3 (083545e)   1 plugin, 3 skills, 1 hook
  plugin  superpowers               3 skills, 1 hook   (also hook superpowers: name it plugin:superpowers)
  skill   brainstorming             Use before any creative work: explore intent, requirements and design.
  skill   test-driven-development   Use when implementing any feature or bugfix, before writing implement…
  skill   writing-skills            Use when creating or editing skills.
  hook    superpowers               claude: SessionStart -> hooks/run-hook.cmd session-start   (a program; asks before installing)   (also plugin superpowers: name it hook:superpowers)
Nothing written. Install some:
    palm install obra/superpowers brainstorming test-driven-development
    palm install obra/superpowers --all
$ palm install obra/superpowers --all
i .gitignore: added .palm/local/ and palm.local.yaml
i ref ^4.0 saved to palm.yaml (latest tag v4.0.3); edit ref: to track main
targets: claude   (detected from .claude/; change targets: in palm.yaml)
+ skill  brainstorming             .claude/skills/brainstorming/   1 file
+ skill  test-driven-development   .claude/skills/test-driven-development/   3 files
+ skill  writing-skills            .claude/skills/writing-skills/   2 files
! hook   superpowers               runs a program on your machine; not installed
    see it:      palm install obra/superpowers hook:superpowers --dry-run
    install it:  palm install obra/superpowers hook:superpowers
3 installed. Commit palm.yaml, palm.lock.yaml and .claude/ together.
```

Lena, Cursor only, typed a skill name first:

```
$ palm install tdd
x "tdd" is not a repository. palm installs from git repositories:
    palm install <owner/repo> tdd             for example  palm install mattpocock/skills tdd
$ palm install mattpocock/skills tdd
i .gitignore: added .palm/local/ and palm.local.yaml
i ref ^1.2 saved to palm.yaml (latest tag v1.2.3); edit ref: to track main
targets: cursor   (detected from .cursor/; change targets: in palm.yaml)
+ skill  tdd   .agents/skills/tdd/   3 files   from mattpocock/skills v1.2.3   (cursor reads .agents/skills)
1 installed. Commit palm.yaml, palm.lock.yaml and .agents/ together.
```

Both transcripts are the real output of `palm`, recorded by `docs/scripts/capture.mjs` from
fixture repositories (`a-onboarding-nora`, `a-onboarding-lena`); a test keeps them equal to the
captures. The word "origin" appears nowhere. No registry is consulted, so nothing times out
(F089) and no unrelated MCP server appears (F003).

### 4.10 Global scope and the personal overlay

Global scope. `~/.palm/palm.yaml` and `~/.palm/palm.lock.yaml` use the project format.
The lock names harness homes as tokens, so the two files can live in a dotfiles
repository and reproduce a setup on a second machine (F104). `~/.palm/applied.yaml`
records what this machine holds, so a bare `palm install -g` after a pull removes what the
lock dropped (F055). Hook assets go to `~/.palm/assets/`. Project sources are not visible
under `-g`, and the error says so (F037).

Personal overlay. `palm.local.yaml` adds targets, sources and entries for one checkout.
Its entries render to the same harness paths as team entries, and palm adds those paths
to `.git/info/exclude` and says so. `check` in CI never reads it; `get` shows a `layer`
column. It cannot disable a committed entry, because git tracks that file and the harness
would load it anyway; that needs harness support (Mei, F068). A local entry that the team
later adds is reported once and dropped from the overlay on confirmation.

### 4.11 Monorepos

One root manifest with placement, no workspaces. `at: <dir>` on an entry makes `<dir>`
its placement root: nested `AGENTS.md` and `GEMINI.md` blocks, `<dir>/.cursor/rules`,
`<dir>/.agents/skills`, globs rebased. Claude keeps root rules with `paths:`, its native
scoping. When `at:` is absent and an instruction's paths share a directory prefix, palm
derives the placement and prints it (F125, F128). Discovery stops at the nearest `.git`;
`init` inside a package refuses without `--here` (F127). `check` warns when one entity is
installed at two versions across nested projects or scopes (F161).

### 4.12 MCP servers

An MCP server is declared once and rendered into every target's file and syntax, with
environment references instead of secrets. Four ways in, none of them a registry.

1. From a source. `palm install <source> mcp:<name>` takes the server from the source's
   `.mcp.json` or plugin manifest, like any other entity.
2. From the README snippet. Every server's README ships a `mcpServers` JSON block.
   `palm install mcp --snippet -` reads it from the clipboard or a pipe, `--snippet
   server.json` from a file (`--json` stays the global flag for machine-readable output), and
   converts it: `command`, `args`, `env`, `url`, `headers` become an
   `mcp:` entry in palm.yaml; a literal secret in the snippet becomes `${NAME}` with a
   notice (F074).
3. By flags. `palm install mcp docs --url https://example.com/mcp --header
   'Authorization=Bearer ${DOCS_TOKEN}'` for a remote server; `palm install mcp xcodebuild
   --command npx --arg -y --arg xcodebuildmcp@latest --env KEY=${KEY}` for stdio.
4. By hand, under `mcp:` in palm.yaml, and a bare `palm install`.

Each way ends in the same entry, so `get mcp` shows every server with the variables it
needs and whether they are set, and `describe mcp <name>` prints the rendered block for
each harness. A stdio server is executable material and goes through the consent prompt
of section 4.7; a remote server does not, and the prompt says which is which. Under `-g`
the same forms write to the harness home files, which is what Raj and Dmitri wanted.

The registry client is gone (F003, F089 to F097, F114): searches timed out at ten seconds,
ranked unrelated servers first, invented variable names and dropped headers. A lookup by
exact registry id may return later as an explicit `--registry` flag; nothing in the model
prevents it.

## 5. What changes from 0.1.0

| 0.1.0 | 1.0 | why |
|---|---|---|
| origins in `~/.palm/config.yaml`, aliases required, `install origin` first | sources in palm.yaml, `owner/repo` is the name, `install <source> <names>` declares it on first use | F012, F013, F028, F036, F042; Nora, Lena, Chris |
| `name@origin#ref` plus an origin `ref:` | one `ref:` per source, ranges allowed | F014, F016, F029, F038, F099, F101 |
| lock v2 with per-file hashes, `createdDirs`, `targets`, absolute global paths | lock v3 with one render hash per target, file lists, merged identities, exec hashes and trust | F059, F062, F104, F130 |
| lock doubles as machine state; `--frozen` restores and rewrites | generated files committed; `check` is read-only; `applied.yaml` only where git does not carry outputs | F054, F055, F060, F157 |
| `.palm/hooks/` whole-plugin copy, gitignored | `.palm/assets/<source>/` closure, committed; in place for in-repo sources | F067, F082, F131, F132 |
| consent defaults to yes, `--yes` consents, re-asked per clone | default no, hash-pinned trust in the lock, `--allow-exec id=hash`, script viewer and diff | F077, F078, F079, F084, F137 |
| local origins frozen at install | in-repo sources are live; a bare install re-renders; `check` fails on drift | F040, F098 |
| hand edits reported as `unchanged` after a pull | edits compared against the render hash | F058, F143 |
| `doctor` says "no problems" beside warnings; four overlapping gates | one `check` that lists every check it ran | F115, F116 |
| every activation becomes always-on for Codex and Gemini | on-request and manual rules become skills; nested blocks for directory scopes | F125, F126 |
| instructions written to `.cursor/rules` and `AGENTS.md` both | one carrier per harness | F046, F053 |
| hooks translated by guesswork | a documented one-to-one table; the rest skipped with a note | F052 |
| MCP literal secrets allowed globally, from origins too | never from a source; env-ref by default everywhere; literal only outside git | F073, F074 |
| symlinked output dirs followed, sources deleted through them | real-path checks; overlap refused | F124, F145 |
| `--target` on install leaks into the lock | `targets:` per entry; the overlay for personal targets | F129 |
| plugin members removed one by one with "kept" | `exclude:` on the plugin entry, or `--local` | F087 |
| MCP servers found through registry search | declared from a source, a README snippet, flags or by hand; rendered to every harness | F003, F089, F090, F091 |
| `create` wizard with prompts into the hidden `mine` origin | prompt-free template into the in-repo source, declared in palm.yaml | F065, F066, F069, F163 |
| errors name a placeholder | the first line is the pasteable fix | F001, F019 |

## 6. Removed, and why

- `install`, `uninstall`, `get`, `describe` and `update` on `origin`; `--alias`,
  `--project`, `--save-origin`, `--from`; marketplace import as origins (F002, F010,
  F013, F017, F030, F032, F144, F154). A source is declared where it is used.
- `~/.palm/config.yaml`, `config get|set`, `--secrets` as a global policy (F073, F075,
  F076, F105, F106). The only remaining setting, the default target list for `-g`, lives
  in `~/.palm/palm.yaml`.
- `search`, the MCP registry client, `install mcp <registry name>`, `mcpRegistryUrl`
  (F003, F089 to F097, F114). An MCP server comes from a source, a README snippet, flags
  or a hand-written `mcp:` entry (section 4.12).
- The `create` wizard, its prompts, `$EDITOR`, and the `mine` origin (F008, F048, F065,
  F066, F069, F107, F163). The verb stays as a template writer into an in-repo source.
- The `command` kind (F033, F050). Commands install as skills.
- Agent dependency resolution and the picker (F035, F102, F150, F152, F153). palm prints
  `agent reviewer names skills tdd, review: palm install acme-kit tdd review` and stops.
- `--frozen`, `doctor`, `audit`, `--strip`, `outdated`, `why`, `find` (F054, F100, F115,
  F116, F121, F157). Folded into `check`, `update --dry-run` and `describe`.
- `--target` on install, `--prune`, `--refresh`, `--verbose`, `--no-color` (F129, F061).
  A bare install prunes by the lock; colour follows the terminal.
- Per-file hashes, `createdDirs`, `transform` and embedded block text in the lock (F059,
  F062, F063, F064).
- The whole-plugin hook copy and palm-written `.gitignore` lines for hooks (F067, F082,
  F083).
- Consent by `--yes`, re-consent on every clone, the yes default (F078, F079, F084).
- Exit code 70 and the exit-code footer in `--help`.

Deliberately not built, with the reason:

- A minimum-age or new-maintainer gate. Git dates and authors are forgeable; it would lull.
- Injection scans of prose. Unbounded false positives; the review diff is the honest tool.
- Sandboxing or executing scripts to inspect them. palm's claim is that it runs nothing.
- Signature verification. No source has keys to verify against yet.
- Transitive package dependencies (`apm.yml`, `requires:`). Listed, never installed
  without a direct ask (Sridhar, F152).
- Per-person disabling of committed entries (F068). Needs harness support.
- An author-side `palm-origin.yaml`. Nobody ships one; the consumer-side `layout:` and
  command resolution cover the need. Revisit when a second source needs it.
- Windows. Stated unsupported; paths use `path.join` so a maintainer can add it (F159).
- `adopt`, moving existing harness files into a source. The docs show the `git mv`
  recipe; `import` covers the APM and skills.sh cases.

## 7. Roadmap

Each phase ends with the persona sandboxes rerun against the published version. The study
protocol and the twenty scripted sessions are the acceptance suite.

0.2, the model. Sources in palm.yaml, lock v3, committed outputs, bare install as sync,
`check`, one pin with ranges, consent with trust hashes and `--allow-exec`, the asset
closure committed with one relocation rule, live in-repo sources, real-path and overlap
refusal, secrets refusal, honest statuses and exit codes, onboarding errors with the fix
on line one, the four MCP paths of section 4.12, `create` as a template writer,
`migrate`, and the removals from section 6. Acceptance: Nora and Lena reach a
working install in two commands; Priya's clone passes `check` with no palm run; Ivan's
update onto a hook commit stops and shows the script; Jan's swap stays zero-diff; Mei's
removal reaches the second clone; Chris's symlinked directory is refused, not deleted;
every S1 finding closed.

0.3, the team. Personal overlay, `at:` placement and derived placement,
`import apm.yml|skills-lock.json`, one carrier per harness, activation mapping, agent
field tables with warnings, the hook mapping table, `update --review` text diffs, load
cost in `get`, `migrate` removed. Acceptance: one instruction for four harnesses, loaded
once each; a shared baseline plus uncommitted personal extras; Brad's monorepo without a
1 MB `AGENTS.md`; Marco with no double load.

Candidates for 0.3 from the 0.2 persona rerun, decided when the phase is planned:
`palm check --recursive` over every nested `palm.yaml` in one worktree (B10); "source is the
target", an in-repo source that is its own carrier for a harness that reads the directory, so
an authored skill is not in git three times (C26); overlay sources outside the project, for a
live loop from a sibling checkout (K21); a `palm:` key in palm.yaml naming the minimum palm
version, next to the pinned CI install the docs show (D18); minimal JSON edits that keep a
merged file's formatting instead of printing it anew (J13); a generated-file marker, with
`.gitattributes` `linguist-generated` help and a header where the format allows (E10).

Candidates for 0.3 from the second 0.2 rerun: an opt-in restore mode for gitignored outputs
(a repository that ignores `.claude/` on purpose gets its files from a bare install), taken
up only with new evidence beyond one maintainer, since committed outputs stay the rule of
section 4.2 and check prints the exact re-include lines until then (O2); prose diffs for
changed skills and agents in `--review`, where 0.2 marks them `~ changed` so the reviewer
reads the pull request's diff (V1'); `palm create <kind> <name> --from-installed`, which
copies an installed entity you edited into your own source under a new name (O17); a
publisher-side `exclude` in a marketplace entry (T16); per-target hook overrides in the
hook mapping table (O11). The personal layer (`palm.local.yaml`, per-person disable of a
team entry) and the context cost in `get` stay on the 0.3 list above.

1.0, verified. Every placement row and hook mapping row carries the harness version it
was tested against, with an end-to-end job that runs the real CLIs for all six targets;
Gemini and OpenCode leave the unverified tier or are dropped; the docs are rewritten
around the eight verbs; the persona study is rerun with a target of at least fifteen yes
or leaning-yes verdicts and no S1 finding. Native Windows stays on the list: 0.2 and 0.3
run on macOS and Linux, and Windows maintainers run palm inside WSL (O18).

## 8. Migration from 0.1.0

`palm migrate` ships in 0.2 and is removed in 0.3. It reads the old palm.yaml,
palm.lock.yaml and `~/.palm/config.yaml` and writes the new palm.yaml. Every alias the
lock references becomes a source with its URL, root, layout and locked ref
(`~ palm.yaml: source acme added from ~/.palm/config.yaml, needed by 3 entries; commit it`).
`name@alias#ref` becomes an entry under its source, with a warning when entries from one
source disagree on refs. A plugin becomes a `plugins:` entry with its excludes; a command
becomes a skill; a registry MCP server is copied from the rendered `.mcp.json` into
`mcp:`; `--target` leaks become per-entry `targets:` or move to `palm.local.yaml` with a
note; an `@mine` entry warns. It moves `.palm/hooks/*` to `.palm/assets/`, replaces the
`.palm/` ignore line with `.palm/local/`, runs a bare install that adopts identical files,
and prints the executables it re-vendored so the person running it consents once. Under
`-g` it rewrites absolute paths to tokens and lists literal secrets with the rotate
message.

## 9. Decisions taken

These changed the shape of the product and reversed choices made earlier in the project.
The maintainer decided them on 2026-09-30; the plan above assumes the answers.

1. CLI grammar. The source comes first: `palm install <source> [names]`, kinds as
   optional prefixes, `get` and `describe` keep the kubectl nouns. The old forms stay as
   hidden aliases for one release.
2. The word. "origin" becomes "source" in the CLI, the files and the docs.
3. The registry client goes. `create` stays as a prompt-free template writer; the
   wizard and `mine` go. MCP servers keep a first-class path in (section 4.12).
4. Targets. All six stay; Gemini and OpenCode are marked unverified until the 1.0
   end-to-end job runs them.
