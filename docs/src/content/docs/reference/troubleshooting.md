---
title: Troubleshooting
description: From a message palm prints to its cause and its fix.
---

Each section starts with the message palm prints, then names the cause and the fix.
Start with `palm doctor`: it checks git, Node, harness detection, drift, hook scripts and origins.

```sh
palm doctor
palm install --dry-run
```

| Symptom | Section |
| --- | --- |
| `"tdd" matches 2 entities` | [Several origins have the name](#several-origins-have-the-name) |
| `input needed but no interactive terminal` | [No terminal to ask](#no-terminal-to-ask) |
| `No coding harness detected in this project` | [No target set](#no-target-set) |
| `refusing to overwrite <file>` | [A file is in the way](#a-file-is-in-the-way) |
| `changed since palm installed it; not overwriting` | [You changed an installed file](#you-changed-an-installed-file) |
| `do not match (--frozen)` | [`--frozen` fails in CI](#--frozen-fails-in-ci) |
| `Cannot fetch origin`, `did not answer in time` | [An origin is unreachable](#an-origin-is-unreachable) |
| `Origin alias "<alias>" is already used` | [Two origins want one alias](#two-origins-want-one-alias) |
| `the home directory is not a project` | [palm refuses your home directory](#palm-refuses-your-home-directory) |
| `restore hook assets after a fresh clone` | [Hook scripts missing after a clone](#hook-scripts-missing-after-a-clone) |
| `contains hidden Unicode` | [Hidden Unicode refusal](#hidden-unicode-refusal) |
| `Codex does not expand environment variables` | [Codex keeps a placeholder](#codex-keeps-a-placeholder) |

## Several origins have the name

- Symptom: `x "tdd" matches 2 entities`, followed by `use name@origin: tdd@mattpocock, tdd@pstack`.
- Cause: more than one origin offers the name, and there is no terminal for the picker.
- Fix: name the origin, as in `palm install skill tdd@mattpocock`. `palm search skill tdd` lists the candidates.

## No terminal to ask

- Symptom: `input needed but no interactive terminal`, a consent refusal that ends in `without your consent`, or `palm update changes installed files and needs a confirmation`.
- Cause: palm needs an answer, and stdin or stdout is not a terminal, or `CI` is set.
- Fix: answer up front. Pass `--yes` for consent and confirmations, `--target` for targets, and `name@origin` for ambiguous names. Export the variable a secret prompt asks for.

## No target set

- Symptom: `x No coding harness detected in this project`.
- Cause: `palm.yaml` has no `targets:`, `config.yaml` has none, palm detects no harness folder, and there is no terminal for the prompt.
- Fix: run `palm init --target claude,codex` once and commit `palm.yaml`, or pass `--target` to the install.

## A file is in the way

- Symptom: `x skill tdd@mattpocock → claude: refusing to overwrite .claude/skills/tdd/SKILL.md`, with the hint `to overwrite it, run: palm install skill tdd@mattpocock --force`.
- Cause: the file exists and the lockfile does not list it, such as a copy you made by hand. For a shared file, palm's key holds a different value.
- Fix: compare the file with the entity. Move it aside, or install with `--force` to replace it and record it in the lockfile.

## You changed an installed file

- Symptom: `x skill tdd: .claude/skills/tdd/SKILL.md changed since palm installed it; not overwriting`. On uninstall: `x skill tdd@mattpocock: .claude/skills/tdd/SKILL.md modified since install; rerun with --force to remove`, and the skill stays installed.
- Cause: the file's hash differs from the one in `palm.lock.yaml`.
- Fix: to keep your edits, copy the file into your own origin with `palm create`. To drop them, repeat the command with `--force`.

## `--frozen` fails in CI

- Symptom: `x palm.yaml, palm.lock.yaml and the installed files do not match (--frozen):`, followed by one line per difference.
- Cause: `palm.yaml` changed without the lockfile, or the lockfile names a ref `palm.yaml` no longer allows. A committed harness file may also have changed, or an entry palm merged into `.mcp.json`, a settings file or `AGENTS.md` was removed or edited.
- Fix: run `palm install` without `--frozen` on your machine, review the result, and commit `palm.yaml` and `palm.lock.yaml` together.

## An origin is unreachable

- Symptom: `x Cannot fetch origin "<alias>"`, `The remote did not answer in time`, or `unreachable` in `palm doctor`.
- Cause: no network, a proxy git does not know about, a private repository without credentials, or a repository that moved.
- Fix: run `git ls-remote <url>` to see git's own error. palm never prompts for credentials, so set up an ssh key or a credential helper. `--offline` works from the cache.

## Two origins want one alias

- Symptom: `x Origin alias "pstack" is already used by …`, or `palm.yaml declares origin "pstack" as …, but your origin "pstack" is …`.
- Cause: the alias is taken, or a project origin and one of your own origins use one alias for two sources.
- Fix: pick another alias with `--alias`, or remove yours with `palm uninstall origin pstack` and add it again under a new alias.

## palm refuses your home directory

- Symptom: `x run inside a project or use -g: the home directory is not a project`.
- Cause: the current folder is your home directory, which has no `palm.yaml`, so project scope would write `.claude/` into it.
- Fix: change into a project folder, or install for yourself with `-g`.

## Hook scripts missing after a clone

- Symptom: `palm doctor` warns `missing .palm/hooks/<name>; run palm install to restore hook assets after a fresh clone`.
- Cause: palm copies hook scripts into `.palm/hooks/`, which is not committed. The hook entries in the harness config are.
- Fix: run `palm install`. It redeploys every entry whose files are missing.

## Hidden Unicode refusal

- Symptom: `x skill <name> contains hidden Unicode that can smuggle instructions`.
- Cause: a file of the entity holds bidirectional overrides or tag characters, which can hide text from a reviewer.
- Fix: read the file in the origin and tell its author. To install it anyway, pass `--force`, then remove the characters with `palm audit --strip`.

## Codex keeps a placeholder

- Symptom: the install summary says `Codex does not expand environment variables in args: ${TOKEN} is passed literally`.
- Cause: Codex expands no variables in an MCP server's command, arguments or URL.
- Fix: install with `--secrets literal` to write the value, or move the value into the server's `env`.

## Known limitations

- MCP servers inside plugins that point at `${CLAUDE_PLUGIN_ROOT}` reference files palm does not copy. palm copies hook scripts only.
- Codex has no project prompts, Copilot has no user prompt files, and Cursor has no user rules. palm skips those and says so.
- When two plugins in one origin ship the same name, palm indexes the first and warns.
- palm reports marketplace entries with a remote source and does not fetch them. Add them with `palm install origin`.
- The Gemini CLI and OpenCode targets follow those harnesses' documentation and source. Neither has been tested against a running CLI.
- Windows is untested.

## Report a bug

Open an issue at [github.com/PalionTech/palm/issues](https://github.com/PalionTech/palm/issues) with:

- `palm --version` and your OS.
- The command you ran and its output with `--verbose`.
- The output of `palm doctor --json`. It holds your palm home, cache size, detected harnesses, drift and origin URLs, so remove anything private.

Report a security problem privately instead, as [Policies](/palm/reference/policies/#security) describes.

## Related

- [Exit codes and errors](/palm/reference/exit-codes/)
- [`palm doctor`](/palm/reference/cli/doctor/)
- [Environment variables](/palm/reference/environment/)
