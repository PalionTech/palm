# palm 1.0 production plan

Boiled down from six research reports (APM product surface, APM engineering
practices, APM's 1,351-issue bug history, competing tools, a code-quality review
of palm, docs/brand/publishing research). Rule for inclusion: it must prevent a
class of real bugs, make palm usable by a team, or be expected of a published
tool. Everything else is listed under "Not doing" with the reason.

## 0. Decisions

| Topic | Decision | Why |
|---|---|---|
| Package | `@paliontech/palm`, binary `palm` | unscoped `palm` is taken; `palm-cli` collides with Palmetto's archived tool; the audience already installs scoped CLIs |
| License | MIT | same as APM, pnpm, Bun, Vitest |
| Lint/format | Biome (format + lint, cognitive complexity ≤ 15, no nested ternary, layer boundaries via restricted imports) + `knip` + a 40-line AST script that fails on functions over 60 lines or with more than 4 parameters | one fast tool; the shape rules are what enforce small functions |
| Build | tsdown (tsup is unmaintained), code splitting on so `--help` loads only commander | startup 60 ms → ~25 ms |
| Tests | vitest + `@vitest/coverage-v8` thresholds, `fast-check` property tests, golden renders, CLI snapshots on `dist` | the categories the review found missing |
| Versioning | Changesets, 0.x semver, Keep-a-Changelog entries per PR | APM's changelog discipline without its manual process |
| Publishing | npm trusted publishing (OIDC) from `release.yml`, provenance on, no tokens | the 2026 standard; APM does the same on PyPI |
| Docs | Astro Starlight in `docs/`, GitHub Pages, Pagefind, `llms.txt`; the splash page is the landing page | one site, markdown-first, agents can maintain it |
| Telemetry | none, and no update check; the docs list every network call palm makes | simpler than APM's un-disableable daily check |
| Platforms | macOS and Linux; Windows untested and stated as such | APM spent 27 issues on Windows; not worth it before 1.0 |
| Targets | claude, codex, copilot, cursor, plus gemini (Gemini CLI) and opencode for 1.0 | competitors cover far more harnesses; both formats are researched; each target is one strategy file after the refactor |
| CLI grammar | kubectl-style `palm <verb> <kind> [names]` for every kind, including `origin` and `target` | one grammar instead of two; no special guards for `install origin`; short kind names like kubectl's `po` |
| Repo | public `PalionTech/palm`, docs on GitHub Pages | created 2026-09-28 |

## 0b. CLI grammar (kubectl model)

Verbs, with aliases, apply to every kind:

| Verb | Aliases | Kinds |
|---|---|---|
| `install` | `add`, `i` | skill, agent, instruction, command, hook, mcp, plugin, origin |
| `uninstall` | `remove`, `rm`, `delete` | same |
| `get` | `list`, `ls` | same plus `target`, `all` |
| `describe` | `info` | one item of any kind |
| `update` | `up` | installed entities; `origins` refreshes indexes |
| `create` | `new` | skill, agent, instruction, command (authoring wizard) |
| `search` | | entities across origins and the MCP registry |

Kinds accept singular, plural and short names: `sk`, `ag`, `ins`, `cmd`, `hk`,
`mcp`, `pl`, `orig`, `tg`. `install origin <spec>` fetches and indexes before it
persists anything (today a typo like `anthropic/skills` is saved although the
clone fails). `install origin <marketplace.json>` replaces `origin import`.
Utilities stay top level: `init`, `doctor`, `config`, `completion`, `cache`,
`audit`, `why`, `find`. The old `palm origin <sub>` group remains as hidden
aliases. `-o/--origin` stays the origin filter; `--json` stays the output switch.
This workstream runs after wave 1 and before wave 3, so the command layer is
rebuilt once.

## 1. Code quality (no behaviour change, no on-disk format change)

