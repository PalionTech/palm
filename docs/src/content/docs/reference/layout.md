---
title: Layout descriptor
description: Tell palm where a repository keeps its entities when auto-detection does not fit.
---

A **layout descriptor** tells palm where an origin keeps its entities.
When it names at least one kind, palm skips auto-detection and reads only the globs you give it.

```sh
palm origin add openai/skills --alias openai-curated --layout 'skills=skills/.curated/*'
```

palm stores the descriptor with the origin in `~/.palm/config.yaml`:

```yaml title="~/.palm/config.yaml"
origins:
  - alias: openai-curated
    type: git
    url: https://github.com/openai/skills.git
    layout:
      skills: ["skills/.curated/*"]
```

`openai/skills` keeps curated, experimental and system skills side by side.
The descriptor indexes only the curated ones.

## Keys

| Key | Type | Matches |
| --- | --- | --- |
| `skills` | glob or list | folders that contain a `SKILL.md`, or the `SKILL.md` files themselves |
| `agents` | glob or list | agent files |
| `commands` | glob or list | command and prompt files |
| `instructions` | glob or list | instruction and rule files |
| `hooks` | glob or list | `hooks.json` files |
| `mcp` | glob or list | `.mcp.json` or `mcp.json` files |
| `exclude` | list | paths to skip in every scan; a folder excludes everything below it |
| `include` | list | entity names to keep; everything else is dropped from the index |
| `nameFrom` | `frontmatter` or `dirname` | where a skill's name comes from; the default is `frontmatter` |

A kind you leave out is not indexed for that origin.
A descriptor with only `exclude`, `include` or `nameFrom` keeps auto-detection and adjusts it.

## Glob rules

- Globs are relative to the origin root, which is the `--root` folder when you set one.
- `*` matches within one path segment and `**` matches across segments.
- Dot folders match: `skills/.curated/*` works as written.
- palm skips only `.git`, `node_modules` and your `exclude` globs. The ignore list of [auto-detection](/palm/reference/scan-rules/#what-palm-ignores) does not apply.
- palm does not follow symlinks while it matches a descriptor.

## On the command line

`--layout` takes `key=value` and repeats:

```sh
palm origin add acme/agents --layout 'agents=catalog/people/*.md' --layout 'skills=catalog/skills/*' --layout 'exclude=catalog/tests'
palm origin add acme/skills --layout 'nameFrom=dirname'
```

A descriptor also works for a project origin in `palm.yaml`, under the same `layout` key.

## When to write one

- The repository keeps entities in folders palm ignores, such as `templates/` or `examples/`.
- You want part of a repository, such as only its curated skills.
- Skill names in frontmatter clash, and folder names are unique.

Otherwise, let auto-detection read the repository as published.

## Related

- [Scan rules](/palm/reference/scan-rules/)
- [Origins](/palm/concepts/origins/)
