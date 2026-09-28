# Contributing to palm

Thanks for helping. This file covers how to set up a checkout, which checks a pull request has
to pass, and the few rules that keep palm's behaviour and docs in step. For questions, use
[GitHub Discussions](https://github.com/PalionTech/palm/discussions). For security problems,
follow [SECURITY.md](SECURITY.md) and do not open a public issue.

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Set up a checkout

You need Node.js 24 (the version in `.nvmrc`; Node 22 is also tested in CI), npm and git.
palm supports macOS and Linux; Windows is untested.

```sh
git clone https://github.com/PalionTech/palm.git
cd palm
npm ci
npm run verify
```

`npm run verify` runs, in order: `npm run lint`, `npm run typecheck`, `npm run check:shape`,
`npm test` and `npm run build`. CI runs the same steps on Ubuntu and macOS with Node 22 and 24,
plus coverage, a smoke test of the packed tarball, `publint` and `knip`. A separate docs job
checks that the terminal captures and CLI tables in the docs still match the built CLI, then
builds the site. If `verify` passes on your machine, CI almost always passes too.

Other commands you will use:

| Command | What it does |
|---|---|
| `npm run dev -- <args>` | runs the CLI from `src/` through tsx, for example `npm run dev -- list` |
| `npm run test:watch` | vitest in watch mode |
| `npm run test:coverage` | tests with v8 coverage; fails below the thresholds in `vitest.config.ts` |
| `npm run lint:fix` | applies Biome formatting and safe lint fixes |
| `npm run bench` | times the origin scanner on a synthetic origin of about 4,000 files; compare the numbers before and after a change to `src/index/` |
| `npm run knip` | reports unused files, exports and dependencies |
| `bash scripts/e2e.sh` | end-to-end run against real public repositories (needs network) |

## Test tiers

1. **Unit and integration tests** (`npm test`) live in `test/<module>/`, mirroring `src/`.
   They are hermetic: `test/support/setup.ts` gives every worker a temporary `HOME`, `PALM_HOME`
   and harness directories, disables global git config, strips tokens and blocks `fetch`.
   Origins are local fixture repositories under `test/fixtures/`. No test touches the network
   or your real home directory.
2. **Property tests** (`*.property.test.ts`) use fast-check for parsers and anything with a
   grammar.
3. **CLI tests** (`test/cli/`) spawn `node dist/cli.js`. A vitest global setup builds `dist/`
   once per run, so these tests see what users get.
4. **End-to-end** (`scripts/e2e.sh`) installs from real public repositories into a throwaway
   sandbox. It never touches your real `~/.palm`, `~/.claude` or other harness directories.
   CI runs it nightly against the packed tarball (`e2e.yml`). Run it before changing git
   handling, origin scanning or anything that writes harness files. Set `PALM_BIN=palm` to test
   an installed palm instead of building `dist/`.

A bug fix comes with a test that fails without the fix.

## Ratchets: lint and function shape

Two checks count findings per file or rule and compare them with a committed baseline. The
counts may only go down.

- **Lint** (`npm run lint`): formatting must be clean, and the number of Biome lint findings per
  rule, including `biome-ignore` suppressions, must not exceed `scripts/lint-baseline.json`.
- **Function shape** (`npm run check:shape`): per file, the number of functions longer than 60
  lines, with more than 4 parameters or nested deeper than 4 must not exceed
  `scripts/shape-baseline.json`. `node scripts/check-shape.mjs --list` shows each violation.

When your change removes findings, lower the baselines in the same pull request:

```sh
npm run lint:baseline                  # rewrites scripts/lint-baseline.json
node scripts/check-shape.mjs --update  # rewrites scripts/shape-baseline.json
```

Both commands refuse to raise a count. If a new finding looks unavoidable, split the function
or fix the rule violation; do not add a suppression to get under the baseline, because
suppressions are counted too. Coverage thresholds in `vitest.config.ts` work the same way:
raise them when coverage goes up, never lower them to make a change pass.

## Changesets and docs in the same pull request

Every change users can see needs two things in the same pull request:

1. **A changeset.** Run `npx changeset`, pick the bump and write one or two sentences for
   users: what changed and what they need to do. While palm is on 0.x, use `minor` for a
   breaking change (a removed or renamed flag, a schema change, a target path that moves
   files) and `patch` for everything else. Never write a `major` changeset before 1.0. Start
   a breaking entry with "Breaking:" and say how to migrate. A change users cannot see
   (tests, refactors, CI) needs no changeset; `npx changeset --empty` silences the CI warning.
2. **A docs page.** Add or update the page under `docs/src/content/docs/` that describes the
   command, option or behaviour. Terminal output in the docs comes from real runs captured by
   `docs/scripts/capture.mjs`, never typed by hand. After a change to output or options, run
   `npm run build`, then `npm --prefix docs run capture` and `npm --prefix docs run
   cli-reference`, and commit the regenerated files; CI fails when they are stale.

The changesets become the next release's `CHANGELOG.md` entry when the "Version Packages" pull
request is merged. Nobody edits `CHANGELOG.md` by hand.

## Commit messages

Use `area: what changed`, lowercase, in the imperative, under about 72 characters. The area is
the part of palm the change is about: `cli`, `install`, `update`, `index`, `targets`, `mcp`,
`engine`, `docs`, `ci`, `deps`. Examples from the history:

```
install: preflight names before target prompt, origin-add hint
ui: fall back to 80 columns on size-less ptys
```

Use the body to say why, when the subject does not. Keep a commit to one change; the pull
request title follows the same style.

## Adding a target

A target is one harness palm writes into (Claude Code, Codex, GitHub Copilot, Cursor, Gemini
CLI, OpenCode). Read [DESIGN.md](DESIGN.md) first: section 2 "target locations" has the table of paths per kind
and scope, and the safety rules below it apply to every target.

1. Add a spec file in `src/targets/` next to `claude.ts` and `cursor.ts`, register it in
   `SPECS` in `src/targets/index.ts`, and add its id to `TARGET_IDS`.
2. Reuse the converters (`convert-agent.ts`, `convert-hooks.ts`, and so on) and the JSON, TOML
   and managed-block helpers instead of writing files by hand. Merges must keep unrelated
   content in the user's files, and unmerging must remove only what palm added.
3. Add tests in `test/targets/` for deploy, re-deploy (no change) and undeploy, for project
   and global scope.
4. Update the target table in DESIGN.md, the targets reference page in the docs, and add a
   changeset.

## Adding a scan rule

Scan rules decide what an origin repository contains. They are listed in priority order in
DESIGN.md section 5, "Scan rules". The code is in `src/index/`.

1. Add a fixture under `test/fixtures/<name>-like/`, named after the real repository whose
   layout it copies, with only the files the rule needs.
2. Add the rule in `src/index/` at the right priority, and a test in `test/index/` that scans
   the fixture and checks the entities, names and warnings.
3. Run `npm run bench` before and after; a rule must not make large origins noticeably slower.
4. Update the scan-rules list in DESIGN.md and the scan rules reference page in the docs.

## Deprecating a command or option

The helper for this does not exist yet. When it is written, it must follow this spec, and
until then deprecations follow it by hand:

- The help text of the old name starts with `[deprecated]` and names the replacement.
- The old name keeps working as a hidden alias (commander `.hideHelp()` for options, a hidden
  command for commands), so scripts do not break.
- Every use prints one warning to stderr that names the replacement and the version it will be
  removed in, for example: `warning: --old is deprecated; use --new instead. It will be
  removed in 0.6.0.` The warning never goes to stdout, so `--json` output stays valid.
- Removal happens only in a minor release on 0.x, at the earliest one minor after the warning
  shipped, with a changeset that starts with "Breaking:" and says how to migrate.
