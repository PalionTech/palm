# R6: How to position palm 0.2.0

Research date: 2026-10-02.

Inputs:
- the palm README and PLAN.md at f153855
- the docs landing page and the CI guide
- FINDINGS.md §5 (0.1.0 verdicts) and FINDINGS-v3.md with `reports-v3/*.md` (0.2 release candidate verdicts)
- the earlier research in `research/R4-competitors.md` (2026-09-28) and `research/S1-user-critiques.md` (2026-09-29)

Market data was fetched on 2026-10-02 from web pages, the npm downloads API (week of 2026-09-24 to 09-30), the GitHub API and the HN Algolia API. Where a source states its own date, it appears next to the link. `[U]` marks a claim I could not verify.

## 0. The answer in brief

**Lead with team reproducibility and the CI gate, direction 1.** Pitch it as "the agent setup in this repository is pinned and reviewed, and CI checks it, for every coding agent the team uses."

- **Consent for programs (direction 2) is the reason to pick palm over look-alikes.** It is a selling point, not a market of its own.
- **Migration (direction 3) is the on-ramp.**
- **For distribution (direction 4), ship a GitHub Action.** Do not build an SDK or an MCP server that installs things.
- **Keep the global scope (direction 7) as a feature,** not the headline.
- **Do not build a registry (direction 5) or an org-policy product (direction 6).**

Four facts support this:

1. **The gap that lasts is verification, not format translation.**
   - Agent Plugins 1.0 (6 Aug 2026) makes skills and MCP servers portable. It leaves "marketplaces, installation, permissions, sandboxing, and trust" to each client.
   - Hooks, agents and rules stay client-specific.
   - Claude Code has read `AGENTS.md` since 18 Sep 2026.
   - Every vendor manages its own files and its own fleet. No vendor owns the question "is what this repository commits correct for every harness, and does CI agree?"
2. **Users ask for exactly that, in these words.** The `skills` issue titled "restore all skills from skills-lock.json (**npm ci equivalent**)" has 47 reactions and has been open since 8 Mar 2026. It says the committed lock has "zero value for fresh clones, new team members, or clean CI runners."
3. **The persona study recommends palm to team leads, service owners and platform teams.**
   - The security persona would not call it "the" security gate.
   - The skills.sh migrant said "still not yet" for lack of an import.
4. **The category label is crowded and gets little attention.** At least nine "package manager for agent skills" launches on Hacker News in 2026 scored 7 points or fewer.

## 1. What palm 0.2.0 is, and what the study says people value

palm installs skills, subagents, rules, hooks and MCP servers from git repositories into the native files of six harnesses. The generated files are committed, so a clone needs no palm run. A lock pins every source to a commit. `palm check` recomputes every generated file in CI. Hooks and stdio MCP servers need a reviewed yes, pinned by a hash over the commands and every script byte. As of 0.2.0, `check --strict` fails on hook commands and stdio servers in harness files that no lock entry explains (CHANGELOG, 0.2.0).

**Features that set palm apart, checked against the closest rivals:**

| palm 0.2.0 | Closest rival | Status |
|---|---|---|
| Committed outputs, so teammates need nothing | APM commits deployed files and checks drift in CI. dotagents commits by default. Camunda's spm says the opposite: "without ever committing skills to your repo". | shared with APM and dotagents |
| `check` recomputes each generated file from the lock | APM `audit --ci` checks lockfile, cache, ref and Unicode drift. dotagents has `--frozen`. | shared with APM |
| Consent is a hash over the commands plus every script byte. The default answer is no, and `--yes` never consents. Teammates and CI replay it, and a changed byte asks again. | APM has a trust ladder: `exec_status` in the lock, `apm approve <pkg>`, and content-digest keys for local bundles only. Codex treats hooks as untrusted by default. Claude Code uses workspace trust. | per-byte pinning for git sources looks distinctive. It is not unique as a category. |
| `check --strict` fails on hooks and stdio servers that no lock entry explains | APM's documented drift kinds do not cover unmanaged entries in harness configs. | not found in any other manager |
| Native rendering of the kinds Agent Plugins leaves non-portable: Codex `.toml` agents, Copilot `.agent.md`, Cursor `.mdc`, merged hooks | APM (16 targets) and rulesync (~55 targets, generator only) | shared, and less durable (section 2) |
| A literal secret from a source is never written | APM #2991, which bakes secrets into `.cursor/mcp.json`, is still open (R3) | an advantage over APM today |

**0.1.0 verdicts (FINDINGS.md §5):** 1 yes, 1 conditional allow, 18 maybe, 0 no. Grouping the 20 "one reason" lines by the job that failed:

