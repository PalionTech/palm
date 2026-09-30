---
title: Layout descriptor
description: Tell palm where a source keeps its entities when auto-detection does not fit, with a layout key on the source in palm.yaml.
---

A **layout descriptor** tells palm where a source keeps its entities.
When it names at least one kind, palm skips auto-detection and reads only the globs you give it.

```yaml title="palm.yaml"
sources:
  openai/skills:
    ref: main
    layout: { skills: ["skills/.curated/*"] }
    skills: [gh-address-comments]
```

`openai/skills` keeps curated, experimental and system skills side by side.
This descriptor indexes only the curated ones.
palm records the layout in the lock, so every machine builds the same index from the same commit.

You can write it from the command line when you first declare the source.

```sh
palm install openai/skills gh-address-comments --layout 'skills=skills/.curated/*'
```

`--layout <kind>=<glob>` is repeatable, and palm writes each glob under `layout:` in `palm.yaml`.
Quote the glob, so your shell does not expand it.

## Keys

| Key | Type | Matches |
| --- | --- | --- |
| `skills` | glob or list | folders that contain a `SKILL.md`, or the `SKILL.md` files themselves |
| `agents` | glob or list | agent files |
| `commands` | glob or list | command and prompt files, indexed as skills |
| `instructions` | glob or list | instruction and rule files |
| `hooks` | glob or list | `hooks.json` files |
| `mcp` | glob or list | JSON files with a `mcpServers` object, whatever their name, such as `.mcp.json` or `servers/mcp.json` |
| `exclude` | list | paths to skip in every scan; a folder excludes everything below it |
| `include` | list | entity names to keep; everything else is dropped from the index |
| `nameFrom` | `frontmatter` or `dirname` | where a skill's name comes from; the default is `frontmatter` |

A kind you leave out is not indexed for that source.
A descriptor with only `exclude`, `include` or `nameFrom` keeps auto-detection and adjusts it.

## Glob rules

- Globs are relative to the source root, which is the `root:` folder when you set one.
- `*` matches within one path segment and `**` matches across segments.
- Dot folders match. `skills/.curated/*` works as written.
- palm skips only `.git`, `node_modules` and your `exclude` globs. The ignore list of [auto-detection](/palm/reference/scan-rules/#what-palm-ignores) does not apply.
- A glob never matches anything outside the source.
- A glob that matches nothing prints a warning, so a typo does not empty a kind in silence.

## More examples

```yaml title="palm.yaml"
sources:
  acme-kit:
    url: https://gitlab.acme.com/platform/agent-kit.git
    layout:
      agents: [catalog/people/*.md]
      skills: [catalog/skills/*]
      exclude: [catalog/tests]
    agents: [reviewer]
  acme/skills:
    layout: { nameFrom: dirname }
    skills: [lint-fix]
```

## When to write one

- The repository keeps entities in folders palm skips, such as `templates/` or `examples/`.
- You want part of a repository, such as only its curated skills.
- Skill names in frontmatter clash, and folder names are unique.

Otherwise, let auto-detection read the repository as published.
When auto-detection misses agent-, hook- or MCP-shaped files, the listing says so and names the `layout:` that indexes them.
There is no author-side palm file. The descriptor is always the consumer's choice, in the consumer's `palm.yaml`.

## Related

- [Scan rules](/palm/reference/scan-rules/)
- [Scanning](/palm/concepts/scanning/)
- [palm.yaml reference](/palm/reference/palm-yaml/)
