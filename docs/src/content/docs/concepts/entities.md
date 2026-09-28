---
title: Entities and kinds
description: An entity is one item palm installs. Its kind decides which file each harness gets.
---

An **entity** is one item palm can install, such as a skill, a subagent or an MCP server.
Its **kind** names which of the seven types it is.

```sh
palm install skill tdd
palm install agent reviewer
palm install mcp io.github.upstash/context7
```

Each command names a kind and an entity.
palm finds the entity in your [origins](/palm/concepts/origins/) and writes one file per [target](/palm/concepts/targets/).

## The seven kinds

| Kind | What it is | Also accepted |
| --- | --- | --- |
| `skill` | A folder with a `SKILL.md`, plus optional `scripts/`, `references/` and `assets/`. The harness loads it on demand. | `skills` |
| `agent` | An agent (subagent): one file with a system prompt, a delegation description, tools and a model. | `agents`, `subagent`, `subagents` |
| `instruction` | Markdown context that is always on or scoped to paths. It advises the model and enforces nothing. | `instructions`, `rule`, `rules` |
| `command` | A `/name` prompt template that you invoke. Most harnesses now prefer skills. | `commands`, `prompt`, `prompts` |
| `hook` | A lifecycle event, a matcher and a shell command. It runs code on your machine. | `hooks` |
| `mcp` | An MCP server connection: a command that starts it, or a URL. | `mcp-server`, `server`, and their plurals |
| `plugin` | A bundle with a manifest and any of the kinds above. | `plugins`, `bundle`, `bundles` |

Without a kind, palm searches every kind: `palm install tdd`.
A plural installs several entities of one kind: `palm install skills tdd grill-me`.

## Primitives and composites

Six kinds are **primitives**: a harness reads them directly.
A plugin is a **composite**: installing it installs its members, and uninstalling it removes them.

An agent is a primitive with dependencies.
Its frontmatter can name skills and MCP servers, and palm installs those with it.

```md title="agents/reviewer.md"
---
name: reviewer
description: Reviews a diff for bugs before merge.
skills: [tdd]
mcpServers: [github]
---

You review diffs. Report bugs with file and line.
```

palm records who pulled each dependency in.
When you uninstall the agent, a dependency goes too, unless another entry still needs it.

## Names

An entity name is one path segment: letters, digits, `.`, `_` and `-`, starting with a letter or digit.
palm refuses any other name before it writes a file.
A skill takes its name from the `name` in its `SKILL.md`, else from its folder.
The [scan rules](/palm/reference/scan-rules/#names-and-versions) list the source of every other name.

To pick an entity from one origin, add `@origin`. To pin a version, add `#ref`:

```sh
palm install skill tdd@mattpocock#v1.2.3
```

## Related

- [Where each kind goes, per harness](/palm/reference/targets-matrix/)
- [Why palm writes native files](/palm/explanation/why-native-files/)
- [Glossary](/palm/reference/glossary/)
