# Concepts

palm 0.2 uses five words the same way in its commands, its files and its docs: source, entity,
target, scope and generated file. Two more follow from them, the lock and consent. The harness
facts below were checked against the official docs of Claude Code, Codex CLI, GitHub Copilot,
Cursor, Gemini CLI and OpenCode, the Agent Skills spec (agentskills.io), the Agent Plugins spec
(agent-plugins.org), the MCP spec and the AGENTS.md convention, on 2026-09-27.

```
source (palm.yaml)          entities                 targets            generated files (committed)
mattpocock/skills  ──────►  skill tdd  ──────────►  claude  ─────────►  .claude/skills/tdd/
  ref: ^1.2                                          codex   ─────────►  .agents/skills/tdd/
obra/superpowers   ──────►  plugin superpowers
  ref: ^4                     selects skill ...
                              and hook session-start ► claude ───────►  .claude/settings.json (merged)
                                                                         .palm/assets/obra__superpowers/...
                            palm.lock.yaml: commit per source, render hash per entry and target, trust
```

## Sources

A **source** is a git repository, optionally a folder inside it at a ref, or a directory inside the
project. It is declared in the `palm.yaml` of its scope, so it is a dependency of the project and
never a per-user registration. A GitHub repository is written `owner/repo`; any other repository
gets a name and a `url:`; an in-repo directory is `./dir`. A source may carry an optional `alias:`.

A source has one `ref:`, a tag, branch, commit or semver range, and that is the only place a version
lives. The lock records what the ref resolved to. `palm update` moves the commit within the range,
and `palm update --to` moves the range.

An in-repo source, such as `./agent-kit`, is rendered from the working tree and is the truth. A bare
`palm install` re-renders what changed, and `palm check` fails on drift. `palm create` writes
templates into it.

A marketplace or plugin manifest inside a source is only a hint palm uses to find entities. palm
never fetches another repository on its own and has no registry to look a name up in.

## Entities

An **entity** is one item palm installs, named within its source. There are five kinds, and a
plugin selects several of them.

### Skill

A folder with a `SKILL.md` whose frontmatter has `name` (a slug that matches the folder)
and `description` (which decides when the model loads it), plus optional `scripts/`, `references/`
and `assets/`. The harness loads the name and description at startup, the body on activation and
the other files on demand. Every harness reads the Agent Skills format; all except Claude Code also
read the shared `.agents/skills/` folder.

### Agent (subagent)

One file with a system prompt, a `description` that tells the main agent when
to delegate, a tool list and a model. It runs in its own context and returns a summary. Claude
Code `.claude/agents/*.md`, Codex `.codex/agents/*.toml`, Copilot `.github/agents/*.agent.md`,
Cursor `.cursor/agents/*.md`. An agent file may name skills and MCP servers it uses; it does not
contain them. palm installs the agent and prints the command for what it names, and never installs
dependencies you did not ask for.

### Instruction

Markdown context a harness injects: always on, scoped to paths, or loaded on
request. `.claude/rules/*.md`, a block in `AGENTS.md` or `GEMINI.md`, `*.instructions.md` with
`applyTo`, `.cursor/rules/*.mdc` with `globs` or `alwaysApply`. It shapes behaviour and enforces
nothing; only hooks enforce. palm never edits `CLAUDE.md`.

### Hook

Lifecycle events and matchers with shell commands: session start, before and after tool
use, stop, prompt submit. This is code that runs on your machine, so palm treats it like
installing software (see consent below). The scripts a hook runs are copied to
`.palm/assets/<source>/<entity>/` and committed.

### MCP server

A connection, not content: a stdio command or a URL, with environment variables and
headers. The server exposes tools, resources and prompts. Each harness keeps servers in its own
file and syntax (`.mcp.json`, `config.toml [mcp_servers.x]`, `.vscode/mcp.json` with `servers`,
`.cursor/mcp.json`, `.gemini/settings.json`, `opencode.json`). A stdio server takes credentials from
environment variables; an HTTP server usually uses OAuth, which the harness performs on first
connect, so palm only places the URL and references to any static header secrets.

### Plugins select entities

A plugin is a distributable bundle with a manifest (Claude
`.claude-plugin/plugin.json`, Cursor `.cursor-plugin/plugin.json`, Codex `.codex-plugin/plugin.json`,
Gemini `gemini-extension.json`, the cross-vendor `plugin.json`). In palm it is a selector over a
source's entities, recorded as `plugins:` with `only:` or `exclude:`, and never something that lands
in a harness as a unit. Each member gets its own lock entry with `via: plugin:<name>`.

### Commands install as skills

A `/name` prompt template (`commands/*.md`, `prompts/*.prompt.md`,
Gemini `commands/*.toml`) is indexed as a skill of the same name, with a note. Claude Code and Cursor
merged commands into skills, and Codex and Copilot deprecate prompt files. `$ARGUMENTS` survives in
Claude Code and Cursor; where a harness does not expand it, the note says so.

## Targets

A **target** is palm's identifier for a harness: `claude`, `codex`, `copilot`, `cursor`, `gemini`,
`opencode`. The scope's set is declared once as `targets:` in `palm.yaml` and narrowed per entry with
`targets:`. palm writes each entity where each target reads it, in its native format, once per
harness. Cursor reads `.claude/skills` when `claude` is a target, and `.agents/skills` is written
once for everyone else. Where a harness has no place for a kind, palm skips it with a note. The
Gemini CLI and OpenCode placements follow their docs and source and are marked unverified until an
end-to-end job runs the real CLIs.

## Scopes

A **scope** is `project` (the directory holding `palm.yaml`, found by walking up to the nearest
`.git`) or `global` (`-g`, your home directory and the harness homes). Both use the same files and
verbs. The global lock writes paths as tokens such as `<claude>/skills/x`, so `~/.palm/palm.yaml`
and its lock can live in a dotfiles repository; `~/.palm/applied.yaml` records what this machine
holds.

## Generated files

A **generated file** is anything palm writes. Every path is listed in the lock. In a project,
generated files are committed, so git carries them to teammates and CI, the diff is the review, and
a clone works without palm. palm keeps no machine state in a project. The only palm paths git ignores
are `.palm/local/` and `palm.local.yaml`, reserved for personal additions in 0.3.

## The lock

`palm.lock.yaml` records per source the URL, range, resolved tag, commit and layout, and per entry
one content hash, one render hash per target, the file list, the identities of merged fragments,
program hashes and trust. It holds no absolute path, hostname, timestamp or secret, so every
machine writes the same bytes. Every generated file is a function of `palm.yaml`, the lock and the
sources; `palm check` recomputes each one and fails on any difference, and a bare `palm install`
makes the disk match.

## Consent

Hooks and stdio MCP servers run programs. Before palm writes one, it shows the source and commit,
every command as each harness will run it, the files it lands in, and every script with its mode,
size and hash. The default answer is no, and `--yes` never consents. A yes is a hash over the
commands and the script bytes, recorded as `trust:` in the lock and replayed silently on every
machine while it matches; any change asks again. Without a terminal, only an
`--allow-exec <kind>:<name>@<source>=<hash>` line consents. palm never runs what it installs.

## Not palm words

"Origin", "registry" and "capability" are not palm words. A source is where entities come from.
palm has no registry; you name the repository. In MCP, a capability is protocol feature negotiation
(`tools`, `resources`, `prompts`, `sampling`); no harness has a capability file, and "this agent can
do X" is an agent's `description` or a skill.