- **Team or CI reproducibility, 8:** Dmitri, Priya, Ben, Elena, Ziad, Johnny, Mei, Raj.
- **Harness fidelity or file safety, 6:** Marco, Ryan, Brad, Kenji, Sridhar, Chris.
- **Executable content or secrets, 3:** Sofia, Dana, Ivan.
- **Onboarding, 2:** Nora, Lena.
- **The one yes, 1:** Jan, for a zero-diff swap from APM.

People judged palm mostly on the team and CI job. 0.2 was rebuilt around that job.

**0.2 release-candidate rerun (FINDINGS-v3.md):** 13 personas were rerun. 11 said yes, Sofia gave a conditional allow, and Jan said maybe. Who they would recommend it to:

- Mei: "to our team lead, for the shared baseline" (`reports-v3/mei.md`).
- Kenji: "to service owners and to Codex-only colleagues … For the platform team migrating 0.1 projects, also yes" (`kenji.md`).
- Ryan: "Their loop is `git pull`, `palm install`, `palm check`, and all three work" (`inbound.md`).
- Jan: yes "for a macOS/Linux team … which commits harness folders" and no for "gitignored `.claude/`, `* text=auto eol=lf`, Windows maintainers" (`omp.md`).
- Sofia: "Yes, for installing skills and reviewed hooks from named repositories, with the CI conditions above. **Not yet as 'the' security gate** for agent config: it vouches for what it wrote, not for the files around it" (`sofia.md`).
- Chris: "For someone **migrating from skills.sh** on their own: **still not yet**. There is no import" (`keybase.md`).
- Raj: yes, "including the dotfiles people" (`raj.md`).

## 2. The market on 2026-10-02

### Adoption numbers

| Tool | npm downloads, week to 09-30 | GitHub ★ | Note |
|---|---|---|---|
| Vercel `skills` | 6,506,491 | 32,985 | Skills only. Lock restore still open: #549 (47 reactions), #283 (56), #155 (35), #11 (27). |
| `agent-install` (millionco) | 3,112,000 | – | Node API and CLI for 40+ agents. Mostly pulled in as a dependency of other CLIs (R4). |
| `rulesync` | 292,833 | 1,491 | A generator. The lock covers sources, not outputs (R4). |
| `add-mcp` (Neon) | 212,929 | – | MCP only. |
| `@sentry/dotagents` | 9,609 | 241 | Same shape as palm: commits, lock, `--frozen`, a source allowlist. |
| `@tessl/cli` | 7,475 | – | Registry plus evals. Funded. |
| `@paliontech/palm` | 89 | – | 0.2.0, published this week. |
| Microsoft APM | (not on npm) | 3,928 | v0.33.0 released today. 74% of recent release-note PRs are fixes, and the maintainer ran a "contribution reset" in Sep 2026 (R3). |

### Who uses which agent

The JetBrains Developer Ecosystem Survey 2026 polled 15,000+ developers from May to July 2026 (https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/, Aug 2026). 90% use agents weekly. Shares used at work:

| Agent | Share |
|---|---|
| Claude Code | 39% (47% in the US, up from 18% in January) |
| Copilot | 21% |
| Codex | 16% (up from 3%) |
| Cursor | 12% |
| OpenCode | 7% |

The listed shares add up to about 110% of the 90% who use agents at all, so many developers use more than one tool. A secondary source puts "2–4 tools" at 70% `[U]`.

The AIware '26 dataset found agent configuration in 4,738 of 40,585 actively maintained repositories, about 11.7% (https://arxiv.org/abs/2605.08435, 8 May 2026).

**Mixed teams are growing.** Codex alongside Claude Code is the obvious wedge. A Claude-only team is well served by Claude Code's own plugins.

### Vendor convergence

