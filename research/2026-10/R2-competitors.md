# R2: Who already does what palm does

Research date: 2026-10-02. "acc." means a page was accessed on 2026-10-02. Every other date is the publication or release date of its source. GitHub figures come from the GitHub GraphQL API, queried on 2026-10-02 at about 20:10 UTC. "Commits 90d" counts commits on the default branch since 2026-07-04. npm figures are downloads for September 2026 from api.npmjs.org. Claims I could not confirm against a primary source are marked UNVERIFIED.

palm baseline: palm 0.2.0, released 2026-10-02. Sources are `README.md` and `PLAN.md` sections 1 to 4 in this repository.

## 0. Answer in brief

Nobody ships palm's full combination yet. A competitor would need all of the following at once:

- install from git into several harnesses' native files;
- cover all five kinds, including hooks and MCP servers;
- keep a committed lock that records the resolved commit and a hash per target;
- commit the generated files and gate them with a read-only CI check;
- require default-no consent for programs, pinned by a hash over the commands and every script byte, and replayed for teammates.

Three groups come close, each from a different direction:

1. **Cross-harness package managers.**
   - **Microsoft APM** is the closest overall. It has more targets, a lock with commit and content hashes, a drift-checking CI audit, org policy, and 61 releases in 2026. Its executable gate is opt-in, and its approvals are per package and not tied to a version.
   - **rulesync** has a lock (commit plus sha256), a frozen mode and `generate --check` across about 60 targets. Its lock covers only rules and skills, and it has no consent step.
   - **skillshare** pins commits in a committed lock and runs a blocking security audit, but it does not commit its outputs.
   - **dotagents (Sentry)** dropped lock-by-default in July 2026.
2. **Skill installers with huge reach.**
   - **vercel-labs/skills** (`npx skills`, about 27.5M npm downloads a month) and GitHub's **`gh skill`** handle skills only. Neither records the resolved commit in a project lock or offers a read-only CI gate.
3. **Harness-native plugin systems.** Claude Code, Codex, Cursor, Copilot, Gemini CLI, OpenCode and pi each manage their own harness well.
   - They have strong admin distribution and policy at Team and Enterprise tiers, plus SHA-pinned marketplace entries.
   - None has a project lockfile or a CI drift gate.
   - Only Codex (hooks) and Gemini CLI (extension summary) re-ask consent on change, and neither hashes the script bytes.

The biggest structural change in 2026 is **Agent Plugins 1.0**, released 2026-08-06 under the Linux Foundation's AAIF. It is a vendor-neutral `plugin.json` plus `skills/` plus `mcp.json` format. Amazon, Cursor, Microsoft, OpenAI and Vercel are core maintainers, and Google joined on the same day. Anthropic is not part of it. The format covers only skills and MCP. Hooks, agents and rules are explicitly deferred, which is exactly palm's territory.

On adoption palm is last. It has 0 stars and 89 npm downloads in September. On safety and reproducibility it ranks first.

## 1. What palm 0.2.0 does (the yardstick)

- **Kinds:** skills, subagents, instructions, hooks and MCP servers. A plugin is a selector over these, and commands install as skills (README "Where files go"; PLAN 4.2).
- **Harnesses:** claude, codex, copilot, cursor, gemini and opencode, each written in its native format. Gemini and OpenCode are marked unverified against the live CLIs (README).
- **Sources:** any git repository or an in-repo directory, declared in `palm.yaml`. palm reads Claude Code, Cursor and Codex plugins, marketplaces, APM packages and plain `SKILL.md` folders. There is no registry (README "Sources").
- **Reproducibility:** `palm.lock.yaml` holds, per source, the URL, range, tag and commit. Per entry it holds a content hash, one render hash per target, the file list, the identities of merged entries, and program hashes. Generated files are committed. `palm check` is a read-only CI gate that recomputes every file (README "Files"; PLAN 4.5 invariants 1 to 8).
- **Safety:**
  - Hooks and stdio MCP servers show their commands, target files and scripts, with modes, sizes and hashes.
  - The default answer is no, and `--yes` never consents.
  - Consent is a sha256 hash over the commands and every script byte. It is stored as `trust:` in the lock, replayed for teammates and CI, and re-asked on any change. Non-interactive use needs `--allow-exec kind:name@source=sha256:...`.
  - palm refuses hidden Unicode. It never writes a literal secret from a source, and `check` fails on literals in tracked files (README "Consent", "Secrets"; PLAN 4.7 and 4.8).
- **Not included:** Windows (WSL only), a registry or search, org or admin policy, the personal overlay (planned for 0.3), and pi, Amp, Kiro and other harnesses (PLAN 10.3).

## 2. Comparison table

Legend:

- **Lock** means a committed file that records the resolved commit.
- **CI gate** means a read-only check that fails on drift.
- **Exec consent** describes what happens before a hook or stdio MCP server lands.

