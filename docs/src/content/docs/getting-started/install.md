---
title: Installation
description: Install palm with npm, check that it works, upgrade it from 0.1 and remove it.
---

palm is a Node.js command-line tool published to npm as `@paliontech/palm`.
The package installs one command, `palm`.

```sh
npm install -g @paliontech/palm
palm --version
```

The first command installs palm for your user. The second prints the installed version.

## Requirements

| Requirement | Why |
| --- | --- |
| Node.js 22 or later | palm declares Node 22 as its minimum in `package.json`. |
| git | palm fetches every source with the `git` on your `PATH`. |
| macOS or Linux | palm is tested on both. Windows is not supported yet. |

Private repositories need the git credentials you already use, such as an SSH key or a credential helper.
palm never prompts for a password, so a missing credential fails with a hint instead of hanging.

## Other package managers

```sh
pnpm add -g @paliontech/palm
bun add -g @paliontech/palm
```

To try palm without installing it, run it through `npx`.

```sh
npx @paliontech/palm --help
```

## Check the installation

`palm --help` lists the eight verbs on one screen.
Inside a project that already uses palm, `palm check` runs every consistency check and changes nothing.

```sh
palm --help
palm check
```

## Shell completion

`palm completion` prints a completion script for bash, zsh or fish.

```sh
echo 'source <(palm completion zsh)' >> ~/.zshrc
```

Replace `zsh` with `bash` and `~/.zshrc` with `~/.bashrc` for bash.
For fish, write the script to `~/.config/fish/completions/palm.fish`.

## Upgrade

```sh
npm install -g @paliontech/palm@latest
```

palm does not check for updates and never updates itself.
A newer palm may render an entity differently. The next `palm install` then reports it as `~ re-rendered`, and `palm check` fails until you commit the result.
For that reason, pin the exact version in CI, such as `npm install -g @paliontech/palm@0.2.0`, and upgrade it in a pull request of its own.

### From palm 0.1

palm 0.2 reads a new `palm.yaml` format and version 3 of `palm.lock.yaml`.
Every command except `palm migrate` stops on the old files and names that command.

```sh
palm migrate --dry-run
palm migrate
```

[Migrate from palm 0.1](/palm/guides/migrate-from-0-1/) walks through it, including the global scope.
`palm migrate` ships with 0.2 only, so run it before you upgrade to 0.3.

## Uninstall

```sh
npm uninstall -g @paliontech/palm
```

This removes the command only.
Files palm generated in your projects are committed there and stay, and they keep working without palm.
Run `palm get` in a project, and `palm get -g`, to see what palm installed before you remove it.

palm keeps its own state in `~/.palm`.

| Path | Holds |
| --- | --- |
| `palm.yaml`, `palm.lock.yaml` | The global scope's manifest and lock. You may keep these in a dotfiles repository. |
| `applied.yaml` | What the global scope wrote on this machine, with real paths. |
| `assets/` | Scripts that global hooks and MCP servers run. |
| `kit/` | The in-repo source `palm create -g` writes to. You may keep it in a dotfiles repository too. |
| `cache/` | Checkouts and indexes. Safe to delete. |

Delete `~/.palm` to remove that state.

## Related

- [Quick start](/palm/getting-started/quick-start/)
- [Environment variables](/palm/reference/environment/)
- [Security model](/palm/explanation/security/)
