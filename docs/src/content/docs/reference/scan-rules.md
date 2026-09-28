---
title: Scan rules
description: How palm reads an origin, in priority order, and how it names and versions what it finds.
---

palm scans every origin when you add or update it, and stores the result as an index.
The first rule that matches decides how palm reads the repository.

```sh
palm install origin mattpocock/skills
palm get --available -o mattpocock
```

`palm install origin` prints the counts it found and the rule it used, such as `detected: marketplace`.
`palm get --available` lists every entity in the index.
`palm describe origin <alias>` shows the rule, the counts and the index warnings later.

## Detection order

| Order | Rule | Applies when | What palm reads |
| --- | --- | --- | --- |
| 1 | Layout descriptor | the origin has a [`layout`](/palm/reference/layout/) | only the globs in the descriptor; detection is skipped |
| 2 | APM package | `apm.yml` with an `.apm/` folder | `.apm/skills`, `.apm/agents`, `.apm/instructions`, `.apm/prompts`, `.apm/hooks` |
| 3 | Marketplace | a marketplace file, see below | one `plugin` per entry with a relative source, each scanned at its path |
| 4 | Plugin manifest | a plugin manifest, see below | the manifest's members, then the default folders |
| 5 | Conventions | none of the above | the file patterns in the conventions table |

An `apm.yml` without primitives falls through to the next rule.

### Marketplace files

palm takes the first that exists:

1. `.claude-plugin/marketplace.json`
2. `.cursor-plugin/marketplace.json`
3. `.github/plugin/marketplace.json`
4. `.agents/plugins/marketplace.json`

An entry with a remote source becomes a warning ("add it as an origin"); palm does not fetch it.
A single entry with source `./` collapses into the root plugin.
An entry with `strict: false` and a `skills` list installs exactly that subset.

### Plugin manifests

palm picks one manifest per plugin and never merges two:

1. `.claude-plugin/plugin.json`
2. `.cursor-plugin/plugin.json`
3. root `plugin.json` with the agent-plugins `$schema`
4. `.codex-plugin/plugin.json`
5. `gemini-extension.json`

With Claude semantics, `skills` adds to the default `skills/` scan, while `agents` and `commands` replace their defaults.
`hooks` and `mcpServers` merge with `hooks/hooks.json` and `.mcp.json`, and hooks may sit inline in the manifest.

### Conventions

| Kind | Files |
| --- | --- |
| skill | a root `SKILL.md` (one skill); else `**/SKILL.md` up to five levels deep |
| agent | `agents/**/*.md` and `**/*.agent.md` with `name` and `description` frontmatter |
| command | `commands/*.md`, `commands/*.toml`, `prompts/*.prompt.md` |
| hook | `hooks/hooks.json`, `hooks/*/hooks.json` |
| mcp | `.mcp.json` or `mcp.json`, wrapped in `mcpServers` or flat |
| instruction | `rules/*.mdc`, `*.instructions.md`, `instructions/*.md` |

A `SKILL.md` below another skill's folder is a sub-skill of that skill.
`agents/openai.yaml` and README files are never agents.

## What palm ignores

Auto-detection skips these everywhere in the tree.
A layout descriptor skips only `.git`, `node_modules` and its own `exclude` globs.

| Group | Paths |
| --- | --- |
| Folder names | `node_modules`, `.git`, `test`, `tests`, `fixture`, `fixtures`, `eval`, `evals`, `example`, `examples`, `template`, `templates`, `docs`, `website`, `dist`, `build` |
| Install outputs | `.agents/skills`, `.claude/skills`, `.claude/agents`, `.claude/commands`, `.claude/rules`, `.github/skills`, `.github/agents`, `.github/instructions`, `.github/prompts`, `.github/hooks`, `.cursor/rules`, `.cursor/agents`, `.cursor/commands`, `.codex/agents`, `.codex/prompts`, `.vscode` |
| Root files | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.mcp.json.example`, `.cursor/mcp.json`, `.cursor/hooks.json` |

Install outputs are copies that another installer committed; the real sources sit elsewhere in the repository.
Root files guide the repository's own contributors, not its users.
palm includes other dot folders, so `skills/.curated` in `openai/skills` is found.

## Names and versions

| Kind | Name |
| --- | --- |
| skill | `name` in the `SKILL.md` frontmatter, else the folder name |
| agent | the file name without `.md` or `.agent.md`; a `name` with spaces becomes the display name |
| plugin | the manifest `name`, else the marketplace entry name, else the folder name |
| mcp | the server's key in the config file |

A skill `name` that is not a valid slug is replaced by the slugified folder name, with a warning.
When the `name` differs from the folder name, palm keeps the `name` and warns.

palm takes the version from the first of: frontmatter `metadata.version`, frontmatter `version`, the manifest `version`, the git tag.

## Related

- [Layout descriptor](/palm/reference/layout/)
- [Origins](/palm/concepts/origins/)
- [Why origins, not a registry](/palm/explanation/why-origins/)