**Status: waves 0–3 done (2026-09-29).** Final numbers after the cleanup pass: 1841
tests green (102 files); lint 0 findings and 0 suppressions in src, test and scripts; function shape 0;
knip 0 (a hard gate in `npm run verify`); `palm --help` 26 ms median of 10 (bare node 18 ms); src 24,267 lines of TypeScript, test 20,663 (fixtures excluded). The lint baseline holds only docs-owned findings in docs/scripts (5 complexity, 2 suppressions).
The sections below record what each wave set out to do and the baselines it started from.

Target layout: `src/lib` (fs, object, placeholders, names, frontmatter, yaml:
no palm concepts), `src/domain` (dep-ref, entity-key, lock, manifest,
scope-paths, origin, origin-set, merged-record), `src/core` shrinks to
config-file, git, cache, hash, kinds, errors, types; `src/index`, `src/targets`,
`src/mcp`, `src/engine`, `src/commands`, `src/ui`, `src/create` as today.

Wave 0, tooling (done 2026-09-28): Biome, knip, function-shape script, tsdown,
coverage, fast-check, hermetic vitest setup (temp HOME and harness dirs, git config
isolated, tokens stripped, `fetch` blocked unless injected), CLI tests run against
`dist` built once. A ratchet: the lint baseline may only shrink. `npm run verify`
runs lint, typecheck, shape check, tests and build. Baselines at the end of wave 0
(every later wave lowers them in the same commit that fixes findings:
`npm run lint:baseline`, `node scripts/check-shape.mjs --update`):

- Lint (`scripts/lint-baseline.json`, 330 findings): cognitive complexity > 15: 80,
  non-null assertions (src): 57, literal keys: 56, `console` outside src/ui: 54,
  template literals: 40, nested ternaries: 16, control characters in regex: 7,
  implicit-any `let`: 5, optional chain: 4, 9 other rules with 11 findings. Four known layer
  violations are suppressed with `biome-ignore` and counted: core/cache → index/scan
  (wave 2/3 injects the scanner), index/mcp and targets/mcp-config → mcp/secrets
  (wave 1 moves the `${VAR}` grammar to src/lib), cli.ts → core/errors (wave 3 output
  writer).
- Function shape (`scripts/shape-baseline.json`): 50 violations in 48 functions
  (32 bodies > 60 lines after formatting to 100 columns, 16 with > 4 parameters,
  2 nested deeper than 4).
- knip (`scripts/knip-baseline.txt`, deleted once it reached 0): 1 unused file, 83 unused exports, 12 unused
  exported types.
- Coverage (v8, thresholds = measured − 3): lines 80.3 %, functions 90.4 %,
  branches 86.9 %. src/commands shows 27 % because CLI tests run `dist` in a
  subprocess.
- Startup (`node dist/cli.js --help`): 65 ms → 57 ms with code splitting. `--help`
  still loads execa (commands/doctor.ts), yaml (commands/install.ts → core/manifest)
  and clack (commands/shared.ts → ui/prompts) through static imports, about 29 ms of
  the remainder; making those three imports lazy belongs to the command-layer
  rebuild (§0b) and reaches the ~25 ms target.

Wave 1 (done), `src/lib`: one home for `isRecord`/`deepEqual`/`withoutUndefined`,
atomic write and JSON/YAML readers, `isWithin` and empty-dir pruning, slug and
safe-name rules (the ad hoc MCP name check is currently weaker and allows `..`),
`${VAR}` token grammar, frontmatter parse/stringify. Five agents, disjoint files,
about 350 lines removed. Done; the cleanup pass then deleted the last facades
(core/manifest.ts, core/lockfile.ts, the core/config.ts and core/paths.ts wrappers, the unused
`src/engine/index.ts`), cleared every knip finding and made `npm run knip` a hard gate.

