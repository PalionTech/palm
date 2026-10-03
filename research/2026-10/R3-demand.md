# R3: Is managing agent config across harnesses and teams a real, growing demand?

Research date: 2026-10-02. Window: 2025-10-01 to 2026-10-02, unless an older item is still the live reference.

**Sources**
- GitHub issues on the seven harness repos (`gh api`, title and full-text search, ranked by reactions):
  - anthropics/claude-code
  - openai/codex
  - github/copilot-cli
  - google-gemini/gemini-cli
  - anomalyco/opencode (formerly sst/opencode)
  - earendil-works/pi (formerly badlogic/pi-mono)
  - cursor/cursor
- Hacker News stories and comments, through Algolia.
- Reddit, through the Arctic Shift archive. Scores lag, so treat them as lower bounds.
- The Cursor forum, through Discourse JSON. Counts there are posts, not views.
- X posts, verified through fxtwitter.
- npm and PyPI download APIs.
- Surveys and papers, read in full where possible.
- Vendor changelogs.

Raw data is in `research2/R3-work/raw/`.

**Abbreviations:** r = reactions, c = comments, p = HN points. "Open 7 mo" means the issue is open and was filed 7 months before 2026-10-02.

---

## 0. Verdict

**Yes, the demand is real and growing, but it is not one market. It is three demands, and they mature at different speeds.**