| Date | Move | Source |
|---|---|---|
| 3 Mar 2026 | Cursor 2.6 adds team marketplaces on the Teams and Enterprise plans. Later releases add Required, Default On and Default Off per plugin. | https://cursor.com/changelog/2-6 ; https://forum.cursor.com/t/cursor-2-6-team-marketplaces-for-plugins/153484 |
| 16 Apr 2026 | `gh skill` ships in preview. It pins with `--pin` in frontmatter; there is no lockfile. | https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/ |
| 6 May 2026 | Copilot CLI enterprise-managed plugins (Business and Enterprise) install automatically and set baseline hooks and MCP servers. | https://github.blog/changelog/2026-05-06-enterprise-managed-plugins-in-github-copilot-cli-are-now-in-public-preview/ |
| 6 Aug 2026 | Agent Plugins 1.0 launches with AWS, Anysphere, Microsoft, OpenAI and Vercel, joined by Google. Anthropic is not a maintainer. The portable core is skills and MCP; hooks, agents and rules go in vendor namespaces. The spec defines no lockfile, versioning or signing, and "installation, permissions, sandboxing, and trust all stay with each client". | https://thenextweb.com/news/openai-agent-plugins-open-standard-skills-mcp (6 Aug 2026); https://blakecrosley.com/blog/agent-plugins-standard (6 Aug 2026) |
| 12 Aug 2026 | Agent Plugins 1.0 is generally available in VS Code, Copilot CLI and the Copilot app, governed through `managed-settings.json` with `enabledPlugins`, `extraKnownMarketplaces` and `strictKnownMarketplaces`. | https://github.blog/changelog/2026-08-12-agent-plugins-1-0-in-vs-code-copilot-cli-and-the-copilot-app/ |
| 18 Sep 2026 | Claude Code 2.1.277 reads `AGENTS.md` when there is no `CLAUDE.md`. | https://www.theregister.com/ai-and-ml/2026/09/18/anthropic-decides-to-support-openais-markdown-instructions-spec/5297588 |
| current | Claude Code managed settings cover the marketplace allowlist and blocklist, force-enabled plugins, `allowManagedHooksOnly`, `strictPluginOnlyCustomization`, and OTel install events. An analytics API comes with the Enterprise plan. | https://code.claude.com/docs/en/plugins/org (read 2026-10-02) |
| current | Codex `requirements.toml` sets allowed marketplace sources, an MCP allowlist and managed hooks, plus `allow_managed_hooks_only`. | https://developers.openai.com/codex/enterprise/managed-configuration |