Wave 2 (done), `src/domain`: `DepRef` (one grammar instead of two), `EntityKey`/`LockKey`
(replaces seven inline `kind\0name` keys with inconsistent casing), `Lock` as a
first-class collection (find, upsert, remove, dependents, protected files),
`ScopePaths` (manifest/lock/hook-asset paths, abs/rel, containment), `Origin` and
`OriginSet` (splits the 689-line config.ts), `MergedRecord` as a tagged union
(parsed from the existing pointer strings, so the lock format is unchanged).

Wave 3 (done), decomposition: the twenty largest functions split into pure planning
and I/O execution, starting with `deployItem` (162 lines, cyclomatic 87),
`registerOrigin`, `renderCodexTable`, `renderAgent`, `importMarketplace`,
`uninstallEntities`, `parseMarketplace`, `fetchOrigin`, `updateEntities`,
`Scanner.scanPlugin`. Scanner gets a directory-indexed file index (O(1) lookups
instead of per-plugin linear scans). One output writer so `--json` can never
leak text to stdout.

## 2. Correctness, security and team use

Ordered by the number of real APM bugs each item prevents.

1. Git runs with a clean environment (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_*` dropped), `BatchMode=yes` for SSH, timeouts on every git call.
2. Lockfile replay: bare `palm install` deploys the locked commit, not the latest tag, and restores missing files and merged fragments (MCP keys, hook entries, instruction blocks); `--frozen` fails on any manifest/lock mismatch, edited file or missing/changed merged fragment; an alias missing from the machine's config is recreated from the URL in the lock.
3. Machine-independent projects: the first project install that places something persists `targets:` to `palm.yaml` (a failed or ambiguous run saves nothing); afterwards only `palm init --target` changes it, and a per-install `--target` applies to that install (adds targets to the entities it names, never contracts). Global scope saves `targets` to config.yaml only through `palm config set targets`, never detection. The lock records the persisted set it was synced against, so a bare install contracts only targets that left it. Project-declared origins never shadow user aliases (same alias must mean the same URL), are ignored under `-g`, and local-path origins must live inside the project.
4. Failures are never exit 0: a failed target, origin refresh or file removal is recorded and exits 1 with the partial state in the lock.
5. Lockfile v2: per-file content hashes (edit-safe: palm refuses to overwrite or delete a file the user changed unless `--force`), a `transform` version per entry (a palm upgrade re-renders instead of going stale or mass-deleting), no timestamps (no merge churn), CRLF-normalised hashes for text files.
6. Target contraction: shrinking `targets:` removes the dropped harness's files on the next install.
7. Writes preserve symlinked dotfiles (write through the link, never rename over it).
8. Portable project hooks: no absolute paths in committed configs for any harness; `palm doctor` flags missing `.palm/hooks` after a fresh clone and `palm install` restores them.
9. Concurrency: an advisory lock on `$PALM_HOME` and per-checkout locks; two aliases of one repo share one checkout per ref; index and checkout metadata written atomically.
10. Transactions: merged JSON/TOML edits roll back on failure, the previous install is removed only after the new one succeeded, lock/manifest persist in `finally`, SIGINT is handled.
11. Hidden-Unicode scan before deploy (bidi overrides, tag characters, variation selectors: refuse; zero-width: warn) and `palm audit [--strip]`.
12. Executable consent: an interactive install lists every hook (event + command) and stdio MCP server (command) it is about to write and asks once; non-interactive runs need `--yes`. Text entities are never gated.
13. `cwd == $HOME` without a project marker is refused ("run inside a project or use -g").
14. Scoped MCP names (`@a/mcp` and `@b/mcp`) stay distinct; transport changes leave no stale keys.

## 3. Usability

- `palm update` prints a plan (`~ updated`, `+ added`, `- removed`, `= unchanged`, files at risk) and asks y/N; `--yes` for scripts. `palm outdated` shows current / wanted / latest per entry. Semver ranges in refs (`#^1.2`) resolve against origin tags.
- `palm why <name>` (who pulled it in) and `palm find <path>` (which entity wrote a file).
- One output contract: symbols `+ x ! i`, warnings grouped at the end, exit codes 0 ok / 1 failure / 2 usage / 130 cancelled, `--json` on stdout with logs on stderr, `NO_COLOR` and `--no-color` honoured everywhere.
- `palm completion bash|zsh|fish` generated from the command tree.
- `palm cache info|clean`.
- Help text with examples on every command; every hint names the command to run.

## 4. Release engineering

LICENSE, full `package.json` metadata, `.editorconfig`, `.gitattributes`,
`.nvmrc`; `ci.yml` (ubuntu + macOS × Node 22/24: biome, tsc, vitest with
coverage, build, `npm pack` and smoke-run the packed CLI, publint, knip,
changeset status); `e2e.yml` nightly against the packed tarball; `codeql.yml`
and dependency review; actions pinned by SHA with least privilege; Dependabot
grouped weekly; `release.yml` with Changesets and trusted publishing; CONTRIBUTING,
CODE_OF_CONDUCT, SECURITY (private vulnerability reporting, scope stated),
SUPPORT, issue forms (bug form asks for `palm doctor --json`), PR template,
CODEOWNERS, `.github/release.yml` categories, about 15 labels; a deprecation
helper (`[deprecated]` help prefix, hidden alias, warning naming the replacement).

## 5. Documentation

Starlight site, about 45 pages, per the researched site map: Getting started
(3), Concepts (8), Guides (11 use cases, each opening with the finished result),
Reference (CLI overview, one page per command, file formats, layout descriptor,
targets matrix, scan rules, exit codes, environment, troubleshooting, policies,
glossary), Explanation (why origins, why native files, security model,
comparison). Rules: example within the first 150 words, sentence-case headings,
present tense and second person, terminology fixed (harness vs target, origin,
entity, scope), banned-word list, terminal output captured from real runs by a
script (never invented), a test that every documented command exists, `llms.txt`.

## 6. Brand and landing page

Mark: a fan-palm frond with identical leaflets from one stem (one origin, every
harness), monochrome-capable, legible at 16 px; wordmark `palm` in JetBrains
Mono; frond green `#12876A` on ink `#10231E`. The Starlight splash page is the
landing page: headline, subheadline naming what it replaces, install line above
the fold, a real terminal beside a file tree of what changed, four tiles that
each name a mechanism, use-case cards, the targets matrix, a dated comparison
table, trust line (tested against named public repos, MIT, no telemetry,
provenance).

## 6b. Launch status

Done on 2026-09-29: rulesets active on `main` and `v*` tags, the org and repo allow
Actions to open pull requests, npm org `paliontech` created with two-factor auth,
`@paliontech/palm@0.1.0` published, trusted publishing linked to `release.yml`
(environment `npm`), package set to require two-factor auth and disallow bypass
tokens. Later releases: merge a pull request with a changeset, then merge the
"Version Packages" pull request the release workflow opens.

## 7. Launch order

1. Phase 1 waves 0–3, each gated on green tests and the lint ratchet (done).
2. Phase 2 and 3 features in parallel workstreams with disjoint ownership.
3. Release engineering files and workflows.
4. Docs site and landing page; brand assets.
5. Public repo `PalionTech/palm`, CI green, Pages deployed.
6. `0.1.0` published by hand once (required before trusted publishing can be linked), then trusted publishing enabled.

## Not doing (and why)

- Org policy, lifecycle scripts, rulesets, REST registries, `pack`/`publish`, SBOM export: enterprise governance and package authoring; palm installs repos as they are.
- `compile` / distributed AGENTS.md: palm writes native files and one managed block; compiling instructions into every directory is a different product.
- `run`/`preview`/`runtime`: off-mission.
- Windows: stated unsupported until someone maintains it; paths already use `path.join`.
- Update notifier and self-update: npm handles upgrades; no background network calls.
- A central registry: origins are git repositories the user chose; no index to squat.
- Per-entry `targets:` and `init --discover`: useful later, not needed for 1.0.
