---
title: palm compared
description: palm next to Microsoft APM, the Vercel skills CLI, the harnesses' own plugin managers and copying by hand, checked on 2026-09-28.
---

Several tools install files for coding agents.
This page compares palm with the tools people ask about most, for one job.
That job is installing agent files for several harnesses and sharing the setup with a team.

```sh
palm install origin mattpocock/skills
palm install skill tdd --target claude,codex,cursor
palm install --frozen
```

The first two commands install a skill by name for three harnesses.
The third is what CI runs to check that every clone has the same files.

## Sources and date

Checked on 2026-09-28.

| Tool | Checked against |
| --- | --- |
| Microsoft APM 0.32.0 | its documentation source at the 0.32 release and its command definitions |
| Vercel `skills` 1.7.0 | its source on GitHub and its README |
| `claude plugin` | the Claude Code plugin and MCP documentation |
| `codex plugin`, `gemini extensions` | the Codex and Gemini CLI documentation and source |

"Unverified" marks a cell we could not confirm from those sources.
None of these tools was run for this page, except palm.

## What each tool installs

<div class="palm-wide">

| Tool | Kinds covered | Harnesses | Short-name install and picker | Layout auto-detect | Project and global |
| --- | --- | --- | --- | --- | --- |
| palm | all 7 | 6 | Yes. It searches every origin, with a picker in a terminal and `E_AMBIGUOUS` in a script. | Yes, four detection rules, or a layout descriptor you write | Yes, `-g` on every command |
| APM 0.32 | all 7, plus LSP servers and binaries | 13, plus 4 experimental | `name@marketplace`. An ambiguous name fails, with no picker. | 6 fixed layouts, no override | Yes |
| Vercel `skills` | skills | 79 | No. It needs a source, or a pick from `skills find`. | Yes, for skills | Yes |
| `claude plugin` | 6, no instructions | 1 | Unqualified when the name is unique. No picker. | No, it needs a `marketplace.json` | Yes, user, project, local and managed |
| `codex plugin`, `gemini extensions` | Codex 4, Gemini 7 | 1 each | No. Codex needs `@marketplace`, and Gemini takes a URL or a path. | Codex reads 3 manifest formats. Gemini needs one root manifest. | Partly. Codex enables per project, Gemini installs per user. |
| Copying by hand | any | each one by hand | No | You read each repository | Yes, by hand |

</div>

## How each tool keeps a setup repeatable

<div class="palm-wide">

| Tool | Lockfile and reproducible install | Hooks consent | Secrets handling | Agents pull dependencies | Exact removal |
| --- | --- | --- | --- | --- | --- |
| palm | Commit, per-file hashes and merged entries. `--frozen` for CI. | Lists every hook and stdio MCP command and asks once. Scripts pass `--yes`. | An environment reference per harness in project files. Values only in `0600` user files. | Yes, reference-counted on uninstall | Yes, files by hash and merged entries by JSON pointer |
| APM 0.32 | Commit, per-file hashes and semver ranges. `--frozen` for CI. | `apm approve` and `apm deny`, off until a config declares `executables:`. A pending install still succeeds. | Resolved values for Codex, Cursor and Gemini, including the project's `.cursor/mcp.json` | Declared by the package author in `apm.yml` | File hashes and ownership records. Removal of hook entries is unverified. |
| Vercel `skills` | `skills-lock.json` with a content hash. Restore is experimental and follows a branch or tag, not a commit. | No hooks | No MCP servers | No agents | Unverified |
| `claude plugin` | Per-user state in `installed_plugins.json`. No version pin, nothing to commit. | A trust warning. The details view shows that a hook exists, not what it runs. | `${VAR}` references, and sensitive options in the keychain | Plugins can depend on other plugins | Unverified |
| `codex plugin`, `gemini extensions` | No lockfile | Codex does not trust plugin hooks until you do. Gemini lists MCP commands and warns about hooks. | Codex uses `env_vars`, with no `${VAR}` syntax. Gemini keeps sensitive settings in the keychain. | Unverified | Unverified |
| Copying by hand | None | You read each hook | By hand | By hand | Nothing records what you copied |

</div>

## What palm does not do

- It does not run on Windows yet.
- It needs Node 22. There is no single binary or Homebrew formula.
- It has no central index or install counts. Discovery starts with the origins you add.
- It skips LSP servers, binaries and OpenCode's JavaScript plugins. A Gemini CLI extension installs as loose members.
- It has no organization policy, lifecycle scripts or package publishing.
- It stores global secrets in files with mode `0600`, not in a keychain.
- It never updates entities or itself in the background.

## When the others fit better

Choose APM when you need a harness palm does not cover, Windows, or packages that ship binaries.
APM also fits organizations that approve and block packages by policy, or that compile instructions into `AGENTS.md` files.
It installs through Homebrew, WinGet and Scoop.
Choose the Vercel skills CLI when you install only skills and want no setup.
`npx skills add` reaches 79 agents, and skills.sh ranks skills by installs and shows third-party security scores.

Choose a harness's own plugin manager when your team uses one harness and likes its catalog.
It needs no extra tool, and Claude Code updates official plugins on its own.
Claude Code and Gemini CLI keep secrets in the keychain.
Cursor reviews every marketplace plugin by hand before it lists it.
Copy files by hand when you want one file that you will edit and own.
Nothing is simpler, but nothing records what you copied or removes it for you.
