---
title: Glossary
description: One definition per term, as palm's commands, files and these docs use it.
---

Each term has one meaning in palm's commands, its files and these docs.
Code formatting marks a literal value, file or flag.

```sh
palm install obra/superpowers plugin:superpowers --targets claude -g
```

This line installs every **entity** the **plugin** `superpowers` selects from the **source** `obra/superpowers`, for the **target** `claude`, in the global **scope**.

## Terms

| Term | Meaning |
| --- | --- |
| activation | When a harness loads an instruction: `always`, `on-request`, `paths` or `manual`. palm records it from the source format, and prints a notice where a harness widens it to always-on until 0.3. |
| agent | A subagent: one file with a system prompt, a delegation description, tools and a model. A kind. |
| alias | An optional short name for a source, set with `alias:` in `palm.yaml`. |
| applied record | `~/.palm/applied.yaml`: what the global scope last wrote on this machine, with real paths. The global counterpart of a git checkout. |
| asset folder | `.palm/assets/<source>/<entity>/`: the scripts a hook or stdio MCP server runs, copied from a git source and committed. |
| bare install | `palm install` with no arguments. It makes the disk match `palm.yaml` and the lock. |
| carrier | The one file through which an entity reaches a harness. palm 0.3 records it per target. |
| closure | The files a hook or server needs: the folder of its definition, every file a command names, and every file a script reads through a literal path. |
| consent | The yes a person gives before a hook or stdio MCP server lands. Recorded as a `trust:` hash in the lock. See [consent](/palm/concepts/consent/). |
| content hash | `content:` in the lock: sha256 of an entity's content in its source. For an in-repo source it is the drift signal `palm check` compares. |
| entity | One skill, agent, instruction, hook or MCP server, named within its source. |
| exec unit | One hook entry or stdio server, with its commands, events, matchers and closure, hashed as one program. |
| generated file | Any file palm writes. Every path is listed in the lock, and in a project you commit it. |
| global scope | Files under your home directory and the harness homes, chosen with `-g`. |
| harness | The program that runs a coding agent: Claude Code, Codex, GitHub Copilot, Cursor, Gemini CLI or OpenCode. |
| hook | Lifecycle events, matchers and shell commands that a harness runs. A kind. |
| in-repo source | A directory inside the project, such as `./agent-kit`, rendered from the working tree. |
| index | The scan result for one source at one commit, cached in `~/.palm/cache/`. |
| instruction | Markdown context that is always on, scoped to paths, or loaded on request, such as a rule file. A kind. |
| kind | An entity's type: `skill`, `agent`, `instruction`, `hook` or `mcp`. `plugin` is a selector. |
| layout descriptor | Globs on a source in `palm.yaml` that tell palm where it keeps its entities. See [layout](/palm/reference/layout/). |
| lock | `palm.lock.yaml`: what each source resolved to, what palm rendered per target, the files it wrote and the programs you trusted. |
| managed block | A marked section palm owns inside a shared text file, such as `AGENTS.md`. |
| manifest | `palm.yaml`: the targets, sources, entries and hand-declared MCP servers of a scope. |
| marketplace | A `marketplace.json` that lists plugins. palm reads it to find entities inside a source. |
| mcp | An MCP server connection: a command to start (stdio) or a URL (HTTP). A kind. |
| merged entry | A fragment palm owns inside a shared file, such as a server in `.mcp.json`, found by its identity. |
| plugin | A set of entities a source groups, usually with a `plugin.json`. In palm, a selector over the source's entities, recorded under `plugins:`. |
| project scope | Files under the project root. The default. |
| ref | A source's version intent: a tag, branch, commit or semver range, written as `ref:` in `palm.yaml`. |
| render hash | `render.<target>:` in the lock: sha256 over the files and fragments one target writes for an entry. |
| scope | Where palm writes: `project` or `global`. |
| skill | A folder with a `SKILL.md` that a harness loads on demand. A kind. |
| source | A git repository, a folder in one at a ref, or a directory inside the project, declared in `palm.yaml`. |
| target | palm's identifier for a harness: `claude`, `codex`, `copilot`, `cursor`, `gemini` or `opencode`. |
| token | A placeholder for a home folder in the global lock, such as `<claude>` or `<home>`. |
| tree hash | `tree:` in an entry's `exec.closure`: the hash of every file in a program's closure, mode bits included. |
| trust | The list of program hashes a person consented to, stored on the lock entry. |

## Words palm does not use

| Instead of | palm says |
| --- | --- |
| origin | source |
| registry | nothing: palm has none; name the repository |
| package, resource | entity, or the kind by name |
| command, prompt (as a kind) | skill |
| deploy | install |
| harness, as a verb | install, write |
| lockfile state, machine state | the lock; git for a project, `applied.yaml` for the global scope |