One gap remains in the vendor tools. Claude Code's own docs say a plugin enabled only in a repository's `.claude/settings.json` from an external source is not fetched on a teammate's machine. The teammate sees `Plugin "<name>" is enabled in project settings but isn't installed here` and must install it by hand (https://code.claude.com/docs/en/plugins/loading, read 2026-10-02).

**Repository-level, cross-harness reproducibility is the part no vendor covers.**

### Security events that shape buyers' language

- **CVE-2025-59536:** a SessionStart hook in a cloned repository ran before trust (CVSS 8.7). CVE-2026-21852 leaked API keys through project settings (https://blog.checkpoint.com/research/check-point-researchers-expose-critical-claude-code-flaws/). A widely shared write-up is titled "I cloned a repo, it owned my machine" (https://medium.com/@SudoXploit7/i-cloned-a-repo-it-owned-my-machine-b5e8597afcb3).
- **Snyk ToxicSkills (Feb 2026):** 1,467 of 3,984 skills had flaws (36.82%). ClawHavoc compromised 1,184 ClawHub skills (https://arxiv.org/html/2605.11418v1; https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html).
- **Cloud Security Alliance research note, 6 May 2026:** recommends "restricting which registries skills may be sourced from, requiring content hash verification before loading skills", verifying "known-good publishers", and Unicode sanitisation (https://labs.cloudsecurityalliance.org/research/csa-research-note-skill-md-agent-context-poisoning-20260506/). palm does the second, third and fourth today.
- **Free scanners are everywhere:**
  - Snyk Agent Scan (https://labs.snyk.io/resources/agent-scan-skill-inspector/)
  - Cisco Skill Scanner, with SARIF output (https://cisco-ai-defense.github.io/docs/skill-scanner)
  - skills.sh audits by Gen, Socket and Snyk on every install, which warn but do not block (https://vercel.com/changelog/automated-security-audits-now-available-for-skills-sh, 17 Feb 2026)

### Registries and paid products

| Product | Facts | Source |
|---|---|---|
| Tessl | Raised $125M (2024). "Package manager for agent skills" since Jan 2026, with 3,000+ evaluated skills. Plans: Free $0, Team $100/month, Enterprise custom ("install and publish policies, plus mandate org standard skills", "audit logs", SAML SSO). Installs are free; credits pay for reviews, evals and agent runs. | https://tessl.io/pricing/ (read 2026-10-02); https://www.calcalistech.com/ctechnews/article/b1pnxlmg1x |
| Smithery | Raised about $400K. Acquired by Arcade.dev on 5 Aug 2026. | https://tracxn.com/d/companies/smithery/__0V9FsUTLIizQPCeUJpRQnoi_JjyhL9uoi0Bx6fwSF0k |
| Runlayer | MCP and agent governance. $30M Series A on 24 Jun 2026, $42M in total. No public pricing. | https://www.hpcwire.com/aiwire/2026/06/25/runlayer-raises-30m-series-a-to-help-enterprises-become-ai-native/ ; https://www.truefoundry.com/blog/runlayer-pricing |
| skills.sh | 69,000+ skills and 2M CLI installs as of 20 Feb 2026. No monetisation. | https://vercel.com/blog/skills-night-69000-ways-agents-are-getting-smarter |

### The look-alike field and how people phrase the need

**Hacker News launches in 2026** (points and comments via the HN Algolia API):

| Launch | Date | Points | Comments |
|---|---|---|---|
| AGENTS.lock (https://news.ycombinator.com/item?id=46797831) | 28 Jan | 6 | 0 |
| A package manager for agent skills with built-in evals (https://news.ycombinator.com/item?id=46900933) | 5 Feb | 7 | 2 |
| Skv (https://news.ycombinator.com/item?id=46842219) | 1 Feb | 1 | 0 |
| ArteSync (https://news.ycombinator.com/item?id=47167513) | 26 Feb | 1 | 0 |
| Agentloom (https://news.ycombinator.com/item?id=47115813) | 22 Feb | 2 | 0 |
| Skillful (https://news.ycombinator.com/item?id=48932688) | 16 Jul | 2 | 0 |
| Capshelf, "per-project lockfiles" (https://news.ycombinator.com/item?id=49170377) | 4 Aug | 4 | 0 |
| Spm by Camunda (https://news.ycombinator.com/item?id=49639322) | 10 Sep | 4 | 0 |
| Microsoft APM (https://news.ycombinator.com/item?id=47421969) | 18 Mar | 7 | 0 |

The security database launch did better: "Agent Skills – Open Security Database" scored 36 points with 9 comments on 16 Mar 2026 (https://news.ycombinator.com/item?id=47402118).

**The words people use:**

- **Reproducibility:**
  - "npm ci equivalent", "the last missing piece for teams treating skills as proper reproducible dependencies" (https://github.com/vercel-labs/skills/issues/549, 8 Mar 2026)
  - "useless for reproducible onboarding" (skills #549, via S1)
  - "If a skill author pushes a breaking change, your setup breaks silently" (skills #11)
- **Drift:**
  - "a copy-paste nightmare" (Sentry, https://gricha.dev/blog/dotagents, 17 Feb 2026)
  - "they slowly drifted apart … I couldn't tell which copy was current" (Capshelf, 4 Aug 2026)
  - "split brain problems when different team members use different tools" (@tobi, 25 Aug 2026, via S1)
- **Security:**
  - "a new (and very scary) supply-chain attack vector" (gricha.dev)
  - "Installing npm modules seems similar … how do you build something worthy of people's trust?" (HN 47402118)
  - The sceptical counterpoint: "it's the same as if you had engineers copy and pasting commands into the terminal" (same thread)
- **Dependency bots:** Renovate shipped an `apm.yml` manager in v44.59.0 (3 Sep 2026, https://github.com/renovatebot/renovate/discussions/42507). Teams want dependency bots to cover agent config.

## 3. The seven directions

Each direction gets the same six points: the pitch, who adopts or pays, what exists, what palm would add or remove, the convergence risk, and a verdict.

### (1) "npm ci for agent config": team reproducibility and a CI gate as the headline

**Pitch:** "Every clone, every teammate and every CI run has the same agent setup for every harness, and CI fails the moment it drifts."

**Who adopts:**
- the team lead or DevEx engineer who owns `.claude/`, `.codex/` and `.cursor/` in a shared repository
- platform teams with mixed Claude and Codex fleets
- open-source maintainers whose contributors use different harnesses

**Who pays:** nobody directly. Adoption is the return. The price anchors are Tessl Team at $100/month, and the team controls that come with Cursor, Copilot and Claude seats.

**What exists:**
- **APM** is the full rival. It has the same promise ("One file describes every agent's context; one command reproduces it everywhere"), committed deployed files, `audit --ci` with GitHub rulesets, `microsoft/apm-action`, and Renovate support. It is broad but unstable: 74% of recent release-note PRs are fixes, and a contribution reset followed.
- **dotagents** has the same shape for skills, hooks and MCP servers, but is small (9.6k downloads a week).
- **skills** has a lock but no restore (#549 and #283 are open).
- **`gh skill`** pins in frontmatter only.
- **spm, Capshelf and AGENTS.lock** are tiny.

**What palm would add:**
- a GitHub Action (`palm check --strict` with annotations)
- a Renovate manager for `palm.yaml` refs, with the story "a bot can propose a bump, only a human can say yes to a changed program"
- `import skills-lock.json | apm.yml`, planned for 0.3
- the CRLF and `eol=lf` fix (Jan O1)
- Windows support (PLAN §10.1)
- the CI guide as the docs' front door

**What palm would remove or de-emphasise:**
- "package manager" as the lead noun (the npm description says "Package manager for agent resources")
- the global scope and `create` from the headline
- keep Gemini and OpenCode marked unverified

**Convergence risk: medium.**
- Each vendor ships fleet-level distribution for its own harness only.
- Agent Plugins leaves installation and versioning to clients.
- No vendor has a reason to write a rival's files or to check them in CI.

The real threats:
- APM, with Microsoft and the GitHub ecosystem behind it, already sells this.
- GitHub could add a lock to `gh skill`.
- A future Agent Plugins version could standardise hooks, agents and a lockfile. That would erode the translation half but not the verification half.

**Verdict:** the headline. The product already does it, and the 0.2 personas recommend it for this job.

### (2) Security and consent, pitched at platform and security teams

**Pitch:** "No hook or MCP server reaches your repo without a review whose yes is pinned to the bytes, and CI fails on any program nobody approved."

**Who adopts:** security-minded platform engineers and AppSec reviewers of AI tooling.

**Who pays:** security budgets go to scanners and gateways, not to installers:
- Runlayer, $42M raised, no public price
- Snyk Agent Security and Agent Guard (https://snyk.io/blog/snyk-vercel-securing-agent-skill-ecosystem/)
- free tools from Snyk, Cisco and Vercel's partners

**What exists:**
- APM's trust ladder with `exec_status` in the lock and Unicode scanning (https://microsoft.github.io/apm/enterprise/security/)
- Codex managed hooks and `allow_managed_hooks_only`
- Claude Code `allowManagedHooksOnly` and workspace trust
- dotagents' trust allowlist by GitHub org, repository or domain (https://docs.sentry.io/ai/dotagents/)
- Gemini's consent screen, which lists commands (R4)

**The claim "the only tool that reviews, hashes and gates executable agent content" is false as written.** APM gates executables and records approvals in its lock. What palm can defend:
- a per-program hash over the command and every script byte, for git sources too
- default no, with the script viewer and an update diff
- `--allow-exec id=hash` in CI
- `check --strict` on programs nobody explains, which I found in no other manager

**What palm would add:**
- SARIF output from `check` for GitHub code scanning
- a recorded "who said yes" (Sofia S3 S9; until then, document CODEOWNERS on `palm.lock.yaml` and `.palm/assets/**`)
- an optional step that runs an external scanner in CI, so palm stays "runs nothing"
- the published threat model and the Strix results (PLAN §10.2)

**Do not add** a scanner of its own (PLAN §6 already rules out prose injection scans).

**Convergence risk: high.**
- Vendors add trust gates with each release, and scanners are free.
- Hooks committed to a repository are exactly the CVE-2025-59536 vector.
- A teammate's harness runs palm's committed hooks after workspace trust, outside palm's prompt. The real gate for everyone but the installer is the pull request review plus `palm check`. The pitch has to say so, or a security buyer will find it.

**Verdict:** the second message and the reason to choose palm. It is not the headline audience. Sofia: "Not yet as 'the' security gate."

### (3) Migration and adoption layer: APM, skills.sh and hand-written folders to a managed setup

**Pitch:** "Point palm at the skills, rules and hooks you already have; it adopts them with a zero diff and pins them."

**Who adopts:**
- teams with `skills-lock.json` and no restore (skills had 6.5M downloads a week)
- APM users tired of churn
- the roughly 11.7% of active repositories with hand-written agent config

**Who pays:** nobody. Migration is a one-time event.

**What exists:**
- APM's "migrate from npx skills" page, which is shadowed by a redirect (R1)
- rulesync `import`
- dotagents `sync`
- `skills experimental_install`

**What palm has:** byte-identical adoption (Jan's 26 APM files with a zero diff; Sridhar: "migrate now safe"), and reading of APM packages, marketplaces and plugin manifests.

**What is missing:** the `import` command (0.3), and Chris's "still not yet" for skills.sh migrants.

**Convergence risk: low.** Vendors do not import from rivals. The pool shrinks as people settle on a tool.

**Verdict:** build it as the on-ramp to (1), not as a positioning of its own.

### (4) A compatibility layer that vendors and tools consume: SDK, installing MCP server, GitHub Action

**Pitch:** "One API to write skills, hooks and MCP servers into any harness."

**Who adopts:** vendors that ship their own skill or MCP server (Context7, Neon, Sentry) and tool builders.

**Who pays:** nobody. They already use MIT libraries.

**What exists:**
- `agent-install`: 3.1M downloads a week, with a Node API (`installSkillsFromSource`, `installMcpServer`, `upsertAgentsMdSection`) (https://github.com/millionco/agent-install)
- `add-mcp`: 213k a week
- Agent Plugins 1.0, which removes the need to translate skills and MCP servers
- harnesses that read each other's `.agents/skills` and `AGENTS.md` (S1)
- MCP servers that let the agent install skills (SkillsMP MCP, skills-mcp)
- GitHub Actions: `microsoft/apm-action` and "Agent Sync Action" (https://github.com/marketplace/actions/agent-sync-action)

**What palm would add:**
- an SDK: a frozen public API, semver and docs. That is expensive for one maintainer, and `API.md` today is internal.
- an installing MCP server: this conflicts with palm's model. An agent-driven install has no terminal and should end in `E_UNTRUSTED_EXEC`.
- a GitHub Action: small, and it directly serves (1).

**Convergence risk: very high** for the translation layer.

**Verdict:**
- Ship the Action, and make the PLAN §10.4 "verified against version X on date Y" compatibility matrix public as proof.
- Skip the SDK and the MCP server.

### (5) A hosted registry or marketplace

**Pitch:** "Find and install vetted skills and plugins for every harness."

**Who pays:** no one has shown it pays.
- Smithery sold after raising about $400K.
- Tessl funds its registry from $125M and charges for evals and agent runs, not installs.
- Vercel runs skills.sh as a loss leader with three security partners.
- ClawHub became a malware channel, with 1,184 malicious skills and a purge.

**What exists:** skills.sh, Tessl, the Anthropic directory (2,000+ plugins and connectors, https://www.bleepingcomputer.com/news/artificial-intelligence/anthropic-turns-claude-into-an-ai-marketplace-with-2-000-plus-plugins-and-connectors/), the Cursor marketplace, the GitHub MCP Registry and the official MCP registry.

**What palm would add:** hosting, ranking, moderation and malware response. That reverses the 0.2 decision to remove the registry client (PLAN §6: F003, F089–F097).

**Convergence risk: extreme.**

**Verdict: a mistake.** At most, link to GitHub code search in error hints, as palm already does.

### (6) An org-policy product (allow lists, required skills, audit trails) sold to companies

**Pitch:** "Decide which skills, hooks and MCP servers every repo may use, require a baseline, and audit it."

**Who pays:** enterprises, but they already get this with their seats:
- Claude Code managed settings: allowlist, blocklist, force-enable, `allowManagedHooksOnly`, OTel, and the Analytics API on Enterprise
- Codex `requirements.toml`
- Copilot enterprise-managed plugins
- Cursor team marketplaces with Required and Default On
- APM `apm-policy.yml`, free, with tighten-only inheritance (https://microsoft.github.io/apm/enterprise/apm-policy/)
- Tessl Enterprise
- Runlayer

**What palm would add:** a policy format, inheritance, a server, SSO, audit storage, a sales motion, and telemetry. Telemetry contradicts "palm sends no telemetry".

**Convergence risk: extreme.** Every major vendor shipped this in 2026.

**One narrow opening, for later:** vendor policies work per harness and per machine. None of them answers "which of our 300 repositories commit which hooks and MCP servers, across harnesses, and are they approved?" A later cross-repository inventory built from `palm check --json` in CI could answer it without a server. Consider it only after (1) has users.

**Verdict: a mistake** as a product now.

### (7) Staying a personal dotfiles tool

**Pitch:** "Your skills, agents and MCP servers on every machine and every harness."

**Who adopts:** individual power users (Raj, Dmitri).

**Who pays:** nobody.

**What exists:**
- chezmoi and stow guides (https://github.com/ChenChiWang/ai-agent-chezmoi; https://www.frxiaobei.com/en/posts/2026/04/chezmoi-claude-code/, Apr 2026)
- claude-code-dotfiles repositories
- Plexus and ai-rules-sync
- `skills -g`
- Claude Code's plugins synced from claude.ai, which follow the account to every machine (Claude Code v2.1.273+, https://code.claude.com/docs/en/plugins/loading)

**What palm has:** `-g` with token paths, `applied.yaml`, and the 0600 literal rule.

**Convergence risk: high** for single-harness users, and Claude Code is the main tool for 31% of developers.

**Verdict:** keep it, mention it once, and do not lead with it.

## 4. Ranking by expected value and effort

| Rank | Direction | Expected value | Effort from 0.2.0 | Vendor risk | Role |
|---|---|---|---|---|---|
| 1 | (1) Team reproducibility and CI gate | high | low: messaging, Action, docs front door | medium | **headline** |
| 2 | (2) Consent for programs | high as a differentiator, low as a market | low to medium: SARIF, CODEOWNERS docs, threat model, pentest | high | **second message** |
| 3 | (3) Migration on-ramp | medium | medium: import, CRLF fix, Windows | low | **on-ramp** |
| 4 | (4a) GitHub Action and public compatibility matrix | medium | low to medium (PLAN §10.4 already planned) | n/a | **distribution and proof** |
| 5 | (7) Dotfiles | low | none, already built | high | footnote |
| 6 | (4b) SDK or installing MCP server | low | high | very high | don't |
| 7 | (6) Org-policy product | low for palm | very high | extreme | don't, revisit an inventory later |
| 8 | (5) Hosted registry | negative: cost plus malware liability | very high | extreme | don't |

## 5. Recommendation in plain words

1. **Say what stays true when vendors converge.** Copying a skill into six folders is losing value: harnesses read each other's folders, and Agent Plugins standardises skills and MCP servers. What no vendor will build is a check, in your repository's own CI, that the agent setup everyone commits is pinned, unchanged and approved for every harness. Make that the first sentence.
2. **Name the reader.** It is the person who owns the agent setup of a shared repository, where at least two harnesses are in use. The commonest case is Claude Code plus Codex.
3. **Use consent as the proof that palm is careful,** not as a security product.
   - Say "your yes is pinned to the bytes", and do not say "the only".
   - Say plainly that committed hooks run on teammates' machines after workspace trust. The pull request review plus `palm check` is the gate there.
4. **Ship three small things before any new kind of product:**
   - a GitHub Action that runs `palm check --strict`
   - `import skills-lock.json | apm.yml`
   - a Renovate manager or recipe

   Then fix what blocks teams: CRLF, Windows, and recording who consented.
5. **Leave the market to vendors where vendors win.** Do not build a registry, an org-policy server, or an installing MCP server. Keep the global scope as a quiet feature.
6. **Change the first line of the docs and npm.**
   - The docs hero says "One setup for every coding agent." That is translation-first and could describe any of the look-alikes.
   - The npm description says "Package manager for agent resources". That invites comparison with registries and dependency resolution, which palm deliberately lacks.

## 6. Positioning for the top option

**Tagline:**

> The same agent setup in every clone, checked in CI.

Alternatives, if the harness names must be in the line:
- "Pinned, reviewed agent setup for Claude Code, Codex, Copilot and Cursor."
- "Your repo's skills, hooks and MCP servers: pinned, reviewed, checked in CI."

**One-paragraph description:**

> palm installs skills, subagents, rules, hooks and MCP servers from git repositories into the files that Claude Code, Codex, Copilot, Cursor, Gemini CLI and OpenCode already read, in each tool's own format. You commit what it writes, so a teammate's clone and every CI run hold the same setup without installing palm. A lock pins every source to a commit, and `palm check` fails the pull request when a file drifts from its source, a secret lands in a tracked file, or a hook or MCP server appears that nobody approved. Anything that runs a program is shown to you first, command by command and script by script, and your yes is stored as a hash in the lock: teammates and CI reuse it, and a changed byte asks again.

**First three README bullets:**

- **One pull request sets up every agent.** `palm install <owner/repo> <names>` writes each harness's native files for the targets in `palm.yaml`. You commit them with the lock, and a teammate's clone works with no palm run.
- **CI proves it still matches.** `palm check` recomputes every generated file from the lock, and fails on drift, a moved source or a committed secret. With `--strict` it also fails on any hook or MCP server that no lock entry explains.
- **Programs need a yes you can read.** Hooks and stdio MCP servers are shown before they land. Your yes is a hash over the commands and every script byte, recorded in the lock and replayed for teammates and CI, and any change asks again.

**Words to use** (they match how people search and complain): same setup, every clone, pinned, lock, CI, drift, review, approved, Claude Code, Codex. Use "npm ci" once in the body, as "like `npm ci`, except the files are committed, so nobody has to run it." That is the phrase in skills #549's title, and it sets up palm's advantage.

**Words to avoid:**
- "package manager" as the lead noun
- "the only"
- "secure" or "secure by default" (APM's line)
- "registry", "marketplace", "npm for agents"
- "one setup for every coding agent" (translation-first)

**Proof to ship next, in order:**
1. a `PalionTech/palm-action` running `check --strict`
2. the CI guide as the second link on the landing page
3. a recorded capture of `check` failing on a hand-added hook
4. `import` for skills-lock.json and apm.yml
5. a Renovate recipe
6. the public "verified against" matrix from the compatibility job

## 7. Sources

All were read on 2026-10-02 unless another date is given. Publication dates are in parentheses.

**Project and earlier research**
- palm README and PLAN.md at f153855. CHANGELOG 0.2.0. `docs/src/content/docs/index.mdx`, `guides/ci.mdx`. `test/engine/check-fix2.test.ts` (`check --strict` on foreign hooks).
- `study/FINDINGS.md` §5 and `study/FINDINGS-v3.md`, with `study/reports-v3/{sofia,omp,keybase,kenji,mei,inbound,raj}.md`.
- `research/R1-apm-product.md`, `R3-apm-bugs.md`, `R4-competitors.md` (2026-09-28) and `S1-user-critiques.md` (2026-09-29).

**Download and star counts**
- npm downloads API, week 2026-09-24 to 09-30: `https://api.npmjs.org/downloads/point/last-week/<pkg>` for skills, agent-install, rulesync, add-mcp, @sentry/dotagents, @tessl/cli and @paliontech/palm.
- GitHub API for microsoft/apm (3,928★, v0.33.0 on 2026-10-02), vercel-labs/skills (32,985★), dyoshikawa/rulesync (1,491★), getsentry/dotagents (241★) and stacklok/toolhive (2,231★).

**Demand and user language**
- https://github.com/vercel-labs/skills/issues/549 (2026-03-08, open, 47 reactions); #283 (open, 56); #155 (open, 35); #11 (open, 27).
- https://maier.tech/notes/a-lockfile-for-agent-skills (2026-03-19)
- https://gricha.dev/blog/dotagents (2026-02-17)
- https://docs.sentry.io/ai/dotagents/
- https://camunda.github.io/spm-cli/
- https://github.com/renovatebot/renovate/discussions/42507 (opened 2026-04-09; shipped in v44.59.0 on 2026-09-03)
- HN items via the Algolia API: 46797831, 46900933, 46842219, 47167513, 47115813, 48932688, 49170377, 49639322, 47421969, 47402118, 47183167 and 49203443.

**Standards and vendors**
- https://thenextweb.com/news/openai-agent-plugins-open-standard-skills-mcp (2026-08-06)
- https://blakecrosley.com/blog/agent-plugins-standard (2026-08-06)
- https://github.blog/changelog/2026-08-12-agent-plugins-1-0-in-vs-code-copilot-cli-and-the-copilot-app/ (2026-08-12)
- https://github.blog/changelog/2026-05-06-enterprise-managed-plugins-in-github-copilot-cli-are-now-in-public-preview/ (2026-05-06)
- https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/ (2026-04-16)
- https://cursor.com/changelog/2-6 (2026-03-03)
- https://forum.cursor.com/t/cursor-2-6-team-marketplaces-for-plugins/153484
- https://code.claude.com/docs/en/plugins/org
- https://code.claude.com/docs/en/plugins/loading
- https://developers.openai.com/codex/enterprise/managed-configuration
- https://www.theregister.com/ai-and-ml/2026/09/18/anthropic-decides-to-support-openais-markdown-instructions-spec/5297588 (2026-09-18)
- https://github.com/microsoft/apm
- https://microsoft.github.io/apm/enterprise/security/
- https://microsoft.github.io/apm/enterprise/drift-detection/
- https://microsoft.github.io/apm/enterprise/apm-policy/
- https://github.com/microsoft/apm-action
- https://github.com/millionco/agent-install
- https://github.com/marketplace/actions/agent-sync-action

**Security**
- https://blog.checkpoint.com/research/check-point-researchers-expose-critical-claude-code-flaws/
- https://medium.com/@SudoXploit7/i-cloned-a-repo-it-owned-my-machine-b5e8597afcb3
- https://arxiv.org/html/2605.11418v1 (May 2026)
- https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html (Feb 2026)
- https://labs.cloudsecurityalliance.org/research/csa-research-note-skill-md-agent-context-poisoning-20260506/ (2026-05-06)
- https://labs.snyk.io/resources/agent-scan-skill-inspector/
- https://snyk.io/blog/snyk-vercel-securing-agent-skill-ecosystem/
- https://vercel.com/changelog/automated-security-audits-now-available-for-skills-sh (2026-02-17)
- https://cisco-ai-defense.github.io/docs/skill-scanner

**Registries and paid products**
- https://tessl.io/pricing/
- https://www.calcalistech.com/ctechnews/article/b1pnxlmg1x (2024)
- https://tracxn.com/d/companies/smithery/__0V9FsUTLIizQPCeUJpRQnoi_JjyhL9uoi0Bx6fwSF0k
- https://www.hpcwire.com/aiwire/2026/06/25/runlayer-raises-30m-series-a-to-help-enterprises-become-ai-native/ (2026-06-25)
- https://www.truefoundry.com/blog/runlayer-pricing
- https://vercel.com/blog/skills-night-69000-ways-agents-are-getting-smarter (2026-02-20)
- https://www.bleepingcomputer.com/news/artificial-intelligence/anthropic-turns-claude-into-an-ai-marketplace-with-2-000-plus-plugins-and-connectors/

**Adoption**
- https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/ (Aug 2026)
- https://arxiv.org/abs/2605.08435 (2026-05-08)

**Dotfiles**
- https://github.com/ChenChiWang/ai-agent-chezmoi
- https://www.frxiaobei.com/en/posts/2026/04/chezmoi-claude-code/ (Apr 2026)
