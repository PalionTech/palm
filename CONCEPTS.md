# Concepts: what the agent-resource ecosystem actually consists of

Checked against the official docs of Claude Code, Codex CLI, GitHub Copilot,
Cursor, Gemini CLI and OpenCode, the Agent Skills spec (agentskills.io), the
Agent Plugins spec (agent-plugins.org), the MCP spec and registry, A2A and the
AGENTS.md convention, on 2026-09-27.

## The two-level picture

There are **primitives** (leaf content a harness loads) and **composites**
(bundles of primitives). Most confusion comes from mixing the levels.

```
composites   plugin ─────────────┐        agent bundle ────────┐
             │ manifest          │        │ agent definition   │
             │ skills/           │        │ + skills it uses   │
             │ agents/           │        │ + MCP servers      │
             │ commands/         │        │ + instructions     │
             │ hooks/            │        │ + hooks            │
             │ .mcp.json         │        └────────────────────┘
             └───────────────────┘
primitives   instruction · skill · command · agent definition · hook · MCP server config
```

## Primitives

**Instruction.** Always-on or path-scoped markdown that a harness injects as
context. `CLAUDE.md`, `.claude/rules/*.md`, `AGENTS.md`, `GEMINI.md`,
`.github/copilot-instructions.md`, `*.instructions.md` (`applyTo` globs),
`.cursor/rules/*.mdc` (`globs`, `alwaysApply`). It is advisory: it shapes
behaviour, it enforces nothing. Only hooks enforce. `AGENTS.md` is a Linux
Foundation convention read by Codex, Copilot, Cursor, OpenCode; Claude Code
reads it only when no `CLAUDE.md` exists.

**Skill.** A directory with a `SKILL.md` whose frontmatter has `name` (slug,
must equal the directory name) and `description` (up to 1024 chars, decides
when the model loads it), plus optional `scripts/`, `references/`, `assets/`.
Loaded in stages: name + description at startup, body on activation, extra
files on demand. So a skill **already can carry scripts and assets**; that is
not what makes something a plugin. Every harness now reads the Agent Skills
format; all except Claude Code also read the shared `.agents/skills/` folder.

**Command (prompt).** A `/name` template the user invokes: `.claude/commands/*.md`,
`.github/prompts/*.prompt.md`, Gemini `commands/*.toml`. Claude Code and Cursor
have folded commands into skills; Codex and Copilot mark prompt files as
deprecated. New work should be a skill.

**Agent definition (subagent).** One file = system prompt + a `description`
that tells the main agent when to delegate + tool allow/deny list + model. It
runs in its own context and returns a summary. Claude Code `.claude/agents/*.md`,
Codex `.codex/agents/*.toml`, Copilot `.github/agents/*.agent.md`, Cursor
`.cursor/agents/*.md`. Claude, Codex, Copilot and Gemini agent files can
*reference* skills and MCP servers by name; none of them *contain* them. That
is the key correction to "an agent is a package of skills + MCP + instructions":
in the harnesses an agent is a primitive that points at other primitives. palm
treats those references as dependencies, which gives you the bundle behaviour
you wanted without inventing a new file format.

**Hook.** Lifecycle event (session start, before/after tool use, stop, prompt
submit) + matcher → handler, usually a shell command. This is executable code
that runs on your machine, so treat installing hooks like installing software.
The schemas differ per harness: Claude and Codex use PascalCase events in
`settings.json` / `hooks.json`; Cursor and Copilot use camelCase with `version: 1`.

**MCP server.** A connection spec, not content: a stdio command or an HTTP URL,
plus env/headers. The server exposes tools, resources and prompts. Config
shapes differ per harness (`.mcp.json`, `config.toml [mcp_servers.x]`,
`.vscode/mcp.json` with `servers`, `.cursor/mcp.json`). Auth: stdio servers
take credentials from env vars; HTTP servers use OAuth 2.1, which the harness
performs on first connect, so a package manager only needs to place the URL
and any static header secrets sensibly.

## Composites

**Plugin.** A distributable bundle: a manifest plus any of the primitives above
(Claude `.claude-plugin/plugin.json`, Cursor `.cursor-plugin/plugin.json`,
Codex `.codex-plugin/plugin.json`, Gemini `gemini-extension.json`, and the new
cross-vendor `plugin.json` from agent-plugins.org that Codex, Cursor and
Copilot read). A plugin is the unit repos publish; it is *not* a different kind
of skill. Plugins do not nest.

**Agent bundle.** Your concept. In harness terms it is an agent definition plus
everything it references. Platforms that host agents (Claude Managed Agents,
the Agent SDK, A2A agent cards) do define an agent this way: model + system
prompt + tools + MCP servers + skills. palm implements it as "agent definition
with dependencies": `palm install agent reviewer` installs the file and then
resolves and installs the skills and MCP servers it names.

**Marketplace / registry.** An index that points at plugins or servers:
`marketplace.json` (Claude, Cursor, Copilot and Codex each have a slightly
different schema) and the MCP Registry (`server.json` entries, servers only).
In palm an **origin** is one repo or directory that gets scanned; a
**registry** is a named list of origins.

## Not a packaging concept

**Capability.** In MCP it is protocol feature negotiation (`tools`,
`resources`, `prompts`, `sampling`, `elicitation`). In A2A agent cards it lists
protocol features like `streaming`. No harness has a "capability" file. If you
want to express "this agent can do X", that is the agent's `description` or a
skill; if you want "this needs Y", that is a dependency.

## Target (harness)

The host program that discovers primitives at well-known paths and runs the
loop: Claude Code, Codex CLI, Copilot (CLI and VS Code differ), Cursor,
Gemini CLI, OpenCode, Windsurf. A package manager's job is to write the same
primitive into each target's paths and formats, at project or user scope.
