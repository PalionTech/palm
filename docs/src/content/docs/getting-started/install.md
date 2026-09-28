---
title: Installation
description: Install palm with npm, check that it works, upgrade it and remove it.
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
| git | palm clones and fetches every origin with the `git` on your `PATH`. |
| macOS or Linux | palm is tested on both. Windows is untested and not supported yet. |

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

```sh
palm doctor
```

`palm doctor` checks git and Node, palm's home directory, which harnesses it detects, lockfile drift and whether your origins are reachable.
Add `--offline` to skip the network check.
It exits with 1 when a check fails.

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
After an upgrade, the next `palm install` may rewrite some files, when the new version renders an entity differently.
The lockfile records that version per entry as `transform`.

## Uninstall

```sh
npm uninstall -g @paliontech/palm
```

This removes the command only.
Files palm installed into your projects and your home directory stay.
Run `palm get` in each project, and `palm get -g`, and uninstall what you no longer want before you remove palm.

palm keeps its own state in `~/.palm`: the global config, the global manifest and lockfile, the origin cache and the `mine` origin.
Delete that directory to remove it.

## Related

- [Quick start](/palm/getting-started/quick-start/)
- [Security model](/palm/explanation/security/)
