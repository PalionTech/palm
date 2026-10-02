# Writing the palm docs

Rules for every page in `src/content/docs`. `npm run build` enforces the mechanical ones:
`scripts/check-copy.mjs` (words, dashes, headings), `starlight-links-validator` (links) and the
capture files (terminal output).

## Pages

- Three page types, one template each (below): concept, guide, reference. Explanation pages follow the concept template.
- Code or a command appears within the first 150 words.
- Headings: sentence case, six words or fewer, nothing below H3. Guide titles are tasks: "Pin a source to a tag".
  Product names keep their capitals; add a new one to `PROPER` in `scripts/check-copy.mjs`.
- Tables for anything enumerable: kinds, targets, flags, error codes.
- A new page gets a slug in `src/site-map.mjs`. Until it is written, it is a stub with `draft: true`, its one-line purpose and three planned bullets. Drafts show in `npm run dev` and are left out of the build.
- Links are absolute with the base and a trailing slash: `[Sources](/palm/concepts/sources/)`. Never link to a draft; the build fails on it.

## Sentences

- Plain language. Present tense, active voice, second person: "palm writes `.mcp.json`".
- One idea per sentence, 20 words or fewer. Paragraphs of four sentences or fewer.
- Name the mechanism and the number, never a feeling: "one lockfile entry per file", not "clean".
- State limitations plainly. Date every comparison.
- No em dashes: use a period or a comma. No exclamation marks. No emoji.

## Emphasis and formatting

- Bold only a term at its definition, or a UI label.
- No italics for stress, no capitals for stress.
- Anything typed or on disk goes in code: `palm.yaml`, `--target`, `~/.palm`.
- `palm` is always lowercase, even at the start of a sentence.
- Placeholders are `<angle-brackets>`, home paths use `~`, secrets are `${NAME}`, never values.
- Every file example has a title: ```` ```yaml title="palm.yaml" ````.

## Terminology

| Term | Use it for | Not |
| --- | --- | --- |
| harness | the program: Claude Code, Codex, GitHub Copilot, Cursor, Gemini CLI, OpenCode | "target" in prose about the tool |
| target | palm's identifier for a harness: `claude`, `codex`, `copilot`, `cursor`, `gemini`, `opencode`; flags and config values | "harness" for a flag value |
| source | where entities come from: a git repository, a folder in one, or a directory inside the project, declared in `palm.yaml` | "origin", "registry", "source repo" |
| entity | one installable item | "package", "resource" |
| kind | an entity's type: `skill`, `agent`, `instruction`, `hook`, `mcp`; `plugin` is a selector over a source's entities | "type"; `command` is not a kind |
| agent | introduce once per page as "agent (subagent)" | |
| scope | `project` or `global` (`-g`) | "level", "mode" |
| manifest | `palm.yaml` | "config" |
| lock | `palm.lock.yaml`; the CLI says "the lock" | "lock state" |
| generated file | every file palm writes; committed in a project | "output", "artifact" |
| consent | the hash-pinned yes a person gives before a hook or stdio MCP server lands; recorded as `trust:` in the lock | "approval", "permission" |
| install | what users do | "deploy" (internal only); "harness" as a verb |

"origin", "registry" and "capability" are not palm words. Use them only to describe another tool or palm 0.1.

## Banned words

leverage, seamless, robust, delve, empower, streamline, unleash, effortless, cutting-edge,
game-changer, supercharge, revolutionise, unlock, elevate, powerful, blazing, next-generation,
world-class, comprehensive, dive into, journey, landscape, "it's worth noting", "in order to",
magic, simply, just, easy.

## Terminal examples

- A command-only block has no prompt, so the copy button yields runnable text. Keep examples few.
- A block with output comes from a real run. Never type output by hand, and never edit a capture.
- To add one: add a spec to `scripts/capture-specs.mjs`, build the CLI (`npm run build` at the
  repository root), run `npm run capture`, then use `<Capture name="..." />` in an `.mdx` page.
  `<CaptureTree name="..." />` shows the files the capture created.
- Captures run in a throwaway home; paths print as `~`. Sources are built from `test/fixtures` and
  served as `https://github.com/<owner>/<repo>`, so `palm install mattpocock/skills tdd` works as
  written. Rerun `npm run capture` before each release; `npm run capture:check` fails when one is
  stale.

## Admonitions

At most one per screen: `note` for context, `tip` for a shortcut, `caution` for security or data
loss (hooks, `--force`, `--secrets literal`). A step needed to finish the task never goes in an aside.

## Templates

Concept (also for explanation pages):

~~~md
---
title: <Noun phrase>
description: <One sentence: what it is.>
---

A **<term>** is <definition in one sentence>. <Why it matters, one sentence.>

```sh
<the smallest command that shows it>
```

<What that command did, two sentences.>

## <Detail, one per section>

## Related

- [<Page>](/palm/<section>/<slug>/)
~~~

Guide:

~~~md
---
title: <Task, as an imperative>
description: <The finished result, one sentence.>
---

import { Steps } from '@astrojs/starlight/components';

<The finished result: a capture or a file tree.>

## Before you start

- <Requirement>

## Steps

<Steps>
1. <Action>

   ```sh
   <command>
   ```
</Steps>

## Check the result

## Next steps
~~~

Reference:

~~~md
---
title: <Name of the thing>
description: <What this page lists.>
---

<One sentence.>

```sh
<synopsis>
```

| <Key or command> | <Meaning> |
| --- | --- |

## <Details, one section per group>
~~~
