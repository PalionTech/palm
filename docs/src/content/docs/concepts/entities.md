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

Each command names a kind, then an entity.
palm finds the entity in your [origins](/palm/concepts/origins/) and writes it for each [target](/palm/concepts/targets/).
The third command resolves its name through the official MCP registry instead.

## The seven kinds

| Kind | Short name | What it is | Also accepted |
| --- | --- | --- | --- |
| `skill` | `sk` | A folder with a `SKILL.md`, plus optional `scripts/`, `references/` and `assets/`. The harness loads it on demand. | `skills` |
| `agent` | `ag` | An agent (subagent). One file holds a system prompt, a delegation description, tools and a model. | `agents`, `subagent`, `subagents` |
| `instruction` | `ins` | Markdown context that is always on or scoped to paths. It advises the model and enforces nothing. | `instructions`, `rule`, `rules` |
| `command` | `cmd` | A `/name` prompt template that you invoke. Most harnesses now prefer skills. | `commands`, `prompt`, `prompts` |
| `hook` | `hk` | A lifecycle event, a matcher and a shell command. It runs code on your machine. | `hooks` |
| `mcp` | `mcp` | An MCP server connection, either a command that starts it or a URL. | `mcps`, `mcp-server`, `server`, and their plurals |
| `plugin` | `pl` | A bundle with a manifest and any of the kinds above. | `plugins`, `bundle`, `bundles` |

The kind word is optional.
`palm install tdd` searches every kind for `tdd`.
A plural installs several entities of one kind, as in `palm install skills tdd grill-me`.

## Bundles and dependencies

A harness reads six of the kinds directly.
A plugin is different, because no harness file holds a plugin.
Installing a plugin installs its members, and uninstalling it removes them.

An agent is one file, but it can name other entities.
Its frontmatter lists the skills and MCP servers it uses, and palm installs those with it.

```md title="agents/reviewer.md"
---
name: reviewer
description: Reviews a diff for bugs before merge.
skills: [tdd]
mcpServers: [github]
---

You review diffs. Report bugs with file and line.
```

palm records which entry pulled each dependency in.
When you uninstall the agent, a dependency goes too, unless another entry still needs it.
[Dependencies](/palm/concepts/dependencies/) shows a full session.

## Executable kinds

Hooks and stdio MCP servers start programs on your machine.
Before palm writes one, it lists the command and asks once.
A script passes `--yes` instead.
The [security model](/palm/explanation/security/) covers what palm checks for every kind.

## Names

An entity name is one path segment.
It uses letters, digits, `.`, `_` and `-`, and starts with a letter or a digit.
palm refuses any other name before it writes a file.

A skill takes its name from the `name` in its `SKILL.md`, else from its folder.
An agent takes the file name without `.md` or `.agent.md`.
The [scan rules](/palm/reference/scan-rules/#names-and-versions) list the source of every other name.

## Pick an origin and a version

A request has the form `<name>[@<origin>][#<ref>]`.

```sh
palm install skill tdd@mattpocock
palm install skill tdd@mattpocock#v1.2.3
palm install skill tdd@mattpocock#^1.2
```

- `@mattpocock` takes the skill from the origin with that alias.
- `#v1.2.3` pins a tag. A branch or a commit works the same way.
- `#^1.2` takes the highest tag in a semver range.

The lockfile records the tag and the commit palm installed.

## Related

- [Where each kind goes, per harness](/palm/reference/targets-matrix/)
- [Why palm writes native files](/palm/explanation/why-native-files/)
- [Glossary](/palm/reference/glossary/)
