---
title: Scan rules
description: How palm reads a source, in priority order, how it names and versions what it finds, and what it checks every file for.
---

palm scans a source once per commit and caches the result as an index.
The first rule that matches decides how palm reads the repository.

```sh
palm install mattpocock/skills
palm describe source mattpocock/skills
```

The listing prints every entity in the index and the rule it came from.
`palm describe source <name>` shows the rule, the counts per kind and the index warnings of a declared source.

## Detection order

| Order | Rule | Applies when | What palm reads |
| --- | --- | --- | --- |
| 0 | Ignore list | always | skips the paths in [What palm ignores](#what-palm-ignores) |
| 1 | Layout descriptor | the source has a [`layout:`](/palm/reference/layout/) | only the globs in the descriptor; detection is skipped |
| 2 | APM package | `apm.yml` with an `.apm/` folder | `.apm/skills`, `.apm/agents`, `.apm/instructions`, `.apm/prompts`, `.apm/hooks` |
| 3 | Marketplace | a marketplace file, see below | one plugin per entry with a relative source, each scanned at its path |
| 4 | Plugin manifest | a plugin manifest, see below | the manifest's members, then the default folders |
| 5 | Conventions | none of the above | the file patterns in the conventions table |

An APM package's `dependencies.apm` is never followed. palm prints one warning with a `palm install <owner/repo>` line per dependency.

### Marketplace files

palm takes the first that exists.

1. `.claude-plugin/marketplace.json`
2. `.cursor-plugin/marketplace.json`
3. `.github/plugin/marketplace.json`
4. `.agents/plugins/marketplace.json`

An entry with a remote source becomes a warning that ends in the command declaring it, such as `remote plugin "x" (<source>) not fetched: declare it: palm install owner/repo[/path][#ref] <names>`.
An entry that resolves to the source itself is skipped without a warning.
A single entry with source `./` collapses into the root plugin.
An entry with `strict: false` and a `skills` list is exactly that subset.

### Plugin manifests

palm picks one manifest per plugin and never merges two.

1. `.claude-plugin/plugin.json`
2. `.cursor-plugin/plugin.json`
3. a root `plugin.json` with the agent-plugins `$schema`
4. `.codex-plugin/plugin.json`
5. `gemini-extension.json`

With Claude semantics, `skills` adds to the default `skills/` scan, while `agents` and `commands` replace their defaults.
`hooks` and `mcpServers` merge with `hooks/hooks.json` and `.mcp.json`, and hooks may sit inline in the manifest.

### Conventions

| Kind | Files |
| --- | --- |
| skill | a root `SKILL.md` (one skill); else `**/SKILL.md` up to five levels deep |
| agent | `agents/**/*.md` and `**/*.agent.md` with `name` and `description` frontmatter |
| skill, from a command | `commands/*.md`, `commands/*.toml`, `prompts/*.prompt.md` |
| hook | `hooks/hooks.json`, `hooks/*/hooks.json` |
| mcp | `.mcp.json` or `mcp.json`, wrapped in `mcpServers` or flat |
| instruction | `rules/*.mdc`, `rules/*.md`, `*.instructions.md`, `instructions/*.md` |

Only the top-most `SKILL.md` in a folder tree is a skill. Everything below a skill's folder is its content, including a nested `references/*/SKILL.md`.
`agents/openai.yaml` and README files are never agents.

Files that look like agents, hooks or MCP configs outside these patterns are not indexed.
palm prints one line per group with the `layout:` that indexes them, such as `i 2 agent-shaped files not indexed: people/*.md; add layout: { agents: [people/*.md] }`.

## What palm ignores

Auto-detection skips these everywhere in the tree, and any output folder it reaches through a symlink.
A layout descriptor skips only `.git`, `node_modules` and its own `exclude` globs.
A `SKILL.md` under an ignored folder name is listed as skipped, with the layout that includes it, such as `skipped (ignored name "test"; add layout: { skills: [skills/*] })`.

| Group | Paths |
| --- | --- |
| Folder names | `node_modules`, `test`, `tests`, `fixture`, `fixtures`, `eval`, `evals`, `example`, `examples`, `template`, `templates`, `docs`, `website`, `dist`, `build` |
| Install outputs | `.agents/skills`, `.claude/skills`, `.github/skills`, `.github/agents`, `.github/instructions`, `.github/prompts`, `.cursor/rules`, `.palm` |
| Root files | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` |

Install outputs are copies another installer committed. The real sources sit elsewhere in the repository.
Root files guide the repository's own contributors, not its users.
palm includes other dot folders, so `skills/.curated` in `openai/skills` is found.

## Names and versions

| Kind | Name |
| --- | --- |
| skill | `name` in the `SKILL.md` frontmatter, else the folder name |
| skill, from a command | the file name without its extension |
| agent | the file name without `.md` or `.agent.md`; a `name` with spaces becomes the display name |
| plugin | the manifest `name`, else the marketplace entry name, else the folder name |
| mcp | the server's key in the config file |

A skill `name` that is not a valid slug is replaced by the slugified folder name, with a warning.
When `name` differs from the folder name, palm keeps `name` and warns.
When a skill and a command in one source share a name, the skill wins and the command is dropped with a warning.

palm takes the version from the first of frontmatter `metadata.version`, frontmatter `version`, the manifest `version` and the git tag.

## Activation of instructions

| Source format | Activation |
| --- | --- |
| `.mdc` with `alwaysApply: true` | always |
| `.mdc` with `globs` | paths |
| `.mdc` with a description and no globs | on request |
| `.mdc` with neither | manual |
| `*.instructions.md` with `applyTo` | paths, else always |
| `instructions/*.md`, APM instructions | always |
| `.claude/rules` with `paths:` | paths, else always |

palm 0.2 records the activation and keeps today's placement per harness.
Claude Code and OpenCode have no on-request or manual rule, so such a rule is always-on there.
palm prints a notice for each one, such as `! rule x: on-request in the source, always-on for claude until 0.3`, and `palm describe` shows the activation.
palm 0.3 turns an on-request or manual rule into a skill where a harness lacks the concept, with a note.

## Checks on every file

| Finding | Severity | Effect |
| --- | --- | --- |
| bidi overrides and isolates (U+202A to U+202E, U+2066 to U+2069), tag characters (U+E0000 to U+E007F), variation selectors 17 to 256 | critical | the entity is refused, with no override |
| zero-width and other invisible format characters | warning | installed, with a warning |
| a hook or MCP reference that resolves to nothing in the source | critical | the entity is refused, with the offending line |
| a secret-shaped literal in an MCP value or hook command | critical | never written; palm writes `${NAME}` |
| a secret-shaped literal in a file a skill copies | critical | the skill is refused |
| a secret-shaped literal inside a hook or server script | warning | installed, with a warning |
| a skill folder above 200 files or 5 MB | refusal | installed only with `--force`; the message gives the count |

palm checks a skill's whole folder, the file of an agent, instruction, MCP config or hook set, and every file a hook or server runs or reads.
A skill copy leaves out harness folders such as `.cursor`, `.git`, `node_modules` and palm's own files, so a root `SKILL.md` never copies the repository's own agent setup.
Binary files and files over 1 MB are skipped. The index stores `<redacted sha256:8>` in place of a secret value.

A value counts as secret-shaped under a key only when the key holds a whole word such as `key`, `api_key`, `token`, `secret`, `password` or `authorization`.
`x-api-key` counts, `keywords` does not.

## Related

- [Scanning](/palm/concepts/scanning/)
- [Layout descriptor](/palm/reference/layout/)
- [Sources](/palm/concepts/sources/)
