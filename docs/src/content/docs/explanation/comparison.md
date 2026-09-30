---
title: palm compared
description: palm 0.2 next to Microsoft APM, the Vercel skills CLI, the harnesses' own plugin managers and copying by hand. Other tools checked on 2026-09-28.
---

Several tools install files for coding agents.
This page compares palm with the tools people ask about most, for one job.
That job is installing agent files for several harnesses and sharing the setup with a team.

```sh
palm install mattpocock/skills tdd
palm check
```

The first command installs a skill for every harness in `palm.yaml`.
The second is what CI runs to prove that every clone holds the same files.

## Sources and date

The other tools were checked on 2026-09-28. palm's column describes 0.2.

| Tool | Checked against |
| --- | --- |
| Microsoft APM 0.32.0 | its documentation source at the 0.32 release and its command definitions |
| Vercel `skills` 1.7.0 | its source on GitHub and its README |
| `claude plugin` | the Claude Code plugin and MCP documentation |
| `codex plugin`, `gemini extensions` | the Codex and Gemini CLI documentation and source |

"Unverified" marks a cell we could not confirm from those sources.
None of the other tools was run for this page.

## What each tool installs

<div class="palm-wide">

| Tool | Kinds covered | Harnesses | How you name what to install | Layout auto-detect | Project and global |
| --- | --- | --- | --- | --- | --- |
| palm 0.2 | skills, agents, instructions, hooks, MCP servers; plugins as selectors; commands as skills | 6, two of them unverified | `owner/repo` and entity names; no registry | Yes, five rules, or a layout descriptor you write | Yes, `-g` on every command |
| APM 0.32 | all 7, plus LSP servers and binaries | 13, plus 4 experimental | `name@marketplace` or a repository | 6 fixed layouts, no override | Yes |
| Vercel `skills` | skills | 79 | a source, or a pick from `skills find` | Yes, for skills | Yes |
| `claude plugin` | 6, no instructions | 1 | a name, unique within your marketplaces | No, it needs a `marketplace.json` | Yes, user, project, local and managed |
| `codex plugin`, `gemini extensions` | Codex 4, Gemini 7 | 1 each | Codex needs `@marketplace`; Gemini takes a URL or a path | Codex reads 3 manifest formats; Gemini needs one root manifest | Partly. Codex enables per project, Gemini installs per user. |
| Copying by hand | any | each one by hand | you find the file | You read each repository | Yes, by hand |

</div>

## How each tool keeps a setup repeatable

<div class="palm-wide">

| Tool | Reproducible setup | Hook consent | Secrets handling | Removal |
| --- | --- | --- | --- | --- |
| palm 0.2 | Generated files committed; a lock with the commit, one render hash per entry and target, and the file list; `palm check` in CI fails on drift | Every command and script shown before writing; default no; `--yes` never consents; your yes pinned by hash in the lock and replayed for teammates and CI | Environment references per harness; a literal from a source is never written; a literal in a tracked file fails `palm check` | Files by path and merged entries by identity; a pull delivers it to teammates |
| APM 0.32 | Commit, per-file hashes and semver ranges; `--frozen` for CI | `apm approve` and `apm deny`, off until a config declares `executables:`; a pending install still succeeds | Resolved values for Codex, Cursor and Gemini, including the project's `.cursor/mcp.json` | File hashes and ownership records; removal of hook entries is unverified |
| Vercel `skills` | `skills-lock.json` with a content hash; restore is experimental and follows a branch or tag | No hooks | No MCP servers | Unverified |
| `claude plugin` | Per-user state in `installed_plugins.json`; no version pin, nothing to commit | A trust warning; the details view shows that a hook exists, not what it runs | `${VAR}` references, and sensitive options in the keychain | Unverified |
| `codex plugin`, `gemini extensions` | No lockfile | Codex does not trust plugin hooks until you do; Gemini lists MCP commands and warns about hooks | Codex uses `env_vars`; Gemini keeps sensitive settings in the keychain | Unverified |
| Copying by hand | None | You read each hook | By hand | Nothing records what you copied |

</div>

## What palm does not do

- It does not run on native Windows. A maintainer on Windows runs it inside WSL; contributors need no palm.
- It needs Node 22. There is no single binary or Homebrew formula.
- It has no registry, no search and no install counts. Discovery happens on GitHub or in a README.
- It does not follow dependencies. An agent's skills and an APM package's `dependencies:` are listed with the command that installs them, never installed on their own.
- It skips LSP servers, binaries and OpenCode's JavaScript plugins. A Gemini CLI extension installs as loose members.
- It has no organization policy, lifecycle scripts or package publishing.
- It stores global secrets in files with mode `0600`, not in a keychain, and only outside git worktrees.
- It never updates entities or itself in the background.

## When the others fit better

Choose APM when you need a harness palm does not cover, native Windows, or packages that ship binaries.
APM also fits organizations that approve and block packages by policy, or that compile instructions into `AGENTS.md` files.
It installs through Homebrew, WinGet and Scoop.

Choose the Vercel skills CLI when you install only skills and want no setup.
`npx skills add` reaches 79 agents, and skills.sh ranks skills by installs and shows third-party security scores.

Choose a harness's own plugin manager when your team uses one harness and likes its catalog.
It needs no extra tool, and Claude Code updates official plugins on its own.
Claude Code and Gemini CLI keep secrets in the keychain, and Cursor reviews every marketplace plugin by hand before it lists it.

Copy files by hand when you want one file that you will edit and own.
Nothing is quicker for one file, but nothing records where it came from or tells you when it drifts.

## Related

- [Why native files per harness](/palm/explanation/why-native-files/)
- [Why sources live in each project](/palm/explanation/why-sources/)
- [Migrate from APM](/palm/guides/migrate-from-apm/)
