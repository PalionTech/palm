---
title: Glossary
description: One definition per term, as these docs use it.
---

Each term has one meaning in these docs.
Code formatting marks a literal value, file or flag.

```sh
palm install agent reviewer@pstack#v1.0.0 --target claude -g
```

This line installs the **entity** `reviewer`, of **kind** `agent`, from the **origin** `pstack` at **ref** `v1.0.0`.
It installs for the **target** `claude`, in the global **scope**.

## Terms

| Term | Meaning |
| --- | --- |
| agent | A subagent: one file with a system prompt, a delegation description, tools and a model. A kind. See [entities](/palm/concepts/entities/). |
| alias | The short name of an origin, used after `@`, as in `tdd@mattpocock`. See [origins](/palm/concepts/origins/#aliases). |
| command | A `/name` prompt template that the user invokes. A kind. |
| composite | An entity that bundles others. `plugin` is the composite kind. |
| config | `~/.palm/config.yaml`: your origins, default targets and preferences. See [config.yaml](/palm/reference/config-yaml/). |
| consent | The one question palm asks before it writes hooks or stdio MCP servers, which run commands on your machine. Scripts pass `--yes`. |
| dependency | An entity installed because an agent or plugin named it. The lockfile records it with `via`. |
| drift | A difference between the lockfile and the disk: a file missing, or changed since palm wrote it. `palm doctor` and `palm audit` report it. |
| entity | One installable item, such as a skill or an MCP server. See [entities](/palm/concepts/entities/). |
| global scope | Files under your home directory, chosen with `-g`. See [scopes](/palm/concepts/scopes/). |
| harness | The program that runs a coding agent: Claude Code, Codex, GitHub Copilot, Cursor, Gemini CLI or OpenCode. |
| hook | A lifecycle event, a matcher and a shell command. A kind. |
| index | The scan result for one origin, cached in `~/.palm/cache/`. |
| instruction | Markdown context that is always on or scoped to paths, such as a rule file. A kind. |
| kind | The type of an entity: `skill`, `agent`, `instruction`, `command`, `hook`, `mcp` or `plugin`. |
| layout descriptor | Globs that tell palm where an origin keeps its entities. See [layout](/palm/reference/layout/). |
| lockfile | `palm.lock.yaml`: every file and merged entry palm wrote, with the source commit and a hash per file. See [palm.lock.yaml](/palm/reference/palm-lock-yaml/). |
| managed block | A marked section palm owns inside a shared text file, such as `AGENTS.md`. |
| manifest | `palm.yaml`: the entities you asked for, and optionally targets and origins. See [palm.yaml](/palm/reference/palm-yaml/). |
| marketplace | A `marketplace.json` that lists plugins. palm reads it as an origin, one plugin per entry. |
| mcp | An MCP server connection: a command to start, or a URL. A kind. |
| `mine` | The local origin at `~/.palm/mine` that `palm create` writes to. |
| origin | A git repository, a folder in one, or a local directory that palm installs from. |
| plugin | A bundle with a manifest and any of the other kinds. A kind. |
| primitive | An entity a harness reads directly: every kind except `plugin`. |
| project scope | Files under the project root. The default scope. |
| ref | A git tag, branch, commit or semver range, written after `#`, as in `tdd#v1.2.3` or `tdd#^1.2`. See [refs](/palm/reference/cli/#refs). |
| registry | Only the official MCP registry. palm has no registry for other kinds. |
| scope | Where palm writes: `project` or `global`. |
| skill | A folder with a `SKILL.md` that a harness loads on demand. A kind. |
| target | palm's identifier for a harness: `claude`, `codex`, `copilot`, `cursor`, `gemini` or `opencode`. See [targets](/palm/concepts/targets/). |

## Words these docs avoid

| Instead of | Write |
| --- | --- |
| package, resource | entity, or the kind by name |
| deploy | install |
| harness, as a verb | install, write |
| registry, for origins | origin |
| target, for the program | harness |
