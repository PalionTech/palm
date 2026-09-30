---
title: Troubleshooting
description: From a message palm prints to its cause and its fix.
---

Each section starts with what palm prints, then says why and what to do.
Start with `palm check`. It runs every consistency check, writes nothing, and ends each problem with the command that fixes it.

```sh
palm check
palm install --dry-run
```

| Symptom | Section |
| --- | --- |
| `"tdd" is not a repository` | [A name instead of a repository](#a-name-instead-of-a-repository) |
| `palm.yaml is in the 0.1 format`, `unknown option '--frozen'` | [Files from palm 0.1](#files-from-palm-01) |
| `programs need your consent and there is no terminal` | [Consent in CI](#consent-in-ci) |
| `exists and differs from what palm would write` | [A file is in the way](#a-file-is-in-the-way) |
| `owned by`, `E_CONFLICT` naming another source | [Two sources, one name](#two-sources-one-name) |
| `modified since install`, `! modified (kept)` | [You changed a generated file](#you-changed-a-generated-file) |
| `local-sources` fails in `palm check` | [An in-repo source changed](#an-in-repo-source-changed) |
| `is ignored by git`, `is untracked` | [Generated files are ignored](#generated-files-are-ignored) |
| `repository not found or private`, `did not answer`, `not in the cache` | [A source is unreachable](#a-source-is-unreachable) |
| `overlaps the claude output directory`, `is a symlink to` | [A source overlaps an output folder](#a-source-overlaps-an-output-folder) |
| `cannot relocate` | [A hook names a missing script](#a-hook-names-a-missing-script) |
| `hidden Unicode` | [Hidden Unicode refusal](#hidden-unicode-refusal) |
| `is not set` | [A variable is not set](#a-variable-is-not-set) |

## A name instead of a repository

You see `x "tdd" is not a repository. palm installs from git repositories:`, followed by a pasteable command.

palm installs from repositories you name and has no registry to look a name up in.
Before it says so, palm tries the word against what you already have, and the hint follows the first match.

| The word is | The hint |
| --- | --- |
| a folder in the project, such as `.agents-kit` | `palm install ./.agents-kit ...` |
| an entity a declared source offers | `palm install <source> <name>` with that source |
| the owner of a declared source, such as `mattpocock` | `did you mean mattpocock/skills?` |
| a kind word, such as `rules` or `subagent` | what palm calls that kind, and how to install one from a source |
| anything else | examples from your declared sources, or two fixed ones, and a GitHub search for the right file name per kind |

Run the command on the next line, such as `palm install mattpocock/skills tdd`. The GitHub search link finds the repository when you do not know it.

## Files from palm 0.1

You see `x palm.yaml is in the 0.1 format` or `x palm.lock.yaml is version 2 (palm 0.1)`, with the hint `palm migrate`.
A 0.1 flag, such as `--frozen`, `--from` or `--alias`, prints its 0.2 replacement.

palm 0.2 declares sources in `palm.yaml` and writes lock version 3.

Run `palm migrate --dry-run`, then `palm migrate`, and commit. See [Migrate from palm 0.1](/palm/guides/migrate-from-0-1/).

## Consent in CI

You see `x 1 program needs your consent and there is no terminal`, with a `review:` and a `then:` line.

A hook or stdio MCP server is new or changed, and its hash is not in the lock's `trust:`.

Run the `review:` command on your machine, read the scripts, install with the `then:` line or on a terminal, and commit the lock. CI replays the trust from then on.

## A file is in the way

You see `x agent comment-sicko from cursor/plugins → cursor: .cursor/agents/comment-sicko.md exists and differs from what palm would write`, with the command and `--force` below.

The file exists, the lock does not list it, and its content differs. An identical file would have been adopted silently.

Compare the file with the source. Keep your change in your own in-repo source, or repeat the command with `--force` to replace the file. See [Adopt files you copied by hand](/palm/guides/adopt-existing-files/).

## Two sources, one name

You see `E_CONFLICT` naming the entry that already owns the name, such as `owned by skill tdd from mattpocock/skills`.

One scope holds one entity per kind and name, because both would write the same files.

Pick one. The message prints `palm remove <source> <kind:name>` for the owner. `--force` does not apply here.

## You changed a generated file

You see `! modified (kept)` in an install, `x skill tdd: .claude/skills/tdd/SKILL.md was modified since install` on remove, or `x 1 file differs from the lock` in `palm check`.

The file differs from the render the lock records.

To keep the edit, move it into your own source with `palm create <kind> <name> --in <dir>`, and edit it there.
To drop it, repeat the command the message prints, with `--force`.

## An in-repo source changed

You see `palm check` fail on `local-sources`, naming each entry of `./agent-kit` whose files changed since the lock was written.

Someone edited `./agent-kit` without running palm, so the harness copies are older than the source.

Run `palm install`, which re-renders the changed entries. Then commit `palm.lock.yaml` and the files it re-rendered.

## Generated files are ignored

You see `palm check` fail on `git-ignored`, naming generated files, a merged file such as `.mcp.json`, or `.palm/assets`.

A `.gitignore` line, often `.palm/` from palm 0.1 or a blanket `.claude/`, keeps the files out of git, so teammates never receive them.
palm tests each file the lock lists, and each file palm merged into, not only the folders.

Remove the line. palm needs only `.palm/local/` and `palm.local.yaml` ignored.
A file that is not ignored but not yet added is a warning that names `git add`.

## A source is unreachable

You see `repository not found or private`, `The remote did not answer`, `E_NETWORK`, or `is not in the cache, and --offline allows no fetch`.

A typo in the name, no network, a proxy git does not know about, a private repository without credentials, a moved repository, or an empty cache under `--offline`.

Check the spelling. Run `git ls-remote <url>` to see git's own error, or set `PALM_DEBUG=1` to have palm print it. palm never prompts for credentials, so set up an ssh key or a credential helper. Run once without `--offline` to fill the cache.

## A source overlaps an output folder

You see `x source "kit" (./.claude) overlaps the claude output directory .claude/; move the sources (for example ./agent-kit) and declare that`.

An in-repo source sits inside, or contains, a folder palm writes to.
The same holds when an output folder is a symlink into a source, such as `.claude/skills -> ../skill`.

Move the files into a folder of their own, such as `./agent-kit`, and declare that folder instead.
For a symlinked output folder, replace the link with a real folder, and let palm write the copies there.
palm refuses on real paths, at listing and at install, so a symlink does not get around it.

## A hook names a missing script

You see `x hook do-stop-guard from agency: cannot relocate "./scripts/do-stop-guard.sh"`, with the folder palm searched.

The hook command names a file that is not in the source, or uses `$(...)` or `~/...`.

Tell the source's author. palm never merges a command it cannot resolve, so the rest of the source still installs.

## Hidden Unicode refusal

You see `hidden Unicode U+202E (right-to-left override) in SKILL.md, line 6`.

A file of the entity holds bidirectional overrides, isolates or tag characters, which can hide text from a reviewer.

Read the file in the source and tell its author. There is no override. Fork the source and remove the character if you need the entity now.

## A variable is not set

You see a warning from `palm check` or an install that names an MCP server and the variables it needs, such as `DOCS_TOKEN`.

An MCP server references the variable, and your shell does not define it. palm prints one line per server.

Export it before you start the harness. It is a warning, so `palm check` still exits 0.

## Known limitations

- Gemini CLI and OpenCode placements follow those harnesses' documentation and source, and have not run against a live CLI in palm's tests.
- OpenCode has no declarative hooks, and Cursor has no user rules file. palm skips those and says so.
- GitHub Copilot hook matchers cannot hold arguments. palm skips such a hook for Copilot, with a note.
- On-request and manual rules install always-on in Claude Code and OpenCode until 0.3. palm prints a notice per rule.
- Commands install as skills. A harness without skill commands loses the `/name` call, and the note says so.
- An agent's `skills:` and `mcpServers:` are not installed with it. palm prints the command for them.
- Remote marketplace entries are not fetched. palm prints the command that declares each as a source.
- palm rewrites a JSON file it merges into with two-space indentation. Minimal edits are planned for 0.3.
- Per-person additions (`palm.local.yaml`) and per-package placement (`at:`) arrive in palm 0.3.
- palm 0.2 does not run on native Windows. Run it inside WSL, as [Installation](/palm/getting-started/install/#run-palm-inside-wsl) shows. Contributors who only use the harnesses need no palm.

## Report a bug

Open an issue at [github.com/PalionTech/palm/issues](https://github.com/PalionTech/palm/issues) with:

- `palm --version` and your OS.
- The command you ran, and its output with `PALM_DEBUG=1`.
- The output of `palm check --json`. It holds your source URLs and file paths, so remove anything private.

An unexpected error prints `this is a palm bug; report it with --json output`. Include that output too.
Report a security problem privately instead, as [Policies](/palm/reference/policies/#security) describes.

## Related

- [Exit codes and errors](/palm/reference/exit-codes/)
- [palm check](/palm/reference/cli/check/)
- [Environment variables](/palm/reference/environment/)