| Product | Kinds managed | Harnesses | Lock / reproducible | CI gate | Exec consent | Team features | Pricing | Backing |
|---|---|---|---|---|---|---|---|---|
| **palm 0.2.0** | skill, agent, instruction, hook, MCP | 6, written in native formats | yes: commit, content hash and render hash per target | `palm check` recomputes every file | default no; hash over commands and script bytes; replayed from the lock; re-asks on change | committed outputs, CI gate; no org policy | free, MIT | PalionTech (one maintainer) |
| Microsoft APM | instructions, prompts, agents, skills, commands, hooks, MCP, plugins, LSP, `bin/`, lifecycle scripts | 13 GA plus 4 experimental; own primitive format translated, with a compile step for 4 targets | yes: commit, `content_hash`, `deployed_file_hashes`; `--frozen` | `apm audit --ci` with drift replay, SARIF | opt-in `executables:` gate; grants per package and not tied to a version; MCP from direct dependencies auto-trusted | org policy inheritance (enterprise > org > repo), apm-action, SBOM, many git hosts, Artifactory | free, MIT | Microsoft org, 114 contributors |
| vercel-labs/skills (skills.sh) | skills only | 79 agent IDs; symlink or copy | partial: `skills-lock.json` has content hash and ref but no resolved commit; restore is experimental | none (`check` is an alias of `update`) | advisory Gen/Socket/Snyk table; never blocks | committed lock, Packs, private repos | free (API needs Vercel) | Vercel |
| GitHub `gh skill` | skills only | about 50 hosts | partial: `--pin` tag or SHA; provenance tree SHA written into SKILL.md frontmatter; no lock | none | warning plus `gh skill preview` | publish checks (immutable releases) | free | GitHub |
| dotagents (Sentry) | skills, subagents, hooks, MCP, Agent Plugins | 8 (no Gemini) | no: `agents.lock` gitignored and "informational only"; `--frozen` retired | none | `[trust]` source allowlist only | committed `agents.toml` | free, MIT | Sentry staff |
| rulesync | rules, MCP, commands, subagents, skills, hooks, permissions, ignore | about 60; one source format compiled out | yes for rules and skills (commit plus sha256 in `rulesync.lock`); hooks and MCP fetched ad hoc | `install --frozen` plus `generate --check` | none found | committed outputs, scheduled update PRs | free, MIT | one maintainer (91 contributors) |
| skillshare | skills, agents, rules and commands, MCP, hooks, plugins | about 77 target entries; symlink or copy | partial: committed `skills.lock.json` pins commits, but cloned content is gitignored | audit plus `sync --dry-run` (no frozen gate found) | blocking audit engine at a severity threshold; hooks never executed | project and org modes, GitHub Action | free, MIT | one maintainer |
| Tessl | plugins: skills, rules, commands, MCP, hooks, docs | 7 auto-configured plus others; rules merged into `.tessl/RULES.md` | no lock; vendored mode commits `.tessl/plugins` | review gates only | Snyk scores; blocking policy only on Enterprise; no hook or MCP prompt | orgs, SSO, mandatory skills, rollout PRs | Free / $100 a month Team / Enterprise; proprietary CLI | Tessl ($125M raised) |
| Claude Code plugins | skills, commands, agents, hooks, MCP, LSP, monitors, output styles, mods, `bin/` (no rules) | Claude Code (format also read by Copilot, VS Code, Codex) | no lock; per-entry `sha` pin; auto-update on for official marketplaces | none (only `plugin validate` and evals) | generic trust warning; workspace trust plus per-server MCP approval at project scope; no re-consent on update | committed `enabledPlugins`, managed policy, strict marketplaces | Pro $20 and up; policy needs Team or Enterprise | Anthropic |
| Claude org plugins (Cowork / claude.ai) | plugins and org skills (components vary by surface) | claude.ai chat, Cowork, Claude Code | no: default branch only, silent updates | none | scan plus review queue; no hook consent | required or default installs, SCIM groups, usage stats | Team or Enterprise | Anthropic |
| Codex plugins | skills, MCP, apps, hooks (no agents or rules) | Codex and ChatGPT; reads Claude and Agent Plugins formats | no lock; `sha` pin; marketplaces auto-upgrade at startup | none | hooks: hash-trusted, re-review on change (definition only); stdio MCP not gated | admin import pinned to a commit, role policies, `requirements.toml` | Plus $20 and up; Business, Enterprise | OpenAI |
| Cursor marketplace | rules, skills, agents, commands, MCP, hooks | Cursor (reads Claude and Codex assets) | public listings SHA-pinned and reviewed; team marketplaces follow a branch; no lock | none | MCP approval re-asked on config change; workspace trust off by default; imported Claude hooks fail open | team marketplaces with Required mode, SCIM groups, enforced team rules, MDM hooks | $20; Teams $40 per user; Enterprise | Anysphere (SpaceX since 2026-08-14) |
| GitHub Copilot | agents, skills, hooks, MCP, LSP, plugins | Copilot CLI, cloud agent, VS Code, JetBrains; reads Claude format | marketplace `sha` pin; repo `enabledPlugins` is not a lock; auto-update | none | folder trust; plugin MCP implicitly trusted in VS Code | `managed-settings.json` in `.github-private`, team mappings, MCP allowlist | Free to Max; Business $19, Enterprise $39 | GitHub / Microsoft |
| Gemini CLI extensions | MCP, context, commands, hooks, skills, sub-agents, policies, themes, settings | Gemini CLI | `--ref` pin; user scope only; no project manifest | none | detailed prompt with MCP config signature; re-prompts when the summary changes (hook scripts not hashed); `--consent` bypass | admin controls (extensions off by default, MCP allowlist) | free tier; admin controls via Code Assist (UNVERIFIED) | Google |
| OpenCode | npm plugins (in-process JS), skills, agents, commands, MCP | OpenCode | no lock; unversioned plugin resolves to `@latest` | none | none: repo MCP and plugins run without consent (#6361) | remote org config, MDM | free; Go $10 | Anomaly (SST) |
| pi packages | extensions, skills, prompts, themes; MCP built in since 0.99 | pi | versions and refs pinned in settings; no lock | none | project trust per directory (default ask) | project `.pi/settings.json` | free, MIT | Earendil |
| ruler | rules, MCP, experimental skills and subagents | about 30 | no remote sources, no lock | `git status` recipe | none | committed `.ruler/` | free | individual |

## 3. Adoption and activity

All GitHub figures are from 2026-10-02.

| Repository | Stars | Commits 90d | Open issues | Latest release | npm downloads Sept 2026 |
|---|---|---|---|---|---|
| PalionTech/palm | 0 | 31 | 1 | v0.2.0 (2026-10-02) | 89 (`@paliontech/palm`) |
| microsoft/apm | 3,928 | 495 | 169 | v0.33.0 (2026-10-02) | PyPI `apm-cli` 74,160 last month; 656,894 release-asset downloads all time |
| vercel-labs/skills | 32,985 | 188 | 920 | v1.7.0 (2026-09-17) | 27,531,012 (`skills`) |
| getsentry/dotagents | 241 | 66 | 15 | 3.3.0 (2026-10-02) | 37,012 (`@sentry/dotagents`) |
| dyoshikawa/rulesync | 1,491 | 2,616 | 35 | v25.0.0 (2026-10-01) | 999,540 |
| runkids/skillshare | 2,711 | 511 | 21 | v0.23.5 (2026-10-02) | Go binary; n/a |
| intellectronica/ruler | 2,940 | 57 | 10 | v0.3.44 (2026-06-30) | 279,407 |
| Goldziher/ai-rulez | 145 | 177 | 0 | v4.22.0 (2026-10-02) | 24,214 |
| block/ai-rules | 137 | 0 | 5 | v1.7.0 (2026-05-11) | n/a |
| FutureExcited/vibe-rules | 528 | 0 | 9 | none (last push 2025-08-21) | n/a |
| iannuttall/dotagents | 709 | 0 | 6 | v0.1.3 (2026-01-21) | n/a |
| numman-ali/openskills | 10,773 | 0 | 29 | v1.5.0 (2026-01-17) | 50,105 |
| rohitg00/skillkit | 1,542 | 0 | 27 | v1.24.0 (2026-04-21) | n/a |
| davila7/claude-code-templates | 32,288 | 431 | 95 | v1.29.6 (2026-09-17) | 15,370 |
| anthropics/claude-code (public repo, mostly changelog and plugins) | 148,953 | 210 | 13,391 | v2.1.287 (2026-10-01) | 55,930,237 (`@anthropic-ai/claude-code`) |
| anthropics/claude-plugins-official | 37,315 | 2,521 (largely automated) | 1,028 | none | n/a |
| anthropics/claude-plugins-community | 4,451 | 1,572 | 46 | none | n/a |
| anthropics/skills | 179,398 | 14 | 390 | none | n/a |
| openai/codex | 127,627 | 3,840 | 20,053 | rust-v0.162.0-alpha.7 (2026-10-02) | 89,664,560 (`@openai/codex`) |
| openai/plugins | 7,262 | 13 | 0 | none | n/a |
| cursor/plugins | 9,470 | 307 | 59 | none | closed-source client |
| github/copilot-cli | 11,236 | 37 | 2,135 | v1.0.92-2 (2026-10-02) | 7,910,404 (`@github/copilot`) |
| github/awesome-copilot | 39,631 | 485 | 68 | none | n/a |
| google-gemini/gemini-cli | 107,209 | 177 | 518 | v0.64.0 nightly (2026-10-02) | 1,629,189 |
| anomalyco/opencode | 211,472 | 1,077 | 4,613 | v1.18.34 (2026-09-30) | 9,787,084 (`opencode-ai`) |
| earendil-works/pi (formerly badlogic/pi-mono) | 111,740 | 1,871 | 184 | v1.0.0 (2026-10-01) | 12,386,862 (`@earendil-works/pi-coding-agent`) plus 3,302,152 (old scope) |
| agentplugins/agent-plugins-spec | 1,347 | 79 | 10 | spec 1.0.0 (2026-08-06) | n/a |
| agentskills/agentskills | 25,857 | 16 | 44 | none | n/a |
| xingkongliang/skills-manager | 5,383 | 176 | 200 | v1.40.3 (2026-10-01) | desktop app |
| sleuth-io/sx | 306 | 440 | 12 | v2.3.9 (2026-09-03) | Go binary |
| RealZST/HarnessKit | 448 | 53 | 5 | v1.11.0 (2026-09-25) | desktop app plus CLI |
| kitze/skillbox | 256 | 11 | 5 | none (created 2026-09-17) | Docker |
| tesslio/cli (issue tracker only) | 70 | 0 | 2 | n/a | 21,380 (`@tessl/cli`, 0.113.0 on 2026-10-01) |

Caveats:

- The Claude Code and Cursor clients are closed source, so their commit counts measure only the public repositories.
- Codex counts include alpha tags.
- Stars on awesome lists (anthropics/skills 179k, ComposioHQ/awesome-claude-skills 76k, hesreallyhim/awesome-claude-code 55k) measure interest in content, not use of any tool.

## 4. Product profiles

### 4.1 Microsoft APM (Agent Package Manager)

Repository: <https://github.com/microsoft/apm>. Docs: <https://microsoft.github.io/apm/>.

- **Kinds and harnesses.** APM manages instructions, prompts, agents, skills, commands, hooks, MCP, plugins and marketplaces, LSP, `bin/` executables and lifecycle scripts.
  - Its targets are copilot, claude, grok-build, cursor, opencode, codex, gemini, antigravity, windsurf, kiro, intellij (MCP only), agent-skills and hermes, plus four experimental ones ([targets matrix](https://microsoft.github.io/apm/reference/targets-matrix/), acc.).
  - Packages are written in APM's own `.apm/` primitive format and translated. For codex, gemini, opencode and hermes, instructions need a separate `apm compile`.
  - Coverage has gaps: no Codex instructions, no Gemini agents, no OpenCode hooks.
- **Lock.** Projects declare `apm.yml` and commit `apm.lock.yaml`. Each entry records `resolved_commit`, a `content_hash` and per-file `deployed_file_hashes`. The lock supports semver ranges and `--frozen`, which is "a structural check… run `apm audit --ci` for hash verification" ([lockfile spec](https://microsoft.github.io/apm/reference/lockfile-spec/), [install](https://microsoft.github.io/apm/reference/cli/install/), acc.).
- **Consent.**
  - The executables gate shipped as "Executable Trust Governance v1" in 0.22.0 (2026-06-26). It is opt-in: "Without any opt-in, executables deploy unconditionally" ([approve doc](https://microsoft.github.io/apm/reference/cli/approve/), acc.; [exec_gate.py](https://github.com/microsoft/apm/blob/main/src/apm_cli/install/exec_gate.py), acc.).
  - Grants match a package name "regardless of the installed version". Only local bundles bind to a sha256.
  - MCP servers from direct dependencies are trusted automatically. Transitive ones need `--trust-transitive-mcp`.
  - APM scans for hidden Unicode. "Hook transparency — display hook script contents during install" is listed as planned ([security](https://microsoft.github.io/apm/enterprise/security/), acc.).
- **Team.**
  - `apm audit --ci` runs nine lockfile checks plus a drift replay, with SARIF output.
  - `apm-policy.yml` inherits enterprise > org > repo.
  - Supported hosts: GitHub, GHES, GitLab, Azure DevOps, Bitbucket, Gitea and Artifactory. It can export an SBOM ([enforce in CI](https://microsoft.github.io/apm/enterprise/enforce-in-ci/), acc.).
- **Pace.** 61 releases since 2026-01-01; v0.33.0 was released 2026-10-02 ([release](https://github.com/microsoft/apm/releases/tag/v0.33.0)).
- **Issue themes** (169 open):
  1. More harnesses: [#3047](https://github.com/microsoft/apm/issues/3047) (2026-09-21).
  2. Broken hook translation:
     - [#3129](https://github.com/microsoft/apm/issues/3129) (2026-09-30): Cursor rejects the whole `hooks.json`.
     - Epic [#2112](https://github.com/microsoft/apm/issues/2112) (2026-07-10) to replace vendor-to-vendor translation.
     - 0.33.0 notes say Codex hooks are only now written "so Codex actually runs them".
  3. Lockfile and drift regressions: [#3090](https://github.com/microsoft/apm/issues/3090), [#3071](https://github.com/microsoft/apm/issues/3071).
  4. Corporate CA and non-GitHub policy: [#2034](https://github.com/microsoft/apm/issues/2034), [#1925](https://github.com/microsoft/apm/issues/1925).
  5. Per-package hook opt-out: [#1894](https://github.com/microsoft/apm/issues/1894).
- **Pricing:** free, MIT. **Backing:** the Microsoft org, led by Daniel Meppiel ([GOVERNANCE.md](https://github.com/microsoft/apm/blob/main/GOVERNANCE.md), acc.).

### 4.2 vercel-labs/skills and skills.sh

Repository: <https://github.com/vercel-labs/skills>. Announced 2026-01-20 ([Vercel changelog](https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem)).

- **Kinds and harnesses.** Skills only. There are 79 agent IDs. Skills are symlinked from one canonical copy by default, or copied with `--copy`. Claude Code gets `.claude/skills`; Codex, Cursor, Gemini, Copilot and OpenCode share `.agents/skills` ([README](https://github.com/vercel-labs/skills), HEAD 18f96ea, acc.).
- **Lock.** `skills-lock.json` arrived in v1.4.1 (2026-02-20). It stores source, ref and a computed hash, but not the resolved commit. Commit pinning works only when the user passes a SHA ([PR #1439](https://github.com/vercel-labs/skills/pull/1439), 2026-09-06). `experimental_install` re-fetches the current ref, does not verify hashes, and installs only to `.agents/skills` ([src/install.ts](https://github.com/vercel-labs/skills/blob/main/src/install.ts), acc.). `skills check` is an alias of `update`.
- **Consent.** The CLI shows Gen, Socket and Snyk audits, but "a failed audit fetch never blocks installation… advisory only" ([src/add.ts](https://github.com/vercel-labs/skills/blob/main/src/add.ts), acc.; [audits changelog](https://vercel.com/changelog/automated-security-audits-now-available-for-skills-sh), 2026-02-17). `-y` skips the prompt.
- **Team.** You can commit `.agents/skills` and the lock. Packs arrived 2026-08-07; they are "unlisted, not access-controlled" ([packs](https://vercel.com/changelog/skill-packs-are-now-available); [docs](https://skills.sh/docs/packs), acc.). Telemetry is on by default, including in CI.
- **Directory.** The leaderboard header reads "All Time (1,548,384)" ([skills.sh](https://skills.sh), acc.).
- **Issue themes** (920 open):
  1. Indexing and listing requests.
  2. Stale or false-positive audits: [#1774](https://github.com/vercel-labs/skills/issues/1774).
  3. Lock and reproducibility. These ask for what palm already does:
     - [#549](https://github.com/vercel-labs/skills/issues/549): restore from the lock, an `npm ci` equivalent.
     - [#165](https://github.com/vercel-labs/skills/issues/165): a manifest.
     - [#542](https://github.com/vercel-labs/skills/issues/542): `check` ignores the project lock.
     - [#1222](https://github.com/vercel-labs/skills/issues/1222): a drift gate.
  4. Updates always say "up to date": [#484](https://github.com/vercel-labs/skills/issues/484).
  5. Signing: [#617](https://github.com/vercel-labs/skills/issues/617).
  6. Privacy leak for private repos: [#699](https://github.com/vercel-labs/skills/issues/699).

### 4.3 GitHub `gh skill`

Public preview since 2026-04-16 ([changelog](https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/)). It needs gh 2.90 or later.

- Installs skills from any GitHub repository into about 50 hosts, including claude-code, cursor, codex, gemini-cli and opencode. The default is project scope ([manual](https://cli.github.com/manual/gh_skill_install), acc.).
- `--pin` accepts a tag or SHA. "Each installed skill records the git tree SHA of its source directory" in its frontmatter, and `gh skill update` reads that. There is no lockfile and no CI check.
- Publishers get immutable releases and tag-protection checks. Consumers are told "Skills are not verified by GitHub and may contain prompt injections, hidden instructions, or malicious scripts."
- Skills only. It edits `SKILL.md`, so the installed bytes differ from the source.

### 4.4 dotagents (getsentry/dotagents)

Announced 2026-02-17 ([blog](https://gricha.dev/blog/dotagents)). Docs: <https://dotagents.sentry.dev>.

- **Kinds and harnesses.** Skills, subagents (native, including Codex TOML), hooks (Claude, Cursor and VS Code only), MCP and Agent Plugins. Agents covered: claude, cursor, codex, copilot, grok, vscode, opencode and pi. There is no Gemini and no instructions ([#187](https://github.com/getsentry/dotagents/issues/187) is open).
- **Lock.** `agents.lock` is gitignored and its `resolved_commit` is "Informational only". `--frozen` was retired in 1.18.0 (2026-07-17). The maintainer said lock-by-default was "much more cumbersome" ([#64](https://github.com/getsentry/dotagents/issues/64); [security](https://dotagents.sentry.dev/security/), acc.).
- **Consent.** A `[trust]` allowlist of orgs, repos and domains; without it, everything is allowed. There is no prompt or hash for hooks or MCP. An optional post-merge git hook runs `npx --yes @sentry/dotagents install` on every pull. One bug report, [#196](https://github.com/getsentry/dotagents/issues/196), says it reset a worktree's HEAD.
- **Change in 3.0.0** (2026-08-11): global scope became the default.

### 4.5 rulesync (dyoshikawa/rulesync)

- **Kinds and harnesses.** Rules, MCP, commands, subagents, skills, hooks, permissions and ignore files, authored once in `.rulesync/` and compiled to about 60 targets. `import` and `convert` read native files ([README](https://github.com/dyoshikawa/rulesync), acc.).
- **Lock.**
  - `rulesync.jsonc` sources resolve into `rulesync.lock`, which records `resolvedRef` (a commit) and a sha256 per artifact. There is also an npm transport.
  - `install --frozen` and `generate --check` form the CI gate. The documented line is `rulesync doctor --strict && rulesync install --frozen && rulesync generate --check` ([declarative sources](https://rulesync.dyoshikawa.com/guide/declarative-sources), [FAQ](https://rulesync.dyoshikawa.com/faq), acc.).
  - **Declarative sources cover only rules and skills.** Hooks, MCP, commands and subagents come in through `rulesync fetch`, which defaults to `--conflict overwrite` and is not locked ([CLI reference](https://rulesync.dyoshikawa.com/reference/cli-commands), acc.).
- **Consent:** none found. **Pace:** v23, v24 and v25 shipped between 2026-09-28 and 2026-10-01.
- **Issue themes:** about 25 "follow upstream updates" issues where fields get dropped or overwritten, e.g. [#2401](https://github.com/dyoshikawa/rulesync/issues/2401) and [#2664](https://github.com/dyoshikawa/rulesync/issues/2664). Also safe deletion of outputs (#2560 to #2562).

### 4.6 skillshare (runkids/skillshare)

- Manages skills, agents, rules and commands, MCP, native hooks ("without executing them") and plugins. It syncs to about 77 target entries by symlink or copy, through a CLI, a web UI and a desktop app ([README](https://github.com/runkids/skillshare), acc.).
- In project mode it commits `.skillshare/skills.lock.json`, "the commit each remote skill is pinned to". Cloned content is gitignored ([project setup](https://github.com/runkids/skillshare/blob/main/website/docs/how-to/sharing/project-setup.md), acc.).
- A built-in audit engine scans for prompt injection, exfiltration and secrets on install and update, and blocks at a severity threshold. `--skip-audit` overrides it.
- Free and MIT, with one maintainer, 23 contributors and 511 commits in 90 days.

### 4.7 Tessl

The SaaS "Agent Enablement Platform" with the proprietary CLI `@tessl/cli`. Skills were introduced as a package manager on 2026-01-29 ([blog](https://tessl.io/blog/skills-are-software-and-they-need-a-lifecycle-introducing-skills-on-tessl)).

- **Kinds and agents.** Plugins carry skills, rules, commands, MCP and hooks; hooks arrived in 0.92.0 (2026-07-17). Seven agents are auto-configured, and OpenCode needs custom setup. Rules are merged into `.tessl/RULES.md` rather than written natively ([configuration](https://docs.tessl.io/reference/configuration), acc.).
- **Lock.** There is no lockfile (none is documented). Vendored mode commits `.tessl/plugins`.
- **Safety.** Snyk-powered scores; a blocking install policy exists only on Enterprise. There is no hook or MCP prompt ([insecure skills](https://docs.tessl.io/tutorials/protecting-against-insecure-skills), acc.).
- **Pricing and backing.** Free, Team at $100 a month, Enterprise custom ([pricing](https://tessl.io/pricing), acc.). Founded by Guy Podjarny (Snyk founder), with $125M raised ([tech.eu](https://tech.eu/2024/11/14/snyk-founders-new-venture-tessl-raises-125m-for-ai-software-development/), 2024-11-14).

### 4.8 Claude Code plugins and marketplaces

Plugins first shipped in v2.0.12 on 2025-10-09 ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).

- **Kinds.** Skills, commands, agents, hooks, MCP (including .mcpb), LSP, monitors, output styles, themes, settings, `bin/`, and since v2.1.287 (2026-10-01) JavaScript "mods". There is no rules component: [#14200](https://github.com/anthropics/claude-code/issues/14200) is open ([components](https://code.claude.com/docs/en/plugins/components), acc.).
- **Pinning.**
  - Marketplace entries can pin `ref` plus a 40-character `sha`, or `sha256` for archives.
  - There is no project lockfile; install state is machine-local.
  - A committed `enabledPlugins` "doesn't download it", so each collaborator installs.
  - Auto-update is on by default for official marketplaces ([loading](https://code.claude.com/docs/en/plugins/loading), [install](https://code.claude.com/docs/en/plugins/install), acc.).
  - Of the official catalog's 315 entries, 262 are SHA-pinned; the community catalog's 2,283 entries are all pinned except 9.
- **Consent.**
  - Installs show a generic trust warning. The install pane "shows that a hook exists but not what it runs".
  - Updates do not re-prompt: "the files you reviewed can change on disk" ([security](https://code.claude.com/docs/en/plugins/security), acc.); [#73914](https://github.com/anthropics/claude-code/issues/73914) asks for re-consent.
  - At project scope, workspace trust plus per-server MCP approval apply.
  - `--accept-command <sha256>` (v2.1.271) is the one hash-pinned consent, and it covers command sources only.
- **Team.** `extraKnownMarketplaces` and `enabledPlugins` in `.claude/settings.json`. Managed policy keys include `strictKnownMarketplaces`, `blockedMarketplaces`, `allowManagedHooksOnly` and others ([org](https://code.claude.com/docs/en/plugins/org), acc.).
- **Issue themes** (397 open issues with "plugin" in the title):
  1. Update, cache and versioning: [#14061](https://github.com/anthropics/claude-code/issues/14061), [#93108](https://github.com/anthropics/claude-code/issues/93108).
  2. claude.ai sync.
  3. Adding private marketplaces: [#28125](https://github.com/anthropics/claude-code/issues/28125).
  4. Hooks not firing.
  5. Install pinning: [#63986](https://github.com/anthropics/claude-code/issues/63986).

### 4.9 Claude org plugins (Cowork and claude.ai)

- **Milestones.** Org skills arrived 2025-12-18 ([blog](https://claude.com/blog/organization-skills-and-directory)), private marketplaces 2026-02-24 ([blog](https://claude.com/blog/cowork-plugins-across-enterprise)), and Cowork merged into "Claude" on 2026-09-16 ([blog](https://claude.com/blog/cowork-is-now-claude)).
- **Admin control.** Each plugin is set to Not available, Available, Installed by default, or Required, with SCIM groups on Enterprise.
- **Repo sync and review.**
  - Sync comes from a private GitHub, GitLab or GHES repository via webhook. It reads only the default branch: "Tags aren't read" ([org sync](https://claude.com/docs/plugins/org-sync), acc.).
  - Members receive updates "automatically, with nothing to accept".
  - Scanning and a review queue are available; "Requires review" becomes the Enterprise default on 2026-10-02 ([admin](https://claude.com/docs/plugins/admin), acc.).
- **What loads where.** Components differ by surface; agents and hooks are ignored in chat ([platform support](https://claude.com/docs/plugins/platform-support), acc.).
- **Pricing.** Team or Enterprise.

### 4.10 OpenAI Codex plugins

- **History.** Introduced in v0.110.0 (2026-03-05). Claude marketplaces have been read since v0.146.0 (2026-07-29), and `/import` from Claude and Cursor arrived in v0.145.0 ([releases](https://github.com/openai/codex/releases)). Codex is the reference implementation of Agent Plugins 1.0.
- **Kinds.** Skills, MCP, apps, hooks and assets. There are no agents in plugins ([#18308](https://github.com/openai/codex/issues/18308) is open) and no rules ([build plugins](https://developers.openai.com/plugins/build/plugins), acc.).
- **Pinning.** Entries take `ref` or `sha`. There is no lockfile, and configured git marketplaces auto-upgrade at startup ([manager.rs](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/manager.rs), acc.). Repo-scope config arrived in v0.151.0 (2026-08-29); [#18115](https://github.com/openai/codex/issues/18115) remains open.
- **Consent.**
  - Hooks are skipped until reviewed and trusted. Trust is stored as a hash, so a new or changed hook is flagged again ([hooks](https://learn.chatgpt.com/docs/hooks), acc.).
  - The hash covers the hook definition, not the script files (inference from PR #20321).
  - Hooks from admin-managed plugins are trusted automatically.
  - No install-time gate for stdio MCP is documented.
- **Team.** Admin import from GitHub can be pinned to a commit, with install policy per role ([plugin management](https://learn.chatgpt.com/docs/enterprise/plugin-management), acc.).
- **Issue themes.** Bundled plugins broken on Windows, and cache leaks: [#39421](https://github.com/openai/codex/issues/39421) reports a 559 GB leak.

### 4.11 Cursor marketplace

- **History.** Launched in Cursor 2.5 on 2026-02-17 ([blog](https://cursor.com/blog/marketplace)). Team marketplaces arrived in 2.6 (2026-03-03), and team MCP plus groups in 3.10 (2026-06-30) ([changelog](https://cursor.com/changelog/team-marketplace-updates)).
- **Catalog.** About 394 plugins from 292 publishers (own count from the marketplace payload, acc.).
- **Pinning and review.** Public listings are pinned to a commit SHA and every update is reviewed by hand ([marketplace security](https://cursor.com/help/security-and-privacy/marketplace-security.md), acc.). Team marketplaces follow a branch.
- **Trust.** MCP config changes force re-approval, the fix for CVE-2025-54136. Workspace trust is disabled by default ([agent security](https://cursor.com/docs/agent/security.md), acc.). Imported Claude hooks receive a Cursor-shaped payload and fail open ([forum 173171](https://forum.cursor.com/t/cursor-agent-imported-claude-code-plugin-hooks-get-a-cursor-shaped-payload-so-pr/173171), 2026-09-28).
- **Pricing and backing.** Teams costs $40 per user per month and includes one team marketplace; Enterprise adds unlimited marketplaces, the MCP allowlist and team hooks ([pricing](https://cursor.com/pricing), acc.). SpaceX acquired Anysphere in a deal that closed 2026-08-14 ([Yahoo Finance](https://finance.yahoo.com/technology/ai/articles/spacex-completes-record-60-billion-131311785.html); [SatNews](https://satnews.com/2026/08/13/spacex-finalizes-regulatory-procedures-to-close-60-billion-acquisition-of-ai-platform-cursor/), 2026-08-13).
- **Signal for palm.** A request for "Team rules and skills from a git repo (context engineering as code)", with branches, PRs, CI and tagged releases, calls the marketplace "a partial answer" ([forum 173422](https://forum.cursor.com/t/team-rules-and-skills-from-a-git-repo-context-engineering-as-code/173422), 2026-09-30).

### 4.12 GitHub Copilot

- **Kinds.**
  - Custom agents (`.github/agents`, plus org and enterprise agents in `.github-private`).
  - Skills (`.github/skills`, `.claude/skills`, `.agents/skills`).
  - Hooks (`.github/hooks`).
  - Plugins that bundle agents, skills, hooks, MCP and LSP ([about CLI plugins](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-plugins), acc.).
  - Copilot reads the Claude format: `.claude-plugin/marketplace.json` and the `enabledPlugins` key in `.claude/settings.json` ([plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference), acc.).
- **Pinning and updates.** Marketplace entries can pin `sha`. A direct `copilot plugin install` has no ref syntax ([#1296](https://github.com/github/copilot-cli/issues/1296)). First-party plugins auto-update at session start.
- **Trust and policy.** VS Code says "Plugin MCP servers are implicitly trusted when you install the plugin" ([agent plugins](https://github.com/microsoft/vscode-docs/blob/main/docs/agent-customization/agent-plugins.md), 2026-09-30). Enterprise policy lives in `managed-settings.json`, with an MCP allowlist by command and `strictKnownMarketplaces` (2026-06-25, [changelog](https://github.blog/changelog/2026-06-25-enterprise-managed-settings-now-support-strictknownmarketplaces-in-vs-code-and-the-cli/)). Enterprise-managed plugins have been in public preview since 2026-05-06 ([changelog](https://github.blog/changelog/2026-05-06-enterprise-managed-plugins-in-github-copilot-cli-are-now-in-public-preview/)).
- **Issue themes.** Hooks not firing ([#2540](https://github.com/github/copilot-cli/issues/2540)), skills unreachable past about 32 ([#1464](https://github.com/github/copilot-cli/issues/1464)), and Claude marketplace incompatibility (#1996).

### 4.13 Gemini CLI extensions

- **Contents and gallery.** An extension carries MCP, `GEMINI.md`, commands, hooks, skills, sub-agents, policies, themes and settings, with secrets kept in the keychain ([reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md), acc.). The gallery lists 2,091 extensions, auto-indexed from a GitHub topic with no review (own count of [extensions.json](https://geminicli.com/extensions.json), acc.).
- **Pinning.** `--ref` pins an extension and auto-update is opt-in. Installs are user scope only, with no project manifest or lock.
- **Consent.**
  - The prompt lists MCP commands, env and headers, a SHA-256 "Config signature", and a warning when hooks are present.
  - It re-prompts only when that summary changes, so changed hook scripts slip through.
  - `--consent` skips the prompt ([consent.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/extensions/consent.ts), acc.).
- **Enterprise.** Admin controls disable extensions and MCP by default and offer an MCP allowlist ([enterprise controls](https://github.com/google-gemini/gemini-cli/blob/main/docs/admin/enterprise-controls.md), acc.).
- **Issue themes.** Gallery indexing ([#28861](https://github.com/google-gemini/gemini-cli/issues/28861)) and unvalidated MCP commands from extensions ([#29079](https://github.com/google-gemini/gemini-cli/issues/29079), 2026-08-25).

### 4.14 OpenCode

- **Plugins and other kinds.** Plugins are in-process JS/TS loaded from `.opencode/plugins` or npm packages in `opencode.json`. They are installed by Bun into `~/.cache/opencode`, and an unversioned plugin resolves to `@latest`. OpenCode also reads skills from `.opencode`, `.claude` and `.agents`, plus agents, commands, MCP and remote instruction URLs ([plugins](https://opencode.ai/docs/plugins/), [skills](https://opencode.ai/docs/skills/), acc.).
- **What it lacks.** No lock, no git sources and no trust gate. A repository's MCP command runs on startup without consent ([#6361](https://github.com/anomalyco/opencode/issues/6361), closed by a stale bot on 2026-04-15).
- **Demand.** The master issue for a marketplace is [#28696](https://github.com/anomalyco/opencode/issues/28696). An Agent Plugins request is open as [#40993](https://github.com/anomalyco/opencode/issues/40993).

### 4.15 pi packages (earendil-works/pi)

- **Ownership.** The repository moved from badlogic/pi-mono when Mario Zechner joined Earendil ([post](https://mariozechner.at/posts/2026-04-08-ive-sold-out/), 2026-04-08; [new home](https://pi.dev/changelog/2026/5/7/pi-has-a-new-home)). v1.0.0 was released 2026-10-01.
- **Packages.** A package bundles extensions, skills, prompt templates and themes, installed with `pi install npm:…@1.0.0`, `git:…@v1` or a local path, into user settings or project `.pi/settings.json`. "Versioned npm specifications are pinned. Git tags and commits are also pinned" ([packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md), acc.). There is no lockfile.
- **Project trust.** Trust is keyed by directory (default "ask") and covers `.pi/` resources ([security.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md), acc.).
- **Gallery.** <https://pi.dev/packages> lists about 5,394 npm packages tagged `pi-package`.
- **Issue themes.** npm and pnpm interplay ([#6600](https://github.com/earendil-works/pi/issues/6600), #10202) and teething problems with the new built-in MCP.

### 4.16 Rule and config syncers

- **ruler** ([repository](https://github.com/intellectronica/ruler), v0.3.44 on 2026-06-30). Concatenates `.ruler/*.md` into about 30 agents, adds MCP from `ruler.toml`, and has experimental skills and subagents. No remote sources, lock or consent. It gitignores outputs by default.
- **ai-rulez** ([repository](https://github.com/Goldziher/ai-rulez), v4.22.0 on 2026-10-02). Covers rules, skills, agents, commands, MCP and hooks for 14 presets, and emits plugin bundles, including Agent Plugins. Remote includes default to HEAD and there is no lockfile. Generated files carry content hashes.
- **block/ai-rules** ([repository](https://github.com/block/ai-rules), last release 2026-05-11). Covers rules, commands, skills and MCP for 11 agents. `ai-rules status` exits non-zero when out of sync. Local only.
- **vibe-rules** has been stale since 2025-08. **iannuttall/dotagents** is a symlinker with no activity since February 2026. **steipete/agent-rules** is archived.

### 4.17 Registries, directories and lists

- **SkillsMP** (<https://skillsmp.com>, acc.). Indexes "3,337,075 Collected SKILL.md files" and "does not certify or install them". Free.
- **claude-plugins.dev** ([Kamalnrf/claude-plugins](https://github.com/Kamalnrf/claude-plugins)). An auto-index claiming 11,989 plugins and 63,065 skills, plus one-step install CLIs. No lock or scan.
- **aitmpl.com** ([davila7/claude-code-templates](https://github.com/davila7/claude-code-templates)). Covers about 913 skills, 424 agents, 348 commands, 63 hooks and 104 MCP configs, for Claude Code only. It fetches from `main` with no pin and installs hooks without showing their content.
- **Smithery** ([smithery.ai/skills](https://smithery.ai/skills), acc.). Lists 24,018 skills and installs them via `npx skills`. Arcade acquired it on 2026-08-05 ([Arcade](https://www.arcade.dev/blog/smithery-joins-arcade/); [Forbes](https://www.forbes.com/sites/janakirammsv/2026/08/10/arcade-acquires-smithery-to-own-the-agent-tool-supply-chain/), 2026-08-10).
- **LobeHub Skills** ([lobehub.com/skills](https://lobehub.com/skills), acc.). Lists 334,144 skills and is the only registry here with per-skill `--version`.
- **skillkit** ([rohitg00/skillkit](https://github.com/rohitg00/skillkit)). Has a blocking static scan and a global lock that hashes SKILL.md only. No commits in 90 days.
- **skild** ([Peiiii/skild](https://github.com/Peiiii/skild)). A project lock with a content hash but no commit.
- **openskills.** Dormant since 2026-01 ([#94](https://github.com/numman-ali/openskills/issues/94)).
- **Awesome lists** (travisvn, ComposioHQ, VoltAgent, hesreallyhim) and **anthropics/skills.** Content feeders, not tools. anthropics/skills has a trust-boundary issue where community skills appear under the anthropic namespace ([#492](https://github.com/anthropics/skills/issues/492)).
- **agentskills.io** ([agentskills/agentskills](https://github.com/agentskills/agentskills)). The SKILL.md spec has no versioning, locking or distribution. Its open issues ask for them: [#46](https://github.com/agentskills/agentskills/issues/46) versioning and locking, [#255](https://github.com/agentskills/agentskills/issues/255) discovery, [#15](https://github.com/agentskills/agentskills/issues/15) a standard folder (100 comments). The AAIF Technical Committee approved moving it to the Linux Foundation on 2026-10-01 ([proposal #47](https://github.com/aaif/project-proposals/issues/47)).

### 4.18 Entrants from 2026 and standards

- **Agent Plugins 1.0** ([agent-plugins.org](https://agent-plugins.org/), acc.; [AAIF blog](https://aaif.io/blog/from-skills-and-tools-to-portable-agent-plugins), 2026-08-06; [AWS](https://aws.amazon.com/blogs/opensource/aws-supports-agent-plugins-an-open-standard-for-portable-agent-extensions/)).
  - The format is `plugin.json`, `skills/` and `mcp.json`, plus reverse-domain client namespaces.
  - It "deliberately excludes" installation, registries, provenance, signing, hooks, agents, rules and commands.
  - Compatible clients: VS Code, Cursor, Copilot, ChatGPT and Codex, Kiro, Hermes, OpenClaw, Grok, NanoClaw and OpenHands. Claude Code is absent.
  - Spec 1.1.0 is a working draft.
- **sx and skills.new by Sleuth** ([sleuth-io/sx](https://github.com/sleuth-io/sx); [skills.new](https://skills.new), acc.).
  - Manages skills, rules, agents, commands, hooks, MCP and plugins for Claude Code, Cline, Codex, Cursor, Copilot, Gemini, Kiro, OpenCode, and claude.ai and chatgpt.com via a relay.
  - Has an `sx.toml` "vault" manifest and a per-user lock, with scopes for org, repo, path, team, bot and user, audit logs and usage stats.
  - RBAC and a change-request flow are "forthcoming". SaaS pricing is not public.
- **HarnessKit** ([RealZST/HarnessKit](https://github.com/RealZST/HarnessKit), v1.11.0 on 2026-09-25). A desktop app and CLI for skills, MCP, plugins, hooks and CLIs across 15 agents. It gives a 0 to 100 trust score from 18 static rules. No lock and no team features.
- **skills-manager** ([xingkongliang/skills-manager](https://github.com/xingkongliang/skills-manager), 5.4k stars). A desktop app that syncs skills to 54 tools. Skills only, with no pinning or scan.
- **Camunda spm** ([camunda.github.io/spm-cli](https://camunda.github.io/spm-cli/), acc.; HN 2026-09-10). Skills declared in `ai.json` and locked to SHAs in `ai.lock`. Outputs are gitignored like `node_modules`. Eight agents. A corporate-backed copy of the skills slice of palm's model.
- **capshelf** ([genged/capshelf](https://github.com/genged/capshelf), v0.13.0 on 2026-09-18).
  - Handles skills, subagents, settings and MCP fragments for Claude, Codex, Cowork and Pi.
  - A committed lock pins git tree digests, and `status --strict` serves as the drift gate.
  - The closest small-scale twin of palm's file model, with 21 stars.
- **Others found, judged minor.**
  - Lock-based skill installers: skillpm on npm ([skillpm.dev](https://skillpm.dev)), the Skilldex paper and CLI ([arXiv 2604.16911](https://arxiv.org/html/2604.16911v1), 2026-04-18), [luml-ai/AGENTS.lock](https://github.com/luml-ai/AGENTS.lock), [skill-vendor/skv](https://github.com/skill-vendor/skv), [nattergabriel/reseed](https://github.com/nattergabriel/reseed), [knoxgraeme/skillfish](https://github.com/knoxgraeme/skillfish) and [agentloom.sh](https://agentloom.sh).
  - Dotfile-style sync across harnesses: [yourconscience/tackroom](https://github.com/yourconscience/tackroom), commit-pinned and audited, and [timvdhoorn/harness-sync](https://github.com/timvdhoorn/harness-sync).
  - Self-hosted skill library over MCP: [kitze/skillbox](https://github.com/kitze/skillbox).
  - Kiro powers, which bundle MCP, steering and hooks from GitHub URLs with no pinning ([Kiro docs](https://kiro.dev/docs/powers/installation/), updated 2026-09-30).

## 5. Ranking against palm 0.2.0

The scores run from 0 to 5 on each axis and are my judgement from the evidence above. The criteria:

- **Scope:** kinds multiplied by harnesses, written natively.
- **Reproducibility:** a lock that records the resolved commit and integrity, a restore from it, committed outputs, and a CI gate.
- **Safety:** consent for programs (default, granularity, re-consent on change, hashing of script content), scanning and secrets handling.
- **Team workflow:** committed config, onboarding without the tool, CI, org distribution and policy, private sources.
- **Adoption:** stars, downloads, ecosystem size and backing.

| Product | Scope | Reproducibility | Safety | Team workflow | Adoption | Sum |
|---|---|---|---|---|---|---|
| **palm 0.2.0** | 3 | **5** | **5** | 3 | 0 | 16 |
| Microsoft APM | **5** | 4 | 3 | **5** | 3 | **20** |
| rulesync | **5** | 4 | 1 | 3 | 3 | 16 |
| skillshare | 4 | 3 | 3 | 3 | 2 | 15 |
| Cursor marketplace | 2 | 2 | 3 | **5** | 4 | 16 |
| GitHub Copilot (plugins, agents, `gh skill`) | 3 | 2 | 3 | **5** | **5** | 18 |
| Claude Code plugins | 3 | 2 | 3 | 4 | **5** | 17 |
| Codex plugins | 2 | 2 | 3 | 4 | **5** | 16 |
| Claude org plugins (Cowork) | 2 | 1 | 3 | **5** | 4 | 15 |
| vercel-labs/skills | 2 | 2 | 2 | 2 | **5** | 13 |
| Tessl | 3 | 2 | 3 | 4 | 2 | 14 |
| Gemini CLI extensions | 2 | 1 | 3 | 2 | 4 | 12 |
| pi packages | 1 | 2 | 2 | 2 | **5** | 12 |
| dotagents (Sentry) | 3 | 1 | 1 | 2 | 2 | 9 |
| ruler | 3 | 1 | 1 | 2 | 3 | 10 |
| OpenCode plugins | 1 | 1 | 0 | 2 | **5** | 9 |

Where palm stands on each axis:

- **Scope: 4th (3 points), tied with Tessl, Copilot, Claude Code, dotagents and ruler. Behind rulesync, APM, skillshare and the unscored sx.**
  - palm covers all five kinds in six harnesses, natively, and reads every major plugin format as a source.
  - rulesync (about 60 targets) and APM (13 or more) reach more harnesses. skillshare reaches more by symlink.
  - palm lacks commands as a separate kind, LSP, Pi, Amp, Kiro and Windows.
  - Gemini and OpenCode are still unverified against the live CLIs.
- **Reproducibility: 1st.** APM is close behind with commit, content hash and per-file hashes plus a drift replay. Then come rulesync (lock limited to rules and skills), skillshare (lock but no committed outputs) and capshelf. Every harness-native system scores 2 or below because none has a project lock.
- **Safety: 1st.**
  - Only palm hashes script bytes, defaults to no, refuses `--yes`, and replays consent from a committed lock.
  - Next is a group at 3 points:
    - Codex: hook-definition hashing.
    - Gemini: an MCP config signature.
    - APM: opt-in and tied to the package.
    - skillshare: a blocking audit.
    - Cursor: MCP re-approval.
- **Team workflow: middle of the pack.**
  - palm's onboarding is the cheapest: a clone needs no palm run, and `check` covers CI.
  - It has no org policy, admin push, IdP groups, usage analytics or non-git distribution, and no Windows.
  - Cursor, Copilot, Claude org plugins and APM all do better here.
- **Adoption: last.** palm has 0 stars and 89 npm downloads in September 2026. The repository was created 2026-09-28, and 0.2.0 was released 2026-10-02.

## 6. What each does better than palm

- **Microsoft APM.**
  - About twice the targets, including Windsurf, Kiro, Antigravity, Grok and Hermes.
  - Transitive dependency resolution.
  - Org policy that only tightens (enterprise > org > repo), with SARIF output and SBOM export.
  - Artifactory, air-gapped installs and private-registry support across six git hosts.
  - Plugin authoring and export (`apm pack`).
  - Microsoft branding and 114 contributors shipping about one release a week.
- **rulesync.**
  - About 60 targets and more kinds: permissions, ignore files and checks.
  - `import` and `convert` from native configs.
  - npm transport with integrity checks.
  - Named adopters: Classmethod, Cloudflare docs, Effect, AG Grid, Red Hat ([case studies](https://rulesync.dyoshikawa.com/guide/case-studies), acc.).
  - About a million npm downloads a month.
- **skillshare.**
  - A blocking content audit for prompt injection, exfiltration and secrets.
  - A desktop app and a web UI.
  - About 77 targets including Pi, plus native Windows (junctions).
  - An org mode.
- **vercel-labs/skills and skills.sh.**
  - Discovery, with a 1.5M-entry leaderboard and vendor "official" listings.
  - Three third-party audits.
  - 79 agents and zero-install `npx`.
  - About 27.5M downloads a month. It is the de facto default for publishing skills.
- **`gh skill`.**
  - Ships inside the GitHub CLI, so it has no install hurdle.
  - Publisher-side guarantees: immutable releases and tag protection.
  - About 50 hosts.
- **dotagents.**
  - Sentry's backing.
  - Agent Plugins as a native format.
  - Pi support.
  - `minimum_release_age` for unpinned sources.
- **Tessl.**
  - A registry with evals that measure whether a skill helps.
  - Security scores, mandatory org skills, and rollout PRs across many repositories.
  - SSO and audit logs.
  - A funded company.
- **Claude Code plugins.**
  - Breadth of first-party kinds: LSP, monitors, mods, output styles, channels.
  - Plugin evals.
  - A large SHA-pinned catalog (315 official plus 2,283 community).
  - A managed policy that blocks or forces plugins.
  - A format that Copilot, VS Code and Codex now read.
- **Claude org plugins.**
  - One admin console spanning chat, Cowork and Claude Code.
  - Required installs, SCIM targeting and usage analytics.
  - Members need no git or terminal, so it reaches non-developers.
- **Codex plugins.**
  - Hash-based hook trust built into the harness itself.
  - Admin import pinned to a commit, with per-role policy.
  - Reads Claude and Agent Plugins formats.
  - ChatGPT-scale distribution.
- **Cursor.**
  - A reviewed, SHA-pinned public catalog.
  - Team marketplaces with Required mode and IdP groups.
  - Enforced team rules and MDM-pushed hooks.
  - Reads Claude and Codex files with no conversion.
- **GitHub Copilot.**
  - Version-controlled enterprise policy in `.github-private` with team mappings.
  - MCP allowlist by stdio command, `strictKnownMarketplaces`, and forced plugins.
  - Org-level custom agents.
- **Gemini CLI.**
  - The largest extension gallery (2,091).
  - The richest single package: policies, keychain-stored settings, themes.
  - An environment-sanitised runtime for extensions.
  - Enterprise controls that are secure by default.
- **pi.**
  - Packages from npm or git with resource filtering per package.
  - A 5.4k-package gallery.
  - A project-trust prompt in the runtime.
  - Strong funding and a 1.0 release.
- **OpenCode.**
  - The largest user base (211k stars).
  - Remote org config via `.well-known/opencode`.
- **ruler, ai-rulez, block/ai-rules.** Simpler mental models. ai-rulez already emits Agent Plugins bundles.
- **sx / skills.new, HarnessKit, skills-manager.**
  - Scopes per team, path and bot, with audit logs (sx).
  - GUIs with trust scores (HarnessKit) and one-click sync to 54 tools (skills-manager).
  - Both GUIs reach people who avoid terminals.

## 7. What palm does that none of them do

Each item was checked against the profiles above. "None" means none of the products in section 4.

1. **Consent for every program, pinned by a hash over the commands and every script byte, recorded in a committed lock, and replayed for teammates and CI.**
   - Codex hashes only the hook definition, per user, and leaves stdio MCP ungated.
   - Gemini hashes an MCP config summary but not hook scripts, and `--consent` skips the prompt.
   - APM's gate is opt-in and its grants ignore the version.
   - Claude Code does not re-prompt on update.
   - Cursor re-approves MCP only, per user.
   - pi trusts by directory.
   - No product combines default no, a refusal to let `--yes` consent, and a non-interactive consent line that names the exact `sha256:` hash. Claude's `--accept-command <sha256>` is the nearest, and it covers command-type plugin sources only.
2. **One lock covering all five kinds, hooks and MCP included, with resolved commits, a render hash per harness, and committed generated files that a read-only check recomputes.**
   - APM is closest. Its CI audit replays installs, but some targets go through a compile step, and its executables are not hash-pinned.
   - rulesync's lock omits hooks, MCP, commands and subagents.
   - skillshare, Camunda spm and dotagents gitignore their outputs.
   - No harness-native system has a project lock at all.
3. **"A clone works without the tool" as a verified invariant, not an option.** Because outputs are committed, the harness reads them directly. Some competitors allow this, but none treats it as the contract that its check enforces:
   - In rulesync and APM, committing outputs is optional.
   - Tessl's vendored mode commits plugins but gitignores `RULES.md`.
   - capshelf copies items into the project.
   - All harness-native systems need a per-developer install or a runtime fetch that follows upstream. Claude Code is explicit that a committed `enabledPlugins` "doesn't download it".
4. **Installing from repositories as they are published.** A single invocation installs individual members from Claude, Cursor and Codex plugins, marketplaces, APM packages and plain `SKILL.md` folders, without the publisher repackaging anything.
   - Codex, Copilot and VS Code read the Claude format but write only for themselves.
   - The skills CLI reads Claude marketplaces for skills only.
   - I found no other tool that consumes `apm.yml` packages (UNVERIFIED as an absolute claim).
5. **A secrets rule enforced at write time and in CI.** A literal from a source is never written; palm writes an environment reference in each harness's syntax instead. `check` fails on a literal in tracked files, including merged harness configs.
   - Gemini keeps extension settings in the keychain, but only for its own harness.
   - None of the cross-harness installers documents a CI failure on committed secrets.
6. **Exact, symmetric removal of merged entries by identity.** palm removes a hook from `.claude/settings.json`, `.codex/hooks.json` or `.cursor/hooks.json` without touching foreign entries, and edit detection uses the render hash, so a pull is never mistaken for a local edit.
   - Many syncers overwrite or regenerate whole files instead. rulesync's `fetch` defaults to `--conflict overwrite`, and in palm's persona census the data loss came from APM rewriting a whole file (palm PLAN.md section 3).
7. **No account, no registry, no telemetry.** palm contacts only the declared git hosts.
   - skills sends telemetry by default, including in CI.
   - claude-code-templates also has telemetry on by default.
   - Tessl and Packs need accounts.
   - Harness-native org features need paid tiers.

## 8. Implications for palm

These are inferences, not findings.

- **Read Agent Plugins 1.0 as a source format, and consider emitting it.** It is now the common floor for skills and MCP across Cursor, Copilot, VS Code, Codex and Kiro. It deliberately leaves out hooks, agents, rules, locking and consent, which is palm's layer.
- **APM is the competitor to position against, and the README section "How palm differs from Microsoft APM" needs updating.**
  - APM now has an executables gate, hidden-Unicode scanning and drift replay.
  - The honest differences are opt-in versus default-no consent, package-scoped versus hash-pinned grants, compiled versus native output, and no compile step.
- **Demand palm already meets is visible in competitors' trackers.**
  - Vercel: [#549](https://github.com/vercel-labs/skills/issues/549), [#1222](https://github.com/vercel-labs/skills/issues/1222).
  - Claude Code: [#73914](https://github.com/anthropics/claude-code/issues/73914), [#63986](https://github.com/anthropics/claude-code/issues/63986).
  - Codex: [#18115](https://github.com/openai/codex/issues/18115).
  - Agent Skills spec: [#46](https://github.com/agentskills/agentskills/issues/46).
  - Cursor forum: [173422](https://forum.cursor.com/t/team-rules-and-skills-from-a-git-repo-context-engineering-as-code/173422).
- **palm's weakest axes are adoption and org workflow.** Harness vendors are moving governance into paid admin consoles. palm's answer is git plus CI. It could add a policy file (an allowlist of sources and of program hashes) checked by `palm check` without becoming a SaaS.

## 9. Method and limits

- **Sources.** Five parallel research passes covered: APM, dotagents and Tessl; skills and registries; Claude, Cowork and Codex; Cursor, Copilot and Gemini; OpenCode, pi and syncers. I ran the 2026-entrant sweep myself, using GitHub, Hacker News via Algolia (stories since 2025-10-01) and web search.
- **Primary sources** (docs, source code, changelogs, release notes) were preferred. Secondary sources are used only for funding, acquisitions and the Agent Plugins launch context.
- **Issue themes** come from the most-commented open issues and keyword buckets. For claude-code and codex the searches were limited to titles, because full-text "plugin" matches were dominated by unrelated issues.
- **Known gaps:**
  - Cursor and Claude.ai have no public issue trackers; Cursor themes come from its forum.
  - Tessl has almost no public tracker.
  - The absence of a feature is inferred from documentation and source, and is marked UNVERIFIED where it matters.
  - Scores in section 5 are judgement.
