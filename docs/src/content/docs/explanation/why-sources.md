---
title: Why sources live in each project
description: palm declares every source in the project's palm.yaml, with no per-user registry and no central index, so a clone carries everything it needs.
sidebar:
  label: Why sources per project
---

palm has no registry and no per-user list of repositories.
Every source a project uses is declared in that project's `palm.yaml`, next to the entries taken from it.

```yaml title="palm.yaml"
sources:
  mattpocock/skills:
    ref: ^1.2
    skills: [tdd]
```

The key is the address, the `ref:` is the version intent, and the entries are what you took.
A teammate's clone has all three, so it needs no setup step before the first install.

## What palm 0.1 did

palm 0.1 registered repositories per user, in `~/.palm/config.yaml`, under aliases such as `mattpocock`.
Projects then wrote `tdd@mattpocock` in `palm.yaml`.
A study with twenty personas, each replaying real repositories, found the flaw fast.

- A teammate's clone lacked the alias the lock named, so a bare install failed or rewrote `palm.yaml`.
- Versions lived in two places, the registration's `ref:` and each entry's `#ref`, and they disagreed.
- Onboarding started with a registration command, a step nobody guessed.

## What per-project sources change

| Question | Answer in 0.2 |
| --- | --- |
| Where does this skill come from? | the key it sits under in `palm.yaml` |
| Which version? | the source's `ref:`, and the lock's commit |
| What does a newcomer run first? | nothing: the files are committed; `palm install <owner/repo> <names>` to add more |
| Can two projects use different versions? | yes, each declares its own `ref:` |
| Can a teammate's machine resolve it differently? | no: the lock holds the URL, root, layout and commit |

`owner/repo` is short enough to type, so aliases became optional.
The first `palm install <source> <names>` declares the source for you, and you never write the key by hand.

## Why no registry

A registry answers "which repository is `tdd`?" with a ranking someone else controls.
palm 0.1 shipped a client for the MCP registry, and the persona study measured the cost.
Searches timed out after ten seconds, ranked unrelated servers first, invented variable names and dropped headers.
A census of the registry counted 25,125 servers, hundreds of them unreachable.

palm 0.2 asks you for the repository instead.
The error for a bare name puts the fix on its first line, and a GitHub code search link finds the repository when you do not know it.
MCP servers come from a source, from the JSON snippet in their README, from flags or from `palm.yaml`, all without a lookup.

## What this costs

- You name the repository. `palm install tdd` does not work, and says so with the command that does.
- Discovery happens outside palm, on GitHub or in a README.
- A personal default that applies to every project needs `-g`, with its own `~/.palm/palm.yaml`.

In return, a project is self-contained, reviewable in one diff, and reproducible from its own files.

## Related

- [Sources](/palm/concepts/sources/)
- [Migrate from palm 0.1](/palm/guides/migrate-from-0-1/)
- [palm compared](/palm/explanation/comparison/)