1. **Portability: "one file, every harness".** This is mass-market and loud, and it is half solved by standards.
   - The single largest signal is AGENTS.md support in Claude Code:
     - [#6235](https://github.com/anthropics/claude-code/issues/6235): 6,686r
     - Thariq's launch post: 31.4k likes and 5.6M views ([X, 2026-09-18](https://x.com/trq212/status/2101009392611278961))
     - Tobi's threat to ban Claude Code at Shopify: 19.5k likes ([X, 2026-08-25](https://x.com/tobi/status/2092259436538495186))
   - Instruction files are now largely solved by convergence.
   - Skills directories, hooks and MCP are not. Claude Code still has no `.agents/skills` ([#31005](https://github.com/anthropics/claude-code/issues/31005), 526r, reopened).
2. **Team distribution: shared baseline, personal extras, private sources, updates that reach teammates.** This is a mid-size market and it is growing fast. Vendors answer it only inside their own walls.
3. **Security and governance of executable config: hooks, MCP, skills from registries.** It is incident-driven, rising steeply, and quiet on issue trackers, but loud in security press.
   - Three npm worms in 2026 used `.claude/settings.json` SessionStart hooks as persistence.
   - A skills.sh campaign reached 1.7M installs.

**Why it is not a niche:**
- 70% of engineers use 2 to 4 AI tools ([Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026), 906 respondents, 2026-03-03).
- rulesync grew 5.8x in 12 months. Ruler grew 18x.
- Vercel `skills` peaked at 47M npm downloads a month.

**Why it is not yet mainstream:**
- In February 2026, only 12.1% of repos that commit agent config did so for two or more tools.
- Hooks appeared in 1.5% of those repos ([Galster et al., AIware '26](https://assets.empirical-software.engineering/pdf/aiware26-agents-configuration.pdf)).
- About 90 Show HN config managers launched in 12 months. Their median score is 2 points.

---

## 1. Demand signals at a glance

| Signal | Number | Source, date |
|---|---|---|
| Engineers using 2 to 4 AI tools at once | 70%. Another 15% use 5 or more; 15% use one | [Pragmatic Engineer survey](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026), n=906, fielded 2026-01-27 to 02-17, published 2026-03-03 |
| Agent tools per professional developer | 263 tool selections from 99 respondents, about 2.7 each. 31 respondents describe running several agents | [Huang et al., "Professional Software Developers Don't Vibe, They Control"](https://arxiv.org/abs/2512.14012), survey Aug to Oct 2025 |
| Agent adoption at work | 90% weekly and 68% daily | [JetBrains Dev Ecosystem 2026](https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/), n>15,000, May to Jul 2026 |
| Per-tool adoption at work, May to Jul 2026 | Claude Code 39% (the main tool for only 31%), Copilot 21%, Codex 16% (3% in January), Cursor 12%, JetBrains AI 9%, OpenCode 7%, Antigravity 6% | same source |
| Implied overlap (derived) | The listed tools add up to 110% of all developers, against 90% agent use. That means at least about 1.2 named agents per agent user, as a lower bound | derived from JetBrains |
| Agent use, Stack Overflow | 31% (2025 survey). 59% in the April 2026 pulse, a smaller sample skewed to daily users | [SO blog, 2026-09-30](https://stackoverflow.blog/2026/09/30/getting-ready-for-2026-results-a-look-back-on-developer-survey-findings) |
| Repos committing config for 2 or more tools | 12.1% of 2,853 config-bearing repos: 10.3% two tools, 1.8% three or more. 17.3% use AGENTS.md only. 44.0% of Cursor repos also configure Claude | [Galster et al.](https://assets.empirical-software.engineering/pdf/aiware26-agents-configuration.pdf), mined 2026-02-02 |
| Advanced mechanisms in those repos | Context files 90.6%, settings 290 repos, rules 238, commands 169, skills 158 (5.5%), subagents 131, MCP 75 (2.6%), hooks 42 (1.5%) | same source |
| rulesync npm, per month | 173k (Oct 2025) to 999k (Sep 2026). Last week: 292,833 | api.npmjs.org |
| @intellectronica/ruler npm, per month | 15k to 279k. Last week: 84,190 | api.npmjs.org |
| Vercel `skills` npm, per month | 240k (Jan 2026), 47.5M (Jul), 27.5M (Sep). Last week: 6.5M. Inflated by npx, CI and agent-driven runs | api.npmjs.org; repo created 2026-01-14, 33.0k stars |
| @sentry/dotagents, openskills, @tessl/cli | 0 to 37k, 2k to 50k, 1k to 21k per month | api.npmjs.org |
| APM (PyPI `apm-cli`) | 74,160 last month | pypistats |
| Long-tail managers (lnai, skiller, sx, prpm, glooit, ai-rules-sync) | Under 12k a month each, most under 3k | api.npmjs.org |
| Builder supply on HN | 96 Show HNs about managing or syncing agent config (about 90 genuine). Median 2 points; only 3 scored 20 or more. 22 in January and 20 in February 2026, then 3 to 9 a month | `R3-work/raw/hn_showhn_tools_strict.tsv` |
| Biggest HN demand thread | "Ask HN: How do you manage skills files?": 320p/299c | [HN, 2026-09-06](https://news.ycombinator.com/item?id=49589914) |
| Biggest "it changed" moments | Claude Code reads AGENTS.md: HN 741p/285c, r/ClaudeAI 1,204/124, r/ClaudeCode 404/60, X 31.4k likes | 2026-09-18 |
| Release churn the config must follow | Claude Code: 315 npm releases since 2025-10-01 (2.0.3 to 2.1.288). Codex: 131 stable releases | registry.npmjs.org |

**How to read the gap between the 70% and the 12%.** Most developers run several harnesses personally, but most repos commit config for one. Two things bridge the gap: the cross-reading standard (AGENTS.md) and personal or uncommitted setup (`~/.claude`, `~/.codex`, symlinks). That is why the cheapest workarounds, symlinks and `@AGENTS.md`, win for individuals. Committed multi-harness config is still a team and OSS phenomenon.

---

## 2. Ranked demands

They are ranked by combined evidence: reaction volume, growth, severity, how widely the request recurs across harnesses, and vendor activity.

### D1. One source that every harness reads: instructions, skills, hooks, MCP
**Signal: very high. Instructions are mostly solved; skills, hooks and MCP are open.**

- **Claude Code**
  - [#6235](https://github.com/anthropics/claude-code/issues/6235) "Support AGENTS.md": 6,686r/409c. Filed 2025-08-21, closed as completed. Shipped in 2.1.277 on 2026-09-18 as a fallback when no CLAUDE.md exists.
  - [#31005](https://github.com/anthropics/claude-code/issues/31005) "Support for AGENTS.md and .agents/skills/": 526r/31c. Reopened and still open (7 mo). Its subtitle: "the community has been asking since August 2025".
  - [#16345](https://github.com/anthropics/claude-code/issues/16345) "Support the standard .agents/skills/ directory": 55r, open 9 mo.
  - [#34235](https://github.com/anthropics/claude-code/issues/34235): 134r, open.
- **Parity requests across harnesses.** Each harness asks to read the market leader's format:
  - Codex [#21753](https://github.com/openai/codex/issues/21753) "Full Claude Code Hook Parity (29+)": 50r/34c, open.
  - OpenCode [#12472](https://github.com/anomalyco/opencode/issues/12472) "Native Claude Code hooks compatibility": 41r, open 8 mo.
  - Gemini [#11506](https://github.com/google-gemini/gemini-cli/issues/11506) "Add Skill to Gemini CLI like Claude Code": 164r, closed as a duplicate.
  - Codex [#8512](https://github.com/openai/codex/issues/8512) "Codex Plugins same as Claude Plugins": 88r, closed.
- **Voices**
  - "Insisting on only reading CLAUDE.md sometimes leads to split brain problems when different team members use different tools." (@tobi, [X](https://x.com/tobi/status/2092259436538495186), 2026-08-25; 19.5k likes, 2.29M views)
  - "Still needs to read skills from .agents/skills so I can stop symlinking it." (DTanner, 81 points, the top reply on [r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1wk2q8v/), 2026-09-18)
  - "so many people are using both Claude Code and Codex, they need to stop fighting that. Creating a walled garden … isn't going to make your product last." (college_hustle, 94 points, same thread)
- **Repos.** In the Galster sample, 44.0% of Cursor repos also configure Claude. The most common pairs are Claude with Copilot (167 repos) and Claude with Cursor (144). CLAUDE.md usually came first and AGENTS.md was added later.
- **New side effect: double and phantom loading.** Each harness now reads the others' files:
  - Cursor "double-counts symlinked files in Context Explorer (e.g. CLAUDE.md + AGENTS.md)" ([forum](https://forum.cursor.com/t/cursor-double-counts-symlinked-files-in-context-explorer-e-g-claude-md-agents-md/164295), 2026-06-29).
  - Cursor "loads CLAUDE.md even when the 'third party rules' toggle is turned off" ([forum](https://forum.cursor.com/t/cursor-loads-claude-md-even-when-the-third-party-rules-toggle-is-turned-off/149974), 2026-01-26).
  - VS Code 1.109 (2026-02-04) runs the hooks in `.claude/settings.json` (from research2/notes-A).
- **Still open:** a shared skills directory for Claude Code; hook format parity; MCP config parity ([MCP#292](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/292) "Define a Standard MCP Configuration Schema", 50r, open 18 mo); and loading each entity exactly once.

### D2. Team and org distribution: private sources, org-wide defaults, a shared baseline
**Signal: high and growing.** Vendors answer it only inside their own ecosystems.

- **Claude Code**
  - [#28729](https://github.com/anthropics/claude-code/issues/28729) "Link a source control repo as the source for organization skills": 159r/39c, open 7 mo.
  - [#14467](https://github.com/anthropics/claude-code/issues/14467) "Organization-wide shared CLAUDE.md via GitHub org": 48r, open 9.5 mo.
  - [#4800](https://github.com/anthropics/claude-code/issues/4800) "Add extends field to settings.json for shared configuration inheritance": 25r, open 14 mo.
  - [#48322](https://github.com/anthropics/claude-code/issues/48322) "Team/Enterprise: shared routines": 61r, open.
  - [#16870](https://github.com/anthropics/claude-code/issues/16870) "`extraKnownMarketplaces` in `managed-settings.json` is ignored": 14r, open 9 mo.
  - [#45323](https://github.com/anthropics/claude-code/issues/45323) "Auto-install plugins from org managed settings": 20r, closed as **not planned** on 2026-06-21.
  - [#28125](https://github.com/anthropics/claude-code/issues/28125) "Cowork can't add private GitHub marketplace": 36r/39c, open.
- **Other harnesses**
  - Codex [#18115](https://github.com/openai/codex/issues/18115) "Repository-scoped marketplace and plugin configuration in project config": 67r, open 5.5 mo.
  - Copilot: [community#179641](https://github.com/orgs/community/discussions/179641) "Scalable Organization-Wide Copilot Instructions for Multi-Repository Organizations": 36 upvotes, unanswered for 10.5 mo.
  - Copilot shipped repo-scoped plugins ([#1665](https://github.com/github/copilot-cli/issues/1665), completed 2026-07-06) and repo-level MCP ([#1291](https://github.com/github/copilot-cli/issues/1291), completed 2026-04-07).
  - Cursor shipped Team Rules (October 2025) and Team Marketplaces (2.6, [forum, 33 posts](https://forum.cursor.com/t/cursor-2-6-team-marketplaces-for-plugins/153484), 2026-03-03). Breakage threads followed: a private-marketplace install fails three ways ([2026-04-28](https://forum.cursor.com/t/private-team-marketplace-plugin-install-fails-on-3-2-11-three-stage-clone-fallback-all-broken/159257)), and a team licence can't add a private marketplace ([2026-08-17](https://forum.cursor.com/t/cant-add-private-marketplace-with-team-license/168678)).
- **Managers**
  - Vercel `skills` [#381](https://github.com/vercel-labs/skills/issues/381) "Official support for private skills": 82r, completed on 2026-09-11.
  - [#699](https://github.com/vercel-labs/skills/issues/699), the telemetry leak of private skill metadata, is still open.
- **Voices**
  - "we're in this weird transition phase where none of the major AI tool providers are really focusing much on team use of their stuff … A central repository of company skills is merely our way of improvising a solution." (jillesvangurp, [HN](https://news.ycombinator.com/item?id=49170811), 2026-08-04)
  - On an 80+ developer monorepo: "there were ~no shared skills … I maintained my own set of skills … it was like the old days of manage your own stuff." On the next project: "we had vendoring set up to distro skills automatic[ally]". (bredren, [HN](https://news.ycombinator.com/item?id=48962163), 2026-07-18)
  - "how quickly even small teams end up with config sprawl - and how much a manifest that travels with the project helps" (dmppch, an APM author, [HN](https://news.ycombinator.com/item?id=47494948), 2026-03-23)
  - "Do I gatekeep these skills or share with wider team?" drew 88 comments ([r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1tzlq8w/), 2026-06-07). Top answer, 72 points: "Share it, but own the rollout." Another, 4 points: "Formalize it as part of the review process."
- **Products:** Sx ("Share AI skills with your team through a Dropbox folder"): 44p/33c ([HN](https://news.ycombinator.com/item?id=48900319), 2026-07-13). The earlier Sx launch scored 50p/28c.

### D3. Executable config that is safe to share: consent, provenance, pinning against rug pulls
**Signal: high severity and rising steeply.** Issue trackers barely show it. Incidents and security vendors carry it (see §4).

- **The attack class is now standard worm tradecraft.** Three npm campaigns in 2026 wrote a SessionStart hook into `.claude/settings.json`, so the malware ran again whenever someone opened Claude Code in the repo. ChainDrop also pushed the payload into other repositories with stolen GitHub credentials:
  - SAP-related packages (2026-04-29)
  - Mini Shai-Hulud/AntV, 637 versions across 323 packages (2026-05-19)
  - ChainDrop/keyv, 400+ packages (2026-08-04)
- **The vendors' consent models differ:**
  - **Codex** pins trust to a hash: "Codex records trust against the hook's current hash, so new or changed hooks are marked for review and skipped until trusted" ([docs](https://learn.chatgpt.com/docs/hooks)).
  - **Claude Code** gates on folder trust. Hooks then run "automatically whenever it starts a session in that repository — no separate prompt" ([DEV, 2026-08-23](https://dev.to/ramdai_bista/a-supply-chain-worm-wrote-itself-into-claude-codes-hook-files-to-survive-credential-rotation-5ce4)). Its changelog adds enterprise kill switches (`allowManagedHooksOnly`, `disableAllHooks`, a `ConfigChange` hook in 2.1.49 on 2026-02-19) but no re-approval when hooks change.
  - **Copilot CLI**: "Repo-level hooks are loaded only after folder trust is confirmed" (changelog). [#3697](https://github.com/github/copilot-cli/issues/3697) "Add an option to disable repository hooks to reduce config-injection risk" has 4r and is open.
- **Consent fatigue pulls the other way.** Users upvote *fewer* prompts:
  - Claude [#23109](https://github.com/anthropics/claude-code/issues/23109) "Trusted workspace patterns to skip trust prompt for git worktrees": 93r, completed.
  - Codex [#14599](https://github.com/openai/codex/issues/14599) "Allow trust_level = 'trusted' for any projects": 69r, reopened.
  - Codex [#19426](https://github.com/openai/codex/issues/19426) "Support recursive trusted project roots": 35r.
  - The demand is therefore for *smart* consent: pinned, prompting only on change, and per program.
- **Registries:**
  - Zenity: one skills.sh family of typosquatted clones that later turned malicious reached 1.7M installs. It was taken down within 12 hours ([TNW, 2026-08-07](https://thenextweb.com/news/zenity-malicious-ai-skills-1-7m-installs-supply-chain-credential-theft)).
  - Snyk: critical issues in 13.4% of 3,984 skills, with 76 malicious payloads (2026-02-05, S1).
  - HN "Malicious skills targeting Claude Code and Moltbot users": 181p/87c ([2026-01-30](https://news.ycombinator.com/item?id=46827731)).
- **Opt-in for injected config:** Claude [#20412](https://github.com/anthropics/claude-code/issues/20412) "Claude.ai MCP servers auto-injected into Claude Code without opt-in": 142r, fixed on 2026-06-22.

### D4. Layers per person and per project: personal overrides, opt in and out of team entries
**Signal: high, and mostly open.** Summed across the issues below, about 470r.

- **Claude Code**
  - [#14920](https://github.com/anthropics/claude-code/issues/14920) "disable individual Claude plugin skills": 94r, open 9.5 mo.
  - [#14202](https://github.com/anthropics/claude-code/issues/14202) "Project-scoped plugins incorrectly detected as installed globally": 66r/26c, open.
  - [#18950](https://github.com/anthropics/claude-code/issues/18950) "Skills/subagents do not inherit user-level permissions": 72r, open.
  - [#17017](https://github.com/anthropics/claude-code/issues/17017) "Project-level permissions replace global permissions instead of merging": 26r, open.
  - New: [#96117](https://github.com/anthropics/claude-code/issues/96117) "CLAUDE.local.md switches off the AGENTS.md fallback, so a personal note silently drops all shared project instructions" (2026-09-22, open). This is the first casualty of D1's fix colliding with D4.
- **Codex**
  - [#26957](https://github.com/openai/codex/issues/26957) "Support AGENTS.local.md": 23r.
  - [#28739](https://github.com/openai/codex/issues/28739) "AGENTS.local overlays … provenance like Claude Code": 19r.
  - [#34328](https://github.com/openai/codex/issues/34328) "repo-committed skills opt-in per contributor (default-off)": 6r. All three are open.
  - [#14601](https://github.com/openai/codex/issues/14601) "Prevent Configuration Pollution: Separate `projects.xxxx.trusted_level` from `config.toml`": 85r, open 6.5 mo. Personal machine state pollutes the file people want to share or put in dotfiles.
- **Other harnesses and managers**
  - Cursor: "Unable to turn off the team rules while it's not been compulsory" (12 posts, 2026-01-23), and "Disabled Team Rules still loaded into context", reported twice (9 and 5 posts, May 2026).
  - Copilot [#179](https://github.com/github/copilot-cli/issues/179) "Globally configurable allowed tools": 43r, open 12 mo.
  - `skills` [#634](https://github.com/vercel-labs/skills/issues/634) enable/disable: 24r, open.
  - OpenCode [#16110](https://github.com/anomalyco/opencode/issues/16110) `.local.md` variants: closed as not planned.
- **Vendor movement:**
  - Claude Code added `defaultEnabled: false` for plugins (2.1.154, 2026-05-28) and a per-skill on/off switch in VS Code (2.1.280, 2026-09-22).
  - None of the harnesses has a per-person "off" for a committed team entry.

### D5. Reproducible versions, exact restore, and updates that reach teammates
**Signal: medium-high.** This is mostly a complaint about managers.

- **Vercel `skills`** (all open):
  - [#283](https://github.com/vercel-labs/skills/issues/283) install from the lockfile: 56r, open 8 mo.
  - [#549](https://github.com/vercel-labs/skills/issues/549) "npm ci equivalent": 47r.
  - [#155](https://github.com/vercel-labs/skills/issues/155) project lock: 35r.
  - [#11](https://github.com/vercel-labs/skills/issues/11) "[RFC] Versioning": 27r, open 8.5 mo.
- **Harnesses**
  - Claude [#10265](https://github.com/anthropics/claude-code/issues/10265), plugin auto-update (65r), is completed: Claude Code shipped version constraints and auto-update to the highest satisfying git tag (2.1.116 to 2.1.119, April 2026). But [#14061](https://github.com/anthropics/claude-code/issues/14061) "/plugin update does not invalidate plugin cache" (33r/25c) and [#73673](https://github.com/anthropics/claude-code/issues/73673) "personal git-marketplace plugins never auto-update" are both open.
  - Copilot [#1296](https://github.com/github/copilot-cli/issues/1296) "Installing plugins from a specific branch or tag": 22r, open.
  - Copilot [#2734](https://github.com/github/copilot-cli/issues/2734) per-plugin auto-update: 13r, open. [#1709](https://github.com/github/copilot-cli/issues/1709) was completed on 2026-08-04.
  - OpenCode [#6159](https://github.com/anomalyco/opencode/issues/6159) plugin auto-update: not planned.
  - APM [#639](https://github.com/microsoft/apm/issues/639) Renovate support: completed on 2026-09-05.
- **Why pinning matters now:** the Zenity campaign was a *rug pull*. Skills built up trust with clean behaviour and were made malicious afterwards. Auto-update without review is the delivery channel.

### D6. Context budget and selective loading
**Signal: medium-high.** The MCP side is mostly solved by vendors; skills are open.

- **MCP context bloat (now solved).** These were the biggest items, and all closed as completed in March 2026:
  - Claude [#6915](https://github.com/anthropics/claude-code/issues/6915) MCP tools only for subagents: 377r
  - [#7328](https://github.com/anthropics/claude-code/issues/7328) tool filtering: 225r
  - [#4476](https://github.com/anthropics/claude-code/issues/4476) agent-scoped MCP: 183r
  - OpenCode [#8625](https://github.com/anomalyco/opencode/issues/8625) and Codex [#9266](https://github.com/openai/codex/issues/9266) MCP tool search (85r and 31r) are closed too.
- **Skill budgets (still open)**
  - Codex [#19679](https://github.com/openai/codex/issues/19679) "skills metadata context budget configurable instead of hardcoded 2%": 40r, open.
  - Copilot [#1464](https://github.com/github/copilot-cli/issues/1464) "skills beyond … ~32 appear unreachable": open.
  - Claude [#14882](https://github.com/anthropics/claude-code/issues/14882) "Skills consume full token count at startup": 20r, open.
  - Claude [#12633](https://github.com/anthropics/claude-code/issues/12633) subagent-only skills: 29r, open.
  - Claude [#37793](https://github.com/anthropics/claude-code/issues/37793) subagents fail when MCP tool definitions exceed 200k: 27r/22c, open.
- **Vendor acknowledgement:** Claude Code now prints how many skill descriptions were truncated (2.1.178, 2026-06-15) and shows each skill's token estimate in VS Code (2.1.280).
- **Community**
  - "I mapped my AI coding setup – 90 of 103 installed skills never fire" ([Show HN](https://news.ycombinator.com/item?id=49004966), 2026-07-22).
  - "Skillctl – audit context cost and conflicts across your agent skills" (2026-09-10).
  - Vercel's "AGENTS.md outperforms skills in our agent evals" drew 524p/196c ([HN](https://news.ycombinator.com/item?id=46809708), 2026-01-29).

### D7. Your own setup on every machine
**Signal: medium-high.** This is a solo-developer demand.

- **Claude Code**
  - [#20697](https://github.com/anthropics/claude-code/issues/20697) "Sync Skills between Claude Desktop and Claude Code CLI": 167r/50c, open 8 mo. Partly answered by claude.ai skill and plugin sync to the terminal (2.1.275, 2026-09-17).
  - [#22648](https://github.com/anthropics/claude-code/issues/22648) "Account-level settings sync across devices": 48r.
  - [#25739](https://github.com/anthropics/claude-code/issues/25739) "Portable project memory across machines": 42r.
- **Codex**
  - [#11061](https://github.com/openai/codex/issues/11061) "Easily share user preferences across machines": 91r, open 8 mo.
  - [#5160](https://github.com/openai/codex/issues/5160) "Make config.toml sharable across machines": completed.
  - [#14601](https://github.com/openai/codex/issues/14601) (trust state in config.toml, D4).
- **Friction for dotfiles managers**
  - Claude [#1455](https://github.com/anthropics/claude-code/issues/1455) "does not respect the XDG Base Directory specification": 453r, open 16 mo.
  - "Pi coding agent: config folder is out of place on Linux": HN 56p ([2026-08-17](https://news.ycombinator.com/item?id=49328206)).
- **Voices and tools**
  - "you need a global AGENTS file. I keep mine in a dev folder, and symlink to: ~/CLAUDE.md … ~/AGENTS.md" (@linuz90, [X](https://x.com/linuz90/status/2021534838466175225), 2026-02-11, 460 likes)
  - Show HN tools: Dotclaude, Claude-Config ("Dotfiles for Claude Code"), pi-sync, sync-conf.dev. Each scored 3 points or fewer.

### D8. Monorepos, nested scopes and composition
**Signal: medium.** Most of this is the harness's job, not a manager's.

- **Codex**
  - [#12115](https://github.com/openai/codex/issues/12115) "Dynamically loading nested AGENTS.md": 119r, open 7.5 mo.
  - [#6038](https://github.com/openai/codex/issues/6038) "include files in AGENTS.md": 37r, open 11 mo.
  - [#17401](https://github.com/openai/codex/issues/17401) "@include directive": 26r.
- **Claude Code**
  - [#12962](https://github.com/anthropics/claude-code/issues/12962) "Settings.json parent directory traversal for monorepos": 70r, open 10 mo.
  - [#26489](https://github.com/anthropics/claude-code/issues/26489) "skills/, agents/, commands/ should traverse parent directories": 50r.
  - [#90450](https://github.com/anthropics/claude-code/issues/90450) "Auto Mode … silently disables nested CLAUDE.md and path-scoped rules": 48r, open.
- **Cursor:** "AGENTS.md leaks into other repositories in multi-repo workspace" ([forum](https://forum.cursor.com/t/agents-md-leaks-into-other-repositories-in-multi-repo-workspace/155477), 2026-03-21).

### D9. Placement that survives symlinks, worktrees and Windows
**Signal: medium.** This is a symptom of D1 and D7: people symlink because the harnesses disagree on folders.

- **Claude Code**
  - [#14836](https://github.com/anthropics/claude-code/issues/14836) skills in symlinked directories: 52r, open 9.5 mo.
  - [#28041](https://github.com/anthropics/claude-code/issues/28041) `--worktree` doesn't copy `.claude/` subdirectories: 26r.
  - [#34437](https://github.com/anthropics/claude-code/issues/34437) worktrees should share the project directory: 46r.
  - [#66559](https://github.com/anthropics/claude-code/issues/66559) "refuses to write CLAUDE.md when it's a symlink": new, 12r.
- **Codex** [#8369](https://github.com/openai/codex/issues/8369) symlinked skills (59r) was fixed in January 2026. [#27133](https://github.com/openai/codex/issues/27133) "project-level .codex/hooks.json is silently ignored … inside a git worktree" is open.
- **Cursor:** 14 forum threads between December 2025 and August 2026 have "symlink" in the title, and 9 of them report symlinked rules, skills or plugins not being found or loaded. Examples: [2025-12-11](https://forum.cursor.com/t/cursor-no-longer-can-follow-symlinks-to-rules-mdc-files/146010), [2026-01-23](https://forum.cursor.com/t/cursor-doesnt-follow-symlinks-to-discover-skills/149693), and [Windows, 2026-04-30](https://forum.cursor.com/t/local-plugins-symlink-on-windows-doesnt-work/159427). Also [cursor/plugins#35](https://github.com/cursor/plugins/issues/35) (14r, open).
- **Vercel `skills`** [#744](https://github.com/vercel-labs/skills/issues/744): its symlink model doesn't create the Claude links (37r, open).
- "My colleagues have expressed issues with using the symlinks for some of their applications, so we've swapped to the simpler @AGENTS.md" (KidMoxie, [r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1r9zx34/), 2026-02-20)

### D10. Keeping secrets and private notes out of shared config
**Signal: medium.** The impact is high, but users rarely raise it.

- GitGuardian found "24,008 unique secrets in public MCP configuration files, including 2,117 valid credentials". Commits assisted by Claude Code leak secrets at 3.2%, against a 1.5% baseline ([2026-09-25](https://blog.gitguardian.com/ai-coding-agents-credential-security/)).
- Shipped config leaks:
  - Apple's Support app shipped CLAUDE.md files: HN 384p/321c ([2026-05-01](https://news.ycombinator.com/item?id=47973378)).
  - Netflix's iOS app shipped a CLAUDE.md: r/cursor 205/70 ([2026-06-25](https://www.reddit.com/r/cursor/comments/1ufb4lj/)).
- Claude [#20553](https://github.com/anthropics/claude-code/issues/20553) "OAuth credentials shared across CLAUDE_CONFIG_DIR profiles … (compliance risk)": 17r, open.

---

## 3. How people keep agent config in sync today

**What HN comments mention.** In the window, 710 HN comments matched config-sync queries. Among those that mention agents, skills or harness files (classified by keyword, so approximate):

| Method | Comments |
|---|---|
| Symlink | 102 |
| Script or generator | 89 (noisy) |
| Plugin or marketplace | 44 |
| `@AGENTS.md` import or pointer | 34 |
| Dotfiles, stow, Nix or chezmoi | 28 |
| A sync tool (rulesync, ruler, APM, skills, dotagents) | 26 |
| Shared company repo or monorepo | 8 |
| Git submodule | under 6 genuine |

The same picture shows up elsewhere:
- On Reddit's AGENTS.md threads, the top answers are `@AGENTS.md` (66 and 52 points) and "just symlink" (45 and 31 points). One reply sums it up: "You shouldve known that 90% of the comments were going to be 'just symlink bro'/'@AGENTS.md'. Thats not the point … The point is to support the common standard." (rm-rf-rm, [r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1q3q8x6/), 2026-01-04)
- The earlier S1 count of the Ask HN thread found about 13 symlink comments, about 7 dotfiles/Nix comments and about 20 home-made tools.

**The patterns, with real examples:**
1. **Symlink one file into several names.**
   - "We've just had a file called `.rules` that is symlink as `AGENTS.md`, `CLAUDE.md`, etc" (wldcordeiro, [HN](https://news.ycombinator.com/item?id=49818316), 2026-09-23)
   - Apache Superset keeps one LLMs.md plus "a bunch of symlinks" (S1).
   - udecode/kitcn has 52 symlinks (S2).
   - It breaks on Windows, in Cursor, and in Claude's `/skills` (D9).
2. **A pointer file.** CLAUDE.md and GEMINI.md contain only `@AGENTS.md`. Since 2026-09-18 Claude Code needs no stub at all, unless a CLAUDE.md or CLAUDE.local.md exists (#96117).
3. **A central company repo plus a pull script or skill.**
   - jillesvangurp's "update company skills" skill, which pulls from git into `~/.codex` ([HN](https://news.ycombinator.com/item?id=49170811)).
   - "a commons repos with everything that we need to share and instruct our agents from specific repos to check there" (Poildek, [r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1u93zqh/), 2026-06-18).
   - voidmain42 gave up on "scripts and symlinks … because filtering (i.e. figuring out which files belong in each repository) and syncing became a headache" across 20+ repos, and built a daemon ([HN](https://news.ycombinator.com/item?id=49611168), 2026-09-08).
4. **Hand-sync with a written warning** (S2 census):
   - oh-my-posh: its hook files are "kept in sync by hand; generating them with APM proved unreliable in cloud sessions".
   - crbnos/carbon keeps 47 AGENTS.md and 37 CLAUDE.md files with a sync script.
   - neuronpedia keeps 5 hook scripts × 2 configs with a CI check.
5. **Vendor marketplaces**: Claude plugin marketplaces, Cursor Team Marketplaces, Copilot plugins. These are single-harness, and private-repo auth is fragile (D2).
6. **Generators and managers.** rulesync and ruler generate per-tool files from one source. Vercel `skills`, APM and dotagents install from git. All are growing (§1). The long tail of about 90 HN launches shows that nearly everyone who feels the pain first tries building their own.

**Staleness is the other half.** Committed config tends not to be maintained:
- "Anyone else find their CLAUDE.md / AGENTS.md files end up lying to the agent after a few months?" drew 89 comments ([r/cursor](https://www.reddit.com/r/cursor/comments/1uldhvv/), 2026-07-02).
- Denisov-Blanch et al. found "73.8% of artifacts are committed once and never modified" (441 repos, [arXiv 2608.25241](https://arxiv.org/abs/2608.25241), 2026-08-26). The same paper links committed config to lower quality cost: cognitive complexity rose +27% with config versus +53% without.

---

## 4. Incidents and reactions

| Date | Incident | Config surface | Traction | Reaction |
|---|---|---|---|---|
| 2025-08 to 2026-02-25 | Check Point: [CVE-2025-59536](https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/) (hooks and MCP in `.claude/settings.json` ran before trust) and CVE-2026-21852 (`ANTHROPIC_BASE_URL` override leaked the API key) | repo `.claude/settings.json` | wide press | Anthropic fixed it in three rounds (2025-08-26, 09-22, 12-28): a stronger trust dialog, no MCP before approval, API calls deferred until trust |
| 2025 (fixed in 0.23.0) | [CVE-2025-61260](https://research.checkpoint.com/2025/openai-codex-cli-command-injection-vulnerability/), Codex CLI, CVSS 9.8: project `.env` and `.codex/config.toml` MCP commands ran without approval | repo `.codex/` | — | OpenAI patched it within 13 days. Hooks later became hash-trusted |
| 2026-01-30 | [Malicious skills targeting Claude Code and Moltbot users](https://news.ycombinator.com/item?id=46827731) | skills | HN 181p/87c | — |
| 2026-02-05 | Snyk ToxicSkills (13.4% of 3,984 critical, 76 malicious); Koi ClawHavoc (341 malicious skills) | registries | HN | scanner startups appear (Vett, SkillScan, SkillPreflight, HookGuard) |
| 2026-04-29 | [SAP-related npm packages](https://thehackernews.com/2026/04/sap-npm-packages-compromised-by-mini.html) (4 packages, including `@cap-js/*`): the payload "commits itself into every accessible GitHub repository by injecting a '.claude/settings.json' file that abuses Claude Code's SessionStart hook", plus `.vscode/tasks.json` | repo hooks | — | StepSecurity: "one of the first supply chain attacks to target AI coding agent configurations as a persistence and propagation vector" |
| 2026-05-19 | [Mini Shai-Hulud/AntV](https://snyk.io/blog/mini-shai-hulud-antv-npm-supply-chain-attack/): 637 versions across 323 packages. Writes `.claude/settings.json` SessionStart → `node .claude/setup.mjs`, plus `.vscode/tasks.json` folderOpen | repo hooks | [HN 391p/313c](https://news.ycombinator.com/item?id=48189368) | — |
| 2026-08-04 | [ChainDrop/keyv](https://www.microsoft.com/en-us/security/blog/2026/08/04/chaindrop-supply-chain-compromise-anatomy-self-propagating-worm/): 400+ packages. Hooks in `.claude/settings.json` and `.vscode/tasks.json` are pushed to other repos with stolen GitHub credentials | repo hooks | [HN 251p/138c](https://news.ycombinator.com/item?id=49166874). A user found "five new hidden files … under .claude and .vscode" ([HN](https://news.ycombinator.com/item?id=49171370)) | Microsoft advises npm 12 `min-release-age`, credential rotation and release hardening. Nothing about agent hooks |
| 2026-08-06/07 | [Zenity: skills.sh campaign](https://thenextweb.com/news/zenity-malicious-ai-skills-1-7m-installs-supply-chain-credential-theft). Typosquatted clones turned malicious after gaining installs; one family reached 1.7M installs | registry skills | Black Hat, press | Vercel and GitHub took them down within 12 hours. Already-installed copies must be removed by hand |
| 2026-09-25 | [GitGuardian](https://blog.gitguardian.com/ai-coding-agents-credential-security/): 24,008 secrets in public MCP configs, 2,117 of them valid | MCP config | — | recommends endpoint inventory and hook-based scanning |
| 2026-05-01, 06-25 | CLAUDE.md shipped inside the Apple Support and Netflix iOS apps | instruction files | HN 384p/321c; Reddit 205/70 | — |

**What the vendors changed:**
- **Codex:** per-hook, hash-pinned trust (`/hooks` review; changed hooks are skipped until re-trusted).
- **Claude Code:**
  - trust before project hooks and MCP
  - the `ConfigChange` hook (2026-02-19)
  - managed `allowManagedHooksOnly`, plus `strictKnownMarketplaces` and `blockedMarketplaces` enforced on install and update (2.1.117, 2026-04-21)
  - hooks in agent frontmatter need trust (2.1.218, 2026-07-22)
  - **no re-consent when a trusted repo's hooks change**
- **Copilot CLI:** folder trust, plus `allowManagedHooksOnly` extended to extension callbacks.

**What is missing:**
- No harness shows a diff of *changed* executable config before running it.
- No harness ties consent to the program's content across tools. A hook committed for Claude also runs in VS Code.
- The users' own requests point toward fewer prompts (D3).

---

## 5. The case that it's a niche

1. **Committed multi-tool config is a minority.** In February 2026, 12.1% of config-bearing repos configured two or more tools. Hooks, MCP and skills appeared in 1.5%, 2.6% and 5.5% of them (Galster).
2. **Standards are absorbing the loudest pain.** With AGENTS.md read by Claude Code, Cursor, Copilot, Codex, Gemini and others, "instructions in N files" becomes "one file". One commenter: "it's solved with a symlink" (thiht, [HN](https://news.ycombinator.com/item?id=49770391), 2026-09-19).
3. **Set and forget.** 73.8% of config artifacts are never edited after their first commit (Denisov-Blanch). If nothing changes, there is little to manage.
4. **Config is being questioned.**
   - Theo's "You should delete your CLAUDE.md/AGENTS.md file": 7.5k likes ([X](https://x.com/theo/status/2025900730847232409), 2026-02-23).
   - "Evaluating AGENTS.md": 232p/161c ([HN](https://news.ycombinator.com/item?id=47034087)).
   - A Sept 2026 roundup: a hand-written file helps a little, "+2.4 points, not significant", a generated one does worse, and both cost about 20% more ([HN comment](https://news.ycombinator.com/item?id=49867330)).
5. **Too many builders, few winners.** About 90 Show HN launches with a median of 2 points. npm downloads concentrate in four tools: skills, rulesync, ruler and APM. Most of the long tail is flat at under 3k a month.
6. **Vendors are moving inside their walls.** Team marketplaces, managed settings, org skills and auto-update cover single-vendor shops.

**Rebuttal.** Points 1 to 3 describe February-to-August 2026 snapshots of a moving target:
- Codex adoption went from 3% to 16% between January and mid-2026.
- rulesync and ruler grew 5.8x and 18x.
- The incident record in §4 turns "executable config" from a niche feature into a security surface.

The niche is "solo developer, one harness". It is not "team with mixed harnesses", and it is not "org with a security team".

---

## 6. Who feels the pain most

| Persona | Intensity | Will adopt a tool? | Top demands | Key evidence |
|---|---|---|---|---|
| **Solo developer** (2 to 4 harnesses, 1 to 3 machines) | Medium and frequent, but cheap workarounds exist | Low. "Write your own", symlinks and `@AGENTS.md` are good enough; managers are seen as npm-style supply-chain risk (S1 §2) | D1, D7, D6, D9 | 70% use 2 to 4 tools; Claude #20697 (167r), Codex #11061 (91r); @linuz90's symlinked global AGENTS file; ~100 HN symlink comments; Cursor symlink threads |
| **Team lead** (5 to 30 devs, mixed harnesses) | **High.** Split brain, onboarding, updates that never arrive, per-person tweaks | **High.** Wants it committed and boring, with no runtime dependency for consumers | D1, D2, D4, D5 | Tobi's "split brain"; the "gatekeep or share" thread (88c); Codex #26957 and #28739, Claude #96117 and #14920 (94r); `skills` #283 and #549 (103r); oksana-rech's half day lost to marketplace updates (S1) |
| **Platform team** (50+ devs, many repos, governance) | **Highest per head.** Org-wide defaults, allow-lists, private auth, MDM, audit | Medium. Buys a vendor's managed settings first. A cross-vendor layer is needed once the org runs two or more harnesses (39% Claude Code / 21% Copilot / 16% Codex means most large orgs do) | D2, D3, D4, D6, D8 | Claude #28729 (159r), #4800 (open 14 mo), #16870, #45323 not planned; Copilot community#179641 (36 upvotes, unanswered); Codex #18115 (67r); bredren's 80+ dev monorepo with "~no shared skills"; Cursor private-marketplace failures |
| **OSS maintainer** (contributors bring their own harness) | Medium-high. Must serve every contributor's tool with committed files and no new dependency, and must not run contributors' hooks blindly | Medium, if the output is plain native files (S1 concession: "consumers never need palm") | D1, D9, D3, D5 | 44% of Cursor repos also configure Claude; carbon's 47 AGENTS.md and 37 CLAUDE.md; oh-my-posh hand-syncs hooks; Superset symlinks; worms commit `.claude/settings.json` into repos (§4) |
| **Security** (AppSec, endpoint, compliance) | **Highest severity, rising steeply.** Hooks are a worm persistence vector; registries are rug-pulled; secrets sit in MCP config | High for inventory, allow-lists and pinned consent; low for anything that adds prompts for developers | D3, D10, D5 | 3 worms (Apr, May, Aug 2026); Zenity 1.7M; Check Point CVEs; GitGuardian 2,117 valid secrets; Codex hash-pinned trust versus Claude and Copilot folder trust; Copilot #3697 (4r) shows developers don't upvote it |

**Order of who feels it most:** platform team ≈ security > team lead > OSS maintainer > solo developer. The team lead is the best adopter: high pain, can choose tools, small enough to move. Security is the strongest *reason to buy* that has emerged since S1.

---

## 7. Updating S1: which pain points are still open

S1 was dated 2026-09-29 and judged palm 0.1.0. Since then:
- palm 0.2.0 ([a7b9a29](https://github.com/PalionTech/palm/commit/a7b9a293dda8b24fb714ef5989d0502b9fa92135)) changed several verdicts.
- Ecosystem status below is as of 2026-10-02.
- Reaction counts moved only slightly in three days, for example #6235 6,682 → 6,686 and #31005 519 → 526.

| # | Pain point | Ecosystem today | palm 0.2 |
|---|---|---|---|
| P1 | One resource, N copies, N loads | **Open, changed shape.** Instruction files are solved by the AGENTS.md fallback (2.1.277, 2026-09-18). `.agents/skills` is still missing in Claude (#31005, 526r, reopened). Double loading has grown: Cursor double-counts symlinked CLAUDE.md+AGENTS.md and loads CLAUDE.md with the toggle off; new **#96117** (CLAUDE.local.md kills the fallback) | Placement Yes; double load still No. New: refuses an AGENTS.md over the harness cap |
| P2 | Symlinks, submodules and sync scripts break | **Open.** Claude #14836 (52r), #28041, #34437 and new #66559; 14 Cursor symlink threads (9 about discovery); Codex fixed #8369 | **Improved.** Hook scripts are committed under `.palm/assets/` (fresh clones and worktrees work); palm never deletes through a per-skill symlink |
| P3 | Lockfile doesn't lock or restore | **Open** in `skills` (#283 56r, #549 47r, #155 35r, #11 27r; all open) | Yes. Lock v3; a bare `install` makes the disk match; `palm check` is the CI gate (`--frozen` removed) |
| P4 | Updates surprise you or never arrive | **Partly fixed by vendors.** Claude version constraints and auto-update (April 2026); Copilot #1709 done; but Claude #14061 and #73673, Copilot #1296 and #2734 are open. Zenity shows the danger of unreviewed updates | Partly. `ref: ^M.m` ranges, and `update --to`. Still no teammate notice and no Renovate (APM shipped Renovate on 2026-09-05) |
| P5 | Installed ≠ wanted here | **Open.** Claude #14920 (94r), #14202 (66r); Codex #18115 (67r), #34328; Cursor "disabled team rules still loaded". Copilot repo-scoped plugins are done (2026-07-06); Claude `defaultEnabled:false` (2026-05-28) | Partly. `exclude:` on plugin entries; the personal overlay (`palm.local.yaml`) is planned for 0.3; per-person disable of committed entries is out ("needs harness support") |
| P6 | Context budget | **Split.** MCP is largely solved (Claude #6915, #7328 and #4476 closed in March 2026; tool search in Codex and OpenCode). Skills are open (Codex #19679 40r, Copilot #1464, Claude #14882). Claude now reports truncation and token estimates | No. Context cost in `get` is planned for 0.3 |
| P7 | Private and company-wide distribution | **Open.** `skills` private support done (2026-09-11) but the telemetry leak #699 is open; Claude #28729 (159r), #28125, #16870 open, #45323 not planned; Copilot #179641 unanswered; Cursor private-marketplace failures | Mostly (git auth, no telemetry). Still no org default sources or allow-list |
| P8 | Corporate machines | **Partly.** `skills` #523 fixed; Claude #14485 and #26588 open; APM #732 open | Partly. Still no native Windows (WSL only) |
| P9 | Executable content arrives without real review | **Worse.** Three hook worms (Apr, May, Aug 2026), Zenity 1.7M, Check Point CVEs. Codex has hash-pinned hook trust; Claude and Copilot only folder trust | **Much improved.** Hash-pinned consent: the prompt defaults to no, `--yes` never consents, in-repo hook scripts are part of the hash, a literal secret in a hook refuses it. Still no signing; a minimum-age gate was rejected |
| P10 | Registries and directories nobody trusts | **Open, and now proven exploitable** (Zenity typosquat and rug pull); registry #1579 open | Resolved by removal: 0.2 drops the registry client and `search` |
| P11 | MCP config sprawl and plaintext secrets | **Open.** MCP#292 (50r, 18 mo); GitGuardian 2,117 valid secrets | Yes, and better: high-entropy values from a source become `${KEY}` |
| P12 | Silent overwrites and name collisions | **Open** in managers (`skills` #897, #1906; APM #1120) | Mostly. Never gives one file two owners |
| P13 | Managed or hand-written; commit or gitignore | **Unresolved industry-wide** (APM #1342 and #846 closed as not planned) | Decided: generated files are committed; `check` warns on uncommitted output |
| P14 | Install is one line, removal is a chore | **Open** in `skills` (#1034 35r, #577) | Yes. `remove` deletes exactly what the lock lists |
| P15 | "Success" that did nothing | **Open in the harnesses**: Claude #15178 (plugin skills not injected, 33r), #90450 (Auto Mode drops nested CLAUDE.md, 48r); Cursor treating `alwaysApply` rules as requestable | Improved. `check` adds the `render`, `partial` and `orphans` checks. Still nothing proves the harness loads the result |
| P16 | Formats keep changing | **Worse.** Claude Code: 315 releases in 12 months, Mods (#91870, 218r/233c, 2026-09-03), the AGENTS.md fallback; Codex: 131 releases | At risk. The 0.1 → 0.2 migration itself was breaking (`palm migrate`) |
| P17 | Prompts where scripts need flags | **Open** in managers (`skills` #793, APM #1882) | Yes. Without a terminal palm prints the exact `--allow-exec key=hash` line |

**New pain points since S1:**
- **N1. Personal layers that silently disable shared ones.** Claude #96117 (2026-09-22): a CLAUDE.local.md turns off the AGENTS.md fallback. Codex #14601 (85r): personal trust state is stored in the shareable `config.toml`.
- **N2. Consent fatigue against hook safety.** Users upvote skipping trust prompts (Claude #23109 93r, Codex #14599 69r, #19426 35r) while worms exploit trusted hooks. Only consent that is pinned and prompts on change satisfies both.
- **N3. One file, several executors.** A hook in `.claude/settings.json` is now run by Claude Code and VS Code, and Copilot reads `.claude` settings. One write becomes several harness executions, so consent has to be per program, not per harness.
- **N4. Content rot.** Committed config goes stale ("files end up lying to the agent", 89c), and 73.8% is never edited. That raises the case for owned, updatable sources and lowers the case for one-shot generators.

---

## Appendix: method notes and caveats

- GitHub reaction counts are the totals at fetch time on 2026-10-02 (`R3-work/raw/issue_status.tsv`). Issue search used title queries per repo (32 terms × 7 repos, in `R3-work/raw/<repo>.tsv`) plus cross-repo targeted queries. Full-text search was dropped because mega-issues dominate it.
- Cursor's public GitHub repo has 3 open issues; its users post on the forum. Pi's tracker has few reactions; its discussion happens on HN and X.
- Arctic Shift Reddit scores are captured at ingest and lag the live counts. Reddit full-text comment search timed out on the server, so methods were counted from HN comments and from the comments of 8 key Reddit threads (`R3-work/raw/reddit_threads.txt`).
- The npm figures for `skills` include npx runs by agents and CI. Treat the size as an upper bound and the trend as real.
- The HN Show HN count is regex-filtered with manual exclusions. About 6 of the 96 are false positives.
- The method classification of HN comments is keyword-based. The "script" and "submodule" buckets are noisy.
- The survey counts mix "AI tools" (Pragmatic Engineer, including chatbots) with "coding agents" (JetBrains, UCSD/Cornell). The multi-tool conclusion holds under both definitions.
