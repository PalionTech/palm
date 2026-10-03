# R5: Which coding harnesses people use, how many at once, and how fast the set changes

Research date 2026-10-02. Window: October 2025 to October 2026.

Own measurements were taken on 2026-10-02 from the npm downloads API, the VS Code Marketplace API, GitHub REST and GraphQL, GitHub code search and Wayback snapshots. Raw data is in `research2/data/`: `npm_months.json`, `vsm_2026-10-02.txt`, `vsm_wayback.tsv`, `stars_now.tsv`, `wb2.log`, `wbstars.log`, `probe2.json`, `analysis_final.txt` and `codesearch*_2026-10-02.json`.

Labels: **[V]** checked against a primary source; **[S]** secondary source (news); **[U]** unverified (an aggregator page or a single post).

## Key findings

1. **Using several harnesses is the norm, but most developers have one primary harness.**
   - Pragmatic Engineer, 2026-03-03 (n=906): 15% use one AI tool, 70% use two to four, 15% use five or more. These counts include chatbots.
   - GitLab, 2026-06-23 (n=1,528): 91% of organisations have two or more AI coding tools in active use, and 54% have three or more.
   - Sonar, 2026-01-08: the average team "juggles four" AI coding tools.
   - At the agent level, the Stack Overflow pulse survey (2026-05-27) found that 69% use a single agent.
   - JetBrains (Aug 2026): 39% use Claude Code, but only 31% name it their main tool.
   - So a typical developer has one primary harness and one or two secondary ones, and a typical organisation has two to four.
2. **Repositories now carry config for several harnesses.** I sampled 1,190 active GitHub repos.
   - The share with any agent config grew from 9.3% (2025-10-01) to 19.5% (2026-04-01) to 29.5% (2026-10-02).
   - Among configured repos, the share with two or more config carriers (AGENTS.md counts as one carrier) grew from 25% to 46% to 55%.
   - Repos with both CLAUDE.md and AGENTS.md went from 10 to 65 to 130.
   - In the 10k+ star band, 56% of repos have agent config and 37% have two or more carriers.
3. **The set changes fast. Within 12 months, 7 of the 16 harnesses named in the brief had a break.**
   - Roo Code shut down (2026-05-15).
   - Gemini CLI stopped serving consumer accounts (2026-06-18) and was replaced by Antigravity CLI.
   - Windsurf became Devin Desktop (2026-06-02), and its Cascade agent was retired on 2026-07-01.
   - Aider went dormant.
   - pi was acquired by Earendil (2026-04-08) and changed repo and npm name.
   - Amp was spun out of Sourcegraph (2025-12-02).
   - Cursor was bought by SpaceX (closed 2026-08-14).
   - Outside the brief's list: Continue went read-only (Jul 2026), Kilo was bought by Anaconda (2026-07-15), and Amazon Q Developer reached end of support in favour of Kiro (announced 2026-04-30).
4. **Shares moved within six months.** JetBrains at-work usage, Jan 2026 to May–Jul 2026:

   | Tool | Jan 2026 | May–Jul 2026 |
   |---|---|---|
   | Claude Code | 18% | 39% |
   | Copilot | 29% | 21% |
   | Codex | 3% | 16% |
   | Cursor | 18% | 12% |
   | OpenCode | – | 7% (new) |
   | Antigravity | 6% | 6% |

5. **Implications for palm.**
   - Keep Claude Code, Codex, Copilot, Cursor and OpenCode.
   - **Add Antigravity**: it took over Gemini CLI's consumer users on 2026-06-18, and palm's `gemini` target now serves enterprise licences only.
   - **Add pi.**
   - Next wave, later: Kiro, Devin (ex-Windsurf), Junie, Factory, Kilo, Cline, Qwen.
   - Most of the long tail (Amp, Goose, Zed, Warp, Crush, Augment, Kimi, Vibe) already reads `AGENTS.md` plus `.agents/skills` or `.claude/skills`. palm's existing outputs reach them, so documenting that compatibility is enough.

## 1. How many harnesses at once

### 1.1 Developers (surveys)

| Source (date, sample) | What it says about tool count and shares |
|---|---|
| Pragmatic Engineer, *AI Tooling 2026* (2026-03-03; n=906; fieldwork 2026-01-27 to 02-17) [V] https://newsletter.pragmaticengineer.com/p/ai-tooling-2026 | **15% use one tool, 70% use two to four, 15% use five or more** (chatbots included). Claude Code is the most used tool, ahead of chatbots, Copilot, Cursor and Codex. At companies under 10 people: Claude Code 75%, chatbots 55%, Cursor 42%, Copilot 35%; Codex 26%, Gemini CLI 14%, OpenCode 13% (these three from the survey agent's extraction). At 10k+ employees, Copilot overtakes Claude Code. |
| Sonar, *State of Code* (2026-01-08; n≈1,149) [V] https://www.sonarsource.com/company/press-releases/sonar-data-reveals-critical-verification-gap-in-ai-coding/ | "Average team now juggles four different AI coding tools." Tools used: Copilot 75%, ChatGPT 74%, Claude/Claude Code 48%, Gemini 37%, Cursor 31%, Codex 21%, Windsurf 8%. Per-tool shares are from The Register, 2026-01-09 [S]. |
| Stack Overflow pulse, "Agents on a leash" (2026-05-27; n≈1,100; late Apr 2026) [V] https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work/ | 59% use agents at work (31% in the 2025 survey). Used in the last six months: Copilot 61%, Claude Code 51%, Codex 20%, Cursor 20%. **69% use a single agent**, 17% several specialised agents, 16% several coordinated agents. |
| JetBrains AI Pulse, Jan 2026 wave (post dated Apr 2026; n>10k) [V] https://blog.jetbrains.com/research/2026/04/which-ai-coding-tools-do-developers-actually-use-at-work/ | At work: Copilot 29%, ChatGPT 28%, Cursor 18%, Claude Code 18%, JetBrains AI 9%, Gemini 8%, Antigravity 6%, Junie 5%, Codex 3%. Claude Code was about 3% in Apr–Jun 2025. |
| JetBrains, *AI Coding Agents adoption* (Aug 2026; n>15k; May–Jul 2026) [V] https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/ | 90% use agents weekly, 68% daily. Claude Code 39% (US 47%) and the main tool for 31%; Copilot 21%; Codex 16%; Cursor 12%; JetBrains AI/Junie about 9%; OpenCode 7%; Antigravity 6%. There is no tool-count question. The named shares add up to 110% against 90% using any agent, so about 1.2 named coding agents per user (my arithmetic). |
| Stack Overflow Developer Survey 2025 (Jul 2025) [V] https://survey.stackoverflow.co/2025/ai | Among agent users: ChatGPT 81.7%, Copilot 67.9%, Gemini 47.4%, Claude Code 40.8%. As IDEs: Cursor 17.9%, Claude Code 9.7%, Zed 7.3%, Windsurf 4.9%. **The 2026 results were not yet published on 2026-10-02**; the 2026-09-30 blog post says "in the next few days". |
| Individual practice [S] | Nathan Lambert uses Claude to drive and Codex to review (https://www.interconnects.ai/p/gpt-54-is-a-big-step-for-codex, 2026-03-18). Every's staff split 80/20 between Codex and Claude (https://every.to/vibe-check/vibe-check-opus-5-5-is-pulling-our-codex-converts-back-to-claude, 2026-09-22). |

**Reading.** An engaged developer runs two to four AI tools. Usually one or two of them are coding harnesses that read repo config.

### 1.2 Teams and organisations

**Surveys**
- **GitLab AI Accountability Report** (2026-06-23; n=1,528) [V]: "91% of organizations have two or more AI coding tools in active use; 54% have three or more". 40% report problems from fragmented toolchains. https://about.gitlab.com/press/releases/2026-06-23-gitlab-research-reveals-organizations-are-generating-ai-code-faster-than-they-can-control-it/
- **Greptile State of AI Coding** (Q2 2026 update): CLAUDE.md is in 80% of orgs [V] https://www.greptile.com/state-of-ai-coding. The figures AGENTS.md 63%, Cursor rules 34% and "18% use all three" come from secondary sources only, because the report is behind an email gate [S].

**Companies that publicly run several harnesses**
- **Shopify**: Cursor, Claude Code, Copilot, Codex and Gemini tools behind one LLM proxy [S] (https://www.bvp.com/atlas/inside-shopifys-ai-first-engineering-playbook, 2026-04-02).
- **Stripe**: the internal "Minions" agents (a fork of goose) read the same rule files as Cursor and Claude Code [V] (https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2, 2026-02-19).
- **Uber**: Claude Code use rose from 32% (Dec 2025) to 63% (Feb 2026), alongside Cursor and IntelliJ [S] (https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development, 2026-03-10).
- **Amazon**: made Kiro the standard in Nov 2025, then allowed Codex and Claude in May 2026 [S] (https://developers.slashdot.org/story/26/05/10/0618225/amazon-relents-lets-its-programmers-use-openais-codex-and-anthropics-claude).
- **NVIDIA**: Cursor for every engineer (Oct 2025) plus a Codex deployment (Feb 2026) [S].
- **Microsoft, a counterexample**: ran Claude Code and Copilot CLI side by side, then on 2026-05-15 moved a division to Copilot CLI only, by 2026-06-30 [S] (https://winbuzzer.com/2026/05/15/microsoft-starts-canceling-claude-code-licenses-xcxwbn/).

**Platforms that host several harnesses**
- GitHub Agent HQ: Claude and Codex agents in public preview since 2026-02-04 [S] (https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/).
- JetBrains Central (2026-03-24) [V].
- Devin Desktop runs third-party agents through ACP (2026-06-02) [V].
- ACP adapter npm downloads in Sep 2026: `@agentclientprotocol/claude-agent-acp` 7.45M, `@zed-industries/codex-acp` 0.97M [V].

**Job posts.** Counts of top-level Hacker News "Who is hiring" posts that name a harness (a regex count by the research agent, not a formal study):

| Thread | Posts | Name any harness | Name two or more |
|---|---|---|---|
| Oct 2025 | 341 | 7 | 3 |
| Mar 2026 | 319 | 20 | 6 |
| Sep 2026 | 253 | 15 | 6 |

Example: Mattermost, "We use coding agents daily (Claude Code, Cursor, and others)" (https://news.ycombinator.com/item?id=49530116, 2026-09-02).

**Config-sync tools grew 6–25x** (npm monthly downloads, Sep 2025 → Sep 2026) [V]:

| Package | Sep 2025 | Sep 2026 | Notes |
|---|---|---|---|
| `rulesync` | 151k | 1.00M | |
| `@intellectronica/ruler` | 11.6k | 279k | |
| `skills` (Vercel) | 0 | 27.5M | peak 47.5M in Jul 2026 |

### 1.3 Repositories: own measurement (2026-10-02)

**Sample.**
- Source: GitHub repository search for non-fork, non-archived repos created before 2025-09-01 and pushed after 2026-09-01.
- Six star bands: 20–199, 200–499, 500–999, 1k–3k, 3k–10k, and 10k or more. I took the first 200 per band in GitHub best-match order.
- 1,190 of the 1,200 repos have history at all three dates.

**Probe.** For each repo, GraphQL `Commit.file(path)` checked 35 harness paths at the default-branch HEAD, and at the last commit before 2025-10-01 and before 2026-04-01.

**Families.** Each family is a set of tool-specific paths:

| Family | Paths |
|---|---|
| claude | `CLAUDE.md`, `.claude/` |
| codex | `.codex/` |
| cursor | `.cursor/`, `.cursorrules` |
| copilot | `.github/copilot-instructions.md`, `.github/{instructions,agents,prompts,skills}` |
| gemini | `GEMINI.md`, `.gemini/` |
| opencode | `.opencode/`, `opencode.json` |
| pi | `.pi/` |
| others | windsurf, cline, roo, kilo, kiro, junie, aider, goose, zed `.rules`, augment, qwen, continue, factory, warp, crush |

`AGENTS.md` counts as one additional, shared carrier.

| Measure | 2025-10-01 | 2026-04-01 | 2026-10-02 |
|---|---|---|---|
| Repos with any agent config | 111 (9.3%) | 232 (19.5%) | **351 (29.5%)** |
| `AGENTS.md` | 26 (2.2%) | 123 (10.3%) | 246 (20.7%) |
| `CLAUDE.md` | 48 | 123 | 190 |
| Both `CLAUDE.md` and `AGENTS.md` | 10 | 65 | **130** |
| `.agents/` directory | 0 | 20 | 62 |
| Configured repos with ≥2 carriers (AGENTS.md counts as one) | 28 (25%) | 106 (46%) | **192 (55%)** |
| Mean carriers per configured repo | 1.35 | 1.70 | 1.79 |
| Repos with ≥2 tool-specific families (not counting AGENTS.md) | 19 of 99 (19%) | 58 of 197 (29%) | 79 of 280 (28%) |

**Families present at HEAD.**

| Family | Repos | Note |
|---|---|---|
| claude | 221 | |
| copilot | 80 | 47 of them have only `copilot-instructions.md` |
| cursor | 27 | |
| gemini | 23 | 15 have `GEMINI.md`; 8 have only `.gemini/`, which is Gemini Code Assist review config (`styleguide.md`, `config.yaml`) |
| codex | 16 | |
| opencode | 9 | |
| pi | 5 | 4 verified as pi `.pi/{extensions,prompts,skills}` |
| windsurf, cline | 4 each | |
| augment | 2 | |
| factory, qwen, warp, zed | 1 each | |
| kiro, junie, aider, goose, roo, kilo, continue, crush | 0 | |

**Most common combinations at HEAD.**

| Combination | Repos |
|---|---|
| claude + copilot | 28 |
| claude + cursor | 11 |
| claude + gemini | 7 |
| claude + codex | 6 |
| claude + copilot + gemini | 4 |
| claude + opencode | 3 |

One repo, `cline/cline`, carries ten families.

**Repo-level churn, Oct 2025 → Oct 2026.**

| Family | Kept | Removed | Added | Note |
|---|---|---|---|---|
| cursor | 13 | 13 | 14 | Half of the Oct 2025 Cursor configs were deleted |
| claude | 45 | 8 | 176 | |
| copilot | 22 | 7 | 58 | |
| roo | 0 | 2 | 0 | Both Roo configs removed |
| kiro | 0 | 1 | 0 | The one Kiro config removed |
| codex | 0 | 0 | 16 | New |
| opencode | 1 | 0 | 8 | |
| pi | 0 | 0 | 5 | New |

**By star band at HEAD.**

| Band | Repos | With any config | With ≥2 carriers |
|---|---|---|---|
| 20–199 | 198 | 39 (20%) | 16 |
| 200–499 | 199 | 42 | 22 |
| 500–999 | 197 | 45 | 22 |
| 1k–3k | 199 | 53 | 21 |
| 3k–10k | 198 | 61 | 37 |
| 10k or more | 199 | 111 (56%) | 74 (37%) |

Repos with three or more families include ggml-org/llama.cpp, ant-design/ant-design, home-assistant/core, zed-industries/zed, storybookjs/storybook, apache/superset, cline/cline and gitkraken/vscode-gitlens.

**Caveats.**
- The sample is GitHub best-match order, not random.
- A file being present does not prove anyone uses it.
- `copilot-instructions.md` and `.gemini/` also serve code-review bots.
- Private and enterprise repos are invisible.

### 1.4 GitHub code search counts (2026-10-02)

Counts come from legacy REST code search and are approximate. They count files on default branches, not repos, and exclude forks.

| Query | Files |
|---|---|
| `filename:AGENTS.md` | 1,079,296 |
| `filename:CLAUDE.md` | 792,576 |
| `filename:SKILL.md path:.claude/skills` | 411,648 |
| `filename:SKILL.md path:.agents/skills` | 366,080 |
| `extension:mdc path:.cursor/rules` | 189,696 |
| `filename:copilot-instructions.md path:.github` | 153,856 |
| `extension:md path:.github/agents` | 110,848 |
| `filename:SKILL.md path:.github/skills` | 94,976 |
| `filename:GEMINI.md` | 68,992 |
| `filename:settings.json path:.claude` | 67,968 |
| `filename:.mcp.json` | 66,944 |
| `filename:.cursorrules` (legacy Cursor) | 34,304 |
| `path:.kilocode` | 31,744 |
| `filename:opencode.json` | 29,888 |
| `path:.kiro/steering` | 23,680 |
| `filename:config.toml path:.codex` | 10,112 |
| `path:.windsurf/rules` | 8,608 |
| `path:.clinerules` | 7,632 |
| `filename:SKILL.md path:.pi/skills` | 7,072 |
| `filename:mcp.json path:.cursor` | 6,848 |
| `filename:WARP.md` | 6,640 |
| `filename:QWEN.md` | 6,560 |
| `filename:settings.json path:.gemini` | 4,744 |
| `filename:.windsurfrules` | 4,384 |
| `filename:hooks.json path:.cursor` | 2,404 |
| `filename:guidelines.md path:.junie` | 2,400 |
| `filename:CRUSH.md` | 1,668 |
| `filename:settings.json path:.pi` | 1,122 |
| `filename:.roomodes` | 972 |
| `filename:.aider.conf.yml` | 936 |
| `filename:.goosehints` | 309 |
| `filename:mcp.json path:.pi` | 201 |

I dropped two queries whose results were not usable: `filename:AGENT.md` and `path:.opencode`. Legacy search matches loosely on them (398k and 229k hits).

**Files that bridge two harnesses** (same date and method):

| Query | Files |
|---|---|
| `CLAUDE.md` containing `@AGENTS.md` | **50,816** |
| `CLAUDE.md` mentioning `AGENTS.md` | 128,768 |
| `AGENTS.md` mentioning `CLAUDE.md` | 71,424 |
| `copilot-instructions.md` mentioning `AGENTS.md` | 10,720 |
| `GEMINI.md` mentioning `AGENTS.md` | 9,120 |
| `.cursor/rules/*.mdc` mentioning `AGENTS.md` | 6,576 |

**Growth of AGENTS.md** (code search has no date filter, so these come from other sources):
- "20k+ projects" at launch in Aug 2025 [U].
- "More than 60,000" in the Linux Foundation AAIF release of 2025-12-09 [V] (https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation).
- 1.08M files today. agents.md still says "60k" [V].

**How repos bridge harnesses** (research agent, checked via GitHub API on 2026-10-02):
- `CLAUDE.md` is a symlink to `AGENTS.md` in apache/airflow and prisma/prisma.
- huggingface/transformers points both files at `.ai/AGENTS.md`.
- `CLAUDE.md` is just `@AGENTS.md` in astral-sh/ruff, supabase, grafana and mastra.
- `.claude/skills` is a symlink to `.agents/skills` in vercel/next.js and supabase.
- vercel/ai has `.agents`, `.claude`, `.codex` and `.cursor` side by side.

**Claude Code now reads AGENTS.md.** Since **2.1.277 (2026-09-18)** it reads AGENTS.md when a project has no CLAUDE.md [V] (CHANGELOG, https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md). The request (issue #6235) had gathered 5,187 👍 [V].

### 1.5 Synthesis on multi-harness prevalence

| Level | Typical number of harnesses | Evidence |
|---|---|---|
| Developer, in a session | 1 primary | SO pulse: 69% use a single agent; JetBrains: about 1.2 named agents per user |
| Developer, over a month | 2–4 AI tools, of which 1–2 harnesses | Pragmatic Engineer: 70% use 2–4; Sonar: about 4 per team |
| Organisation | 2–4 | GitLab: 91% have ≥2, 54% ≥3; Shopify, Stripe, Uber, Amazon |
| Configured public repo | 1.8 carriers on average | 55% have ≥2 carriers; up from 25% in Oct 2025 |

The usual pairs are:
- Claude Code plus AGENTS.md, where AGENTS.md serves Codex, Cursor, Copilot, OpenCode, Amp and others.
- Claude Code plus Copilot instructions.

## 2. Usage proxies per harness (own data, 2026-10-02)

### 2.1 npm monthly downloads [V]

Source: `api.npmjs.org/downloads/range`. CI and auto-updates inflate these numbers. Claude Code is undercounted because it also has a native installer.

| Harness (package) | Oct 2025 | Mar 2026 | Sep 2026 | Peak month |
|---|---|---|---|---|
| Codex (`@openai/codex`) | 1.12M | 14.5M | **89.7M** | May 2026, 239M (CI spike) |
| Claude Code (`@anthropic-ai/claude-code`) | 24.0M | 44.4M | **55.9M** | Aug 2026, 82.2M |
| pi (`@mariozechner/…` + `@earendil-works/pi-coding-agent`) | 0 | 9.6M | **15.7M** | Sep 2026 |
| OpenClaw (`openclaw`, personal agent) | 0 | 9.0M | 14.3M | Jun 2026 |
| OpenCode (`opencode-ai`) | 240k | 2.50M | **9.79M** | Aug 2026, 10.5M |
| Copilot CLI (`@github/copilot`) | 275k | 2.44M | **7.91M** | Aug 2026, 10.4M |
| Gemini CLI (`@google/gemini-cli`) | 1.15M | 3.20M | 1.63M | Apr 2026, 3.47M |
| Cline CLI (`cline`) | 57k | 775k | 302k | Mar 2026 |
| Qwen Code | 218k | 482k | 283k | Apr 2026 |
| Amp (`@sourcegraph/amp` + `@ampcode/cli`) | 92k | 186k | 215k | Aug 2026 |
| Kilo CLI | 8k | 150k | 150k | Apr 2026, 382k |
| Auggie | 87k | 155k | 134k | Jul 2026 |
| Factory Droid (`droid` + `@factory/cli`) | 0.2k | 18k | 83k | Sep 2026 |
| Crush | 9k | 11k | 29k | Aug 2026 |
| Continue CLI | 21k | 20k | 19k | Jan 2026 |
| Junie CLI | 2k | 6k | 5k | Aug 2026 |
| iFlow CLI | 206k | 166k | **1.8k** | Dec 2025, 1.67M (collapsed) |

**The pi numbers are inflated by packages that depend on pi.** OpenClaw depended on `@mariozechner/pi-coding-agent` from Feb to mid-May 2026, and on `@earendil-works/pi-coding-agent` until late May 2026. Since then it depends only on `pi-tui` (npm registry, checked version by version). In Sep 2026 `pi-tui` had 32.2M downloads, `pi-ai` 21.2M and `pi-agent-core` 15.8M. These pi figures are for a library plus a CLI, not a count of users.

### 2.2 VS Code Marketplace installs [V]

Snapshot from the Marketplace API on 2026-10-02; the "about a year earlier" column comes from Wayback snapshots of the item pages.

| Extension | About a year earlier | 2026-10-02 |
|---|---|---|
| Copilot Chat | – | 78.6M |
| Claude Code | 0.93M (2025-09-30), 8.78M (2026-04-02) | **26.8M** |
| OpenAI Codex (`openai.chatgpt`) | 1.13M (2025-10-04) | **15.1M** |
| Cline | 2.35M (2025-10-01) | 5.51M |
| Gemini Code Assist | 3.59M (2026-04-01) | 5.39M |
| Continue | – | 4.26M (frozen) |
| Windsurf / Codeium plugin | 3.09M (2025-09-27) | 3.98M |
| Roo Code | 1.43M (2026-04-01) | 2.05M (frozen since 2026-05-15) |
| Kilo Code | – | 1.59M |
| OpenCode | 18k (2025-11-11) | 1.18M |
| Augment | – | 0.78M |
| Amp | – | 0.11M |

### 2.3 GitHub stars [V]

"Now" comes from `gh api` on 2026-10-02; earlier values are from Wayback snapshots of the repo page.

| Repo | About Oct 2025 | About Mar/Apr 2026 | Now |
|---|---|---|---|
| openclaw/openclaw | – | 106k (2026-01-30) | 391k |
| NousResearch/hermes-agent | – | 21.6k (2026-04-01) | 251k |
| anomalyco/opencode (ex sst/opencode) | 22.3k (2025-09-07) | 45.5k (2026-01-02) | **211k** |
| anthropics/claude-code | 35.4k (2025-10-03) | 71.8k (2026-03-01) | **149k** |
| openai/codex | 45.6k (2025-10-02) | 71.9k (2026-04-02) | 128k |
| earendil-works/pi (ex badlogic/pi-mono) | 8 (2025-09-20) | 29.5k (2026-03-31) | **112k** |
| google-gemini/gemini-cli | 73.0k (2025-09-01) | 96.2k (2026-03-02) | 107k |
| zed-industries/zed | 64.9k (2025-09-02) | – | 91.2k |
| OpenHands/OpenHands | 64.3k (2025-10-20) | – | 89.8k |
| cline/cline | 51.0k (2025-10-01) | 59.1k (2026-03-17) | 69.7k |
| warpdotdev/warp | 25.0k (2025-10-04) | 26.3k (2026-04-03) | 65.3k |
| aaif-goose/goose (ex block/goose) | 20.0k (2025-10-01) | 35.7k (2026-04-05) | 54.9k |
| Aider-AI/aider | 37.3k (2025-09-08) | – | 49.3k |
| continuedev/continue | 28.7k (2025-09-03) | – | 36.1k (read-only) |
| charmbracelet/crush | 12.0k (2025-09-05) | 22.3k (2026-03-31) | 28.5k |
| QwenLM/qwen-code | 13.9k (2025-10-04) | 19.7k (2026-03-02) | 28.3k |
| Kilo-Org/kilocode | 10.7k (2025-10-01) | 16.1k (2026-03-01) | 27.5k |
| xai-org/grok-build | – | – | 27.2k (created 2026-07-14) |
| RooCodeInc/Roo-Code | 19.3k (2025-09-04) | – | 24.3k (archived) |
| github/copilot-cli | 78 (2025-09-25) | 9.8k (2026-04-03) | 11.2k |
| kirodotdev/Kiro (issue tracker only) | 2.0k (2025-09-19) | 3.4k (2026-04-07) | 4.3k |

OSS Insight's star-history API returns about a third of GitHub's counts for these repos, with a gap from Apr to Jul 2026, so I did not use it.

## 3. Harness table

The trend column covers Oct 2025 → Oct 2026. Config paths come from the vendor docs read by the config-survey agent on 2026-10-02 (URLs in Sources).

| Harness | Users or proxy (date) | Trend | Config model (project scope) | palm target |
|---|---|---|---|---|
| **Claude Code** | JetBrains 39% at work (May–Jul 2026); run-rate above $2.5B (2026-02-12); npm 55.9M/month; VS Code 26.8M installs; 149k★ | **Strongly up**: JetBrains 3%→18%→39%; ★35k→149k; VS Code 0.9M→26.8M | `CLAUDE.md` (AGENTS.md fallback since 2.1.277); `.claude/{skills,agents,commands,rules}`; hooks in `.claude/settings.json`; `.mcp.json`; plugins and marketplaces | yes (existing) |
| **Codex** (CLI, IDE, app) | JetBrains 16%; above 5M weekly users (2026-06-02, [S]); npm 89.7M/month; VS Code 15.1M | **Fastest riser**: 3%→16%; npm 1.1M→89.7M; ★46k→128k | `AGENTS.md` (+override); `.agents/skills`; `.codex/config.toml` (MCP); hooks; custom agents | yes (existing) |
| **GitHub Copilot** (VS Code agent, CLI, cloud agent) | 50M users (Microsoft FY26 Q4, 2026-07-29); JetBrains 21%; Copilot CLI npm 7.9M/month | Users up, **share down** (29%→21%); CLI npm 275k→7.9M; metered billing from 2026-06-01 | `.github/copilot-instructions.md`; `.github/instructions/*.instructions.md`; `AGENTS.md` (coding agent also reads CLAUDE.md and GEMINI.md); `.github/{agents,prompts,skills,hooks}`; `.vscode/mcp.json` | yes (existing) |
| **Cursor** (IDE, CLI) | JetBrains 12%; ARR about $3B (May 2026, [S]); acquired by SpaceX, closed 2026-08-14 [S] | **Share down** (18%→12%); OpenAI to cut model access 2026-11-12 [S]; repo configs flat (13 of 26 removed) | `.cursor/rules/*.mdc`; `AGENTS.md`; `.cursor/{commands,skills,agents}`; `.cursor/hooks.json`; `.cursor/mcp.json` | yes (existing) |
| **OpenCode** | JetBrains 7%; "16M monthly developers" (opencode.ai, vendor, 2026-10-02); npm 9.8M/month; 211k★ | **Strongly up**: npm ×41; ★22k→211k | `AGENTS.md` (CLAUDE.md fallback); `opencode.json(c)` (mcp, agent, command); `.opencode/{agents,commands,skills,plugins}`; reads `.claude/skills` and `.agents/skills`; hooks are JS plugins | yes (existing) |
| **Gemini CLI** | npm 1.63M/month; 107k★ | **Sunset for free, Pro and Ultra users on 2026-06-18**; enterprise only; npm peaked at 3.47M (Apr 2026) | `GEMINI.md`; `.gemini/settings.json` (MCP, hooks); `.gemini/{commands *.toml, skills, agents}`; extensions | keep as legacy (enterprise); no new work |
| **Antigravity** (IDE since Nov 2025; CLI `agy` since 2026-05-19) | JetBrains 6% (Jan and May–Jul 2026); no CLI numbers | New; inherits Gemini CLI's consumer users | `AGENTS.md`/`GEMINI.md`; `.agents/rules`; `.agents/skills`; `.agents/agents`; `.agents/hooks.json`; `.agents/mcp_config.json` (remote servers use `serverUrl`); own `plugin.json`. Global: `~/.gemini/config/`, `~/.gemini/antigravity-cli/` | **yes (new; replaces gemini for consumers)** |
| **pi** | 112k★; npm 15.7M/month (inflated, see 2.1); "hundreds of thousands" weekly (Earendil, vendor, 2026-10-01); 5,394 pi packages | **Strongly up**: ★8→112k; 1.0 on 2026-10-01; MCP added in 0.99 | See §5 | **yes** |
| **Kiro** (IDE, CLI) | Amazon's internal standard ("83% of engineers lean on Kiro", May 2026, [S]); replaces Amazon Q Developer (end of support announced 2026-04-30, [V]); 23.7k `.kiro/steering` files | Up on the enterprise mandate; small in surveys; 1 of 1 sample config removed | `.kiro/steering/*.md` (+AGENTS.md); `.kiro/skills` (does not read `.agents/skills`); `.kiro/agents` (JSON/MD); `.kiro/hooks/*.json` (own schema); `.kiro/settings/mcp.json`; "powers" | later (first of the next wave) |
| **Devin Desktop and Devin CLI** (ex-Windsurf) | Windsurf 4.9% (SO 2025), 8% (Sonar Jan 2026); Codeium VS Code 3.1M→4.0M; Cognition ARR $492M (May 2026, [S]) | Renamed 2026-06-02; Cascade retired 2026-07-01 in favour of Devin Local | `AGENTS.md`/`CLAUDE.md`/`.windsurfrules`; `.devin/rules` (or `.windsurf/rules`); skills from `.agents`, `.devin`, `.windsurf`, `.claude` and `.github`; `.devin/agents`; `.devin/hooks.v1.json` (Claude-compatible); `.devin/mcp_config.json`; `.devin-plugin`, falling back to `.claude-plugin` | later (once the Devin Local config settles; already Claude-compatible) |
| **Cline** (VS Code, JetBrains, CLI 3.x) | VS Code 5.51M installs; vendor says 11M+; CLI npm 302k/month | Up (installs ×2.3) | `.clinerules/` or `.cline/rules` (also reads AGENTS.md, .cursorrules, .windsurfrules); skills in `.cline/skills`, `.clinerules/skills`, `.claude/skills` (not `.agents/skills`); hooks are executable scripts in `.cline/hooks/`; MCP global only | later |
| **Kilo Code** | VS Code 1.59M; "3M+ users" (vendor); CLI npm 150k/month | Up; built on OpenCode since Feb 2026; bought by Anaconda 2026-07-15; took in Roo's users | `.kilo/{rules,skills,agents,commands}`; `kilo.jsonc` (OpenCode MCP schema); reads `.agents/skills` and `.claude/skills`; hooks are plugins | later (reuse the OpenCode adapter) |
| **JetBrains Junie** | Junie 5% (Jan 2026); JetBrains AI or Junie about 9% (May–Jul 2026); 343k users in 2025 (vendor) | Flat; CLI GA 2026-06-17 | `.junie/AGENTS.md` or `AGENTS.md`; `.junie/{rules,skills,agents,commands}`; `.agents/skills`; `.junie/mcp/mcp.json`; hooks only in global `~/.junie/config.json` | later |
| **Factory Droid** | npm 83k/month; $5B valuation (2026-09-15, [U]) | Up from a small base | `AGENTS.md`/`CLAUDE.md`; `.factory/{skills,droids,commands}`; `.factory/hooks.json` (Claude event names); `.factory/mcp.json`; `.agents/skills`; `.claude-plugin` compatible | later (cheap: Claude-shaped) |
| **Qwen Code** | npm 283k/month; 28k★ | Flat | `QWEN.md` + `AGENTS.md`; `.qwen/{skills,agents,commands}`; `.qwen/settings.json` (hooks, mcpServers) | later (reuse the Gemini adapter) |
| **Grok Build** (xAI, launched 2026) | 27k★ (repo created 2026-07-14) | New | Reads `.claude/` and `.cursor/` layouts plus `.grok/`; TOML MCP | later (watch) |
| **Amp** | npm about 215k/month; VS Code 108k | Flat to slightly up; spun out 2025-12-02 | `AGENTS.md` (falls back to AGENT.md, CLAUDE.md); `.agents/skills` and `.claude/skills`; MCP under `amp.mcpServers` in `.amp/settings.json`; commands, agents and hooks only as TS plugins | no (document compatibility; skills and instructions already reach it) |
| **Goose** | 55k★; Linux Foundation AAIF project since 2025-12-09 | Up (★×2.7); basis of Stripe's Minions | `AGENTS.md`/`.goosehints`; `.agents/skills` (+`.claude/skills`); `.agents/agents`; hooks only inside plugins; MCP in global `config.yaml` | no (compatibility) |
| **Zed** (agent panel) | 91k★; 7.3% as IDE (SO 2025) | Up as an editor; hosts Claude Code and Codex via ACP | First of `.rules`, `.cursorrules`, …, `AGENTS.md`, `CLAUDE.md`; `.agents/skills`; MCP in editor settings; no hooks | no (compatibility) |
| **Augment (Auggie)** | npm 134k/month; VS Code 780k | Flat | Reads `.claude/` and `.agents/`; `.augment/{rules,skills,agents,commands}`; MCP user-level | no (compatibility) |
| **Warp** | 65k★; "nearly 1M developers" (2026-04-28, vendor) | Up | `AGENTS.md`/`WARP.md`; skills in many directories; `.warp/.mcp.json`; global rules in the Warp Drive cloud | no |
| **Crush** | npm 29k/month; 28k★ | Small | Reads `AGENTS.md`, `CLAUDE.md` and `.agents/skills`; config is a bash `crushrc` script | no |
| **Mistral Vibe, Kimi Code** | 5.0k★ and 7.8k★ | Small; Python Kimi CLI archived | `.vibe/` and `.kimi/` plus `.agents/skills`; TOML or global-only config | no |
| **Roo Code** | 2.05M installs, frozen | **Shut down**: announced 2026-04-21, archived 2026-05-15 | – | no |
| **Aider** | PyPI 0.7–0.9M/month (Apr–Aug 2026), 268k in Sep; 49k★ | **Dormant**: releases on 2025-08-09 and 2026-02-12 only; last commit 2026-05-22 | `.aider.conf.yml` with a `read:` list; nothing loads automatically; no skills, hooks or MCP | no |
| **Continue** | 4.26M installs, frozen | **Read-only** since Jul 2026; reported bought by Cursor [S] | – | no |
| **OpenClaw, Hermes Agent** | 391k★ and 251k★; openclaw npm 14.3M/month | Personal assistant agents, not repo harnesses | Own skill dirs (SKILL.md) | no (out of scope) |

## 4. Churn: how fast the set changes

### 4.1 Events in the window (chronological)

**2025**
- **2025-11-10**: GitHub Copilot Extensions (GitHub Apps) sunset in favour of MCP [V] (https://github.blog/changelog/2025-09-24-deprecate-github-copilot-extensions-github-apps/).
- **2025-11-17**: Kiro becomes generally available.
- **2025-11-21**: Cursor announces the end of Supermaven [V] (https://supermaven.com/blog/sunsetting-supermaven).
- **2025-12-02**: Amp is spun out of Sourcegraph as Amp Inc. [S].
- **2025-12-09**: the Linux Foundation forms the Agentic AI Foundation, with AGENTS.md, MCP and goose [V].
- **2025-12-18**: Agent Skills becomes an open standard. agentskills.io now lists 46 clients, including the archived Roo Code [V].

**Feb–Apr 2026**
- **2026-02**: Kilo CLI 1.0 is rebuilt on OpenCode.
- **2026-04-08**: Earendil acquires pi [S] (Armin Ronacher, "Mario and Earendil"). The repo moves to earendil-works/pi, and npm switches to `@earendil-works/pi-coding-agent` from 2026-05-07; the old name is deprecated [V].
- **2026-04-21**: Roo Code announces its shutdown; it is archived on 2026-05-15 [V].
- **2026-04-21**: SpaceX gets a purchase option on Cursor. It exercises it on 2026-06-16 ($60B in stock), and the deal closes on 2026-08-14 [S] (https://en.wikipedia.org/wiki/Cursor_(company)).
- **2026-04-30**: AWS announces end of support for Amazon Q Developer in favour of Kiro [V] (https://aws.amazon.com/blogs/devops/amazon-q-developer-end-of-support-announcement/).

**May–Jun 2026**
- **2026-05-15**: Microsoft moves a division from Claude Code to Copilot CLI [S].
- **2026-05-19**: Google launches Antigravity CLI. **On 2026-06-18 Gemini CLI stops serving free, Pro and Ultra users** [V] (https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/).
- **2026-06-01**: Copilot moves to metered billing, and users threaten to leave [S].
- **2026-06-02**: Windsurf becomes Devin Desktop; Cascade is retired on 2026-07-01 [V] (https://devin.ai/blog/windsurf-is-now-devin-desktop).
- **2026-06-17**: Junie CLI becomes generally available.

**Jul–Oct 2026**
- **2026-07**: Continue goes read-only; its last commit is on 2026-07-21 [V].
- **2026-07-15**: Anaconda acquires Kilo [V] (https://blog.kilo.ai/p/anaconda-acquires-kilo-code).
- **2026-07-30**: Tricentis acquires Tabnine [S].
- **2026-08-29**: OpenAI says it will cut off Cursor's model access on 2026-11-12 [S].
- **2026-09-14**: Claude Code limits change, followed by public moves to Codex [U/S]. On 2026-09-22, Every reports that Codex converts are coming back after Opus 5.5 [S].
- **2026-09-29**: pi adds MCP (0.99). **2026-10-01**: pi 1.0.

**No single date:**
- The Python Kimi CLI was archived and replaced by Kimi Code.
- iFlow CLI collapsed from 1.67M npm downloads a month (Dec 2025) to 1.8k (Sep 2026).

### 4.2 How fast

**Harnesses named in the brief.** Of the 16 named, 7 had a break within 12 months:

| Kind of break | Harnesses |
|---|---|
| Shut down | Roo Code |
| Sunset for consumers | Gemini CLI |
| Renamed, agent replaced | Windsurf |
| Dormant | Aider |
| Changed owner or structure | Cursor, pi, Amp |

The other nine continued without a break: Claude Code, Codex, Copilot CLI, OpenCode, Kiro, Cline, Zed, Junie and Goose. Goose did move to a new GitHub org. Outside the brief's list, Kilo and Tabnine were bought, Continue and Supermaven ended, and Amazon Q Developer gave way to Kiro.

**Leaders.** At work, the leader changed from Copilot (29%) to Claude Code (39%) within six months, Codex grew fivefold and Cursor lost a third of its share (JetBrains). In JetBrains' data, four of the top five stayed in the top five. By npm CLI downloads only three of five stayed: Gemini CLI and Qwen dropped out, and pi and Copilot CLI came in.

**New entrants** with traction inside the window: pi, Antigravity, Copilot CLI (repo at 78★ in Sep 2025), Kilo CLI, Factory Droid, Devin CLI and Grok Build. OpenClaw and Hermes are adjacent personal agents.

**Switching** follows model releases and pricing changes within weeks:
- Claude Code to Codex in fall 2025 and again in Sep 2026, and back after Opus 5.5.
- Codex went from about 5% to about 40% of Claude Code's usage between Sep 2025 and Jan 2026 [S].
- Corporate mandates flip within a quarter (Amazon, Microsoft).

**At repo level** (§1.3): half of the Cursor configs from Oct 2025 were removed, Claude configs grew fourfold, and every Roo and Kiro config in the sample was removed.

**Rule of thumb for palm.** Expect about one new harness worth supporting each quarter, and about one path, ownership or format change each month across the top ten. This supports PLAN §10.4, the scheduled compatibility job.

## 5. pi's configuration model (one page)

Source: the docs and code at tag **v1.0.0** (commit a13d35a, 2026-10-01) of **github.com/earendil-works/pi**; badlogic/pi-mono now redirects there. Paths are relative to `packages/coding-agent/`. The user dir is `~/.pi/agent`, which `PI_CODING_AGENT_DIR` can override.

**Instructions** (`src/core/resource-loader.ts`, `docs/configuration.md`)
- Pi loads one file per directory, the first that exists of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. So CLAUDE.md is read only when there is no AGENTS file.
- It reads the global `~/.pi/agent/AGENTS.md` first, then walks from cwd up to the filesystem root and concatenates root-first.
- These files load without project trust.
- `SYSTEM.md` replaces the system prompt and `APPEND_SYSTEM.md` appends to it. For each, `.pi/<file>` (trusted projects only) wins over `~/.pi/agent/<file>`.
- There are no scoped or glob rules.

**Skills** (`src/core/package-manager.ts`, `src/core/skills.ts`, `docs/skills.md`)
- Scanned in this order: `.pi/skills`, then `.agents/skills` in cwd and each ancestor up to the git root, then `~/.pi/agent/skills`, then `~/.agents/skills`. Project locations need trust.
- **`.claude/skills` is not read**; it was supported early on and later removed.
- Format is agentskills.io `SKILL.md`. Pi uses only `name`, `description` and `disable-model-invocation`. A skill without a description is skipped. On a name clash, the first one found wins.
- Skills are exposed as `/skill:name`. Extra paths can go in the `skills` array in settings.

**Prompt templates (commands)**
- Files: `.pi/prompts/*.md` and `~/.pi/agent/prompts/*.md`, direct children only.
- The filename becomes the command (`review.md` → `/review`).
- Frontmatter keys: `description` and `argument-hint`.
- Arguments: `$1`, `$@`, `$ARGUMENTS`, `${1:-default}`. This is close to Claude Code's command format.

**Subagents.** Not in core.
- An example extension reads `.pi/agents/*.md` and `~/.pi/agent/agents/*.md`.
- The community package **pi-subagents** reads the same directories plus legacy `.agents/**/*.md`, with frontmatter `name`, `description`, `tools` and `model`. It had 561K downloads in Sep 2026.

**Hooks.** There is **no declarative hook config**.
- Hooks are TypeScript "extensions" in `.pi/extensions/` and `~/.pi/agent/extensions/`: a `*.ts`/`*.js` file, a directory with an index file, or a `package.json` with `pi.extensions`. They load through jiti, with no build step.
- `src/core/extensions/types.ts` defines 41 events, including `tool_call` (which can block or change a call), `tool_result`, `input`, `before_agent_start`, `session_start`, `session_shutdown`, `agent_end` and `resources_discover`.
- A shim that runs `.claude` hooks exists but is barely used: `@jordyvanvorselen/pi-claude-hooks`, about 280 downloads a month.

**MCP.** Built in **since v0.99.0 (2026-09-29)** as `builtin:mcp` (`src/extensions/mcp/config.ts`, `docs/mcp.md`); before that it was deliberately left out.
- Files: `.pi/mcp.json` (trusted projects only) and `~/.pi/agent/mcp.json`. Both are strict JSON of the form `{"mcpServers":{…}}`.
- Keys: `command`/`args`/`env`/`cwd` or `url`/`headers`/`oauth`, plus `type` (`stdio|http|streamable-http`; **SSE is rejected**), `enabled`, `timeout`, `exposure`. `${VAR}` interpolation works.
- A project entry with the same name replaces the user entry. **The root `.mcp.json` is not read.** `pi mcp add [-l]` writes these files.
- The community `pi-mcp-adapter` (1.35M downloads a month) also reads `.mcp.json`.

**Settings**
- Files: `.pi/settings.json` and `~/.pi/agent/settings.json`. Project values override user values, and resource arrays are concatenated.
- Keys: `packages`, `extensions`, `skills`, `prompts`, `themes`, `enableSkillCommands`. Entries accept `!glob`, `+path` and `-path`.
- Pi rewrites these files under a lock and keeps keys it does not know.
- Trust decisions are stored in `~/.pi/agent/trust.json`.

**Packages**
- Install with `pi install npm:x@ver | git:host/repo@ref | ./path [-l]`.
- A package can ship extensions, skills, prompts and themes, but **not MCP config or context files**. It uses conventional directories or a `"pi"` key in `package.json`.
- Install locations: npm packages go to `~/.pi/agent/npm` (or `.pi/npm` with `-l`), git packages to `~/.pi/agent/git/<host>/<path>`.
- **There is no lock file**; pinning is the version or ref written in `settings.json`.
- The gallery at https://pi.dev/packages lists **5,394** packages tagged `pi-package` (2026-10-02).

**Reload.** There is no file watcher, so changes need `/reload` or a restart. Dotfiles and `node_modules` are skipped.

**Popularity**

| Measure | Value | Source |
|---|---|---|
| Stars | 111,740; 14,175 forks (2026-10-02) | gh API |
| Stars over time | 8 (2025-09-20), 29.5k (2026-03-31) | Wayback |
| npm downloads per month, both names | 1.13M (Jan 2026), 9.63M (Mar), 13.9M (Jun), 15.7M (Sep) | npm API; inflated, see 2.1 |
| Releases | 267 since Dec 2025 | GitHub |
| Weekly users | "hundreds of thousands" | Earendil, vendor (https://earendil.com/posts/pi-1-0/, 2026-10-01) |
| Repos in my sample with a `.pi/` dir | 5 of 1,190 | §1.3 |
| `SKILL.md` files under `.pi/skills` | 7,072 | code search, 2026-10-02 |

Other milestones:
- The Register covered the MCP change on 2026-10-02 (https://www.theregister.com/ai-and-ml/2026/10/02/pi-coding-agent-pulls-a-180-and-adds-mcp-support/5300678).
- OpenClaw embedded pi's runtime until May 2026; it has since internalised it.

**How palm's kinds map to pi**

| palm kind | pi target | Status |
|---|---|---|
| skill | `.agents/skills/<n>/` (already written by palm and shared with others) or `.pi/skills/`; global `~/.pi/agent/skills/` | native |
| instruction | Managed block in `AGENTS.md` (pi then ignores CLAUDE.md in that directory); optionally `.pi/APPEND_SYSTEM.md`; global `~/.pi/agent/AGENTS.md`. No scoped rules, so map them to skills with a note | native, one file per directory |
| command | `.pi/prompts/<n>.md`; global `~/.pi/agent/prompts/` | native |
| mcp | Merge into `mcpServers` in `.pi/mcp.json` or `~/.pi/agent/mcp.json`; refuse or flag `sse` | native since 0.99 |
| agent | `.pi/agents/*.md` | needs the pi-subagents package; warn |
| hook | None declarative | mark unsupported, or generate a TS extension shim in `.pi/extensions/` (executable material, consent needed) |

## 6. Consequences for palm's target list (PLAN §10.3)

**1. Fix what exists**
- Mark `gemini` as legacy (enterprise licences only).
- Add **antigravity** as its successor. Its layout under `.agents/` (`rules/`, `skills/`, `agents/`, `hooks.json`, `mcp_config.json` with `serverUrl`) overlaps heavily with palm's shared `.agents/skills`.
- Claude Code's new AGENTS.md fallback (2.1.277) matters for palm's "one carrier per harness" rule. In a project without CLAUDE.md, Claude now loads the AGENTS.md block **and** `.claude/rules`, so the same entity loads twice.

**2. Add pi.** Skills, instructions, commands and MCP are native and file-based. Subagents and hooks are the gaps.

**3. Next wave, in order:**
1. Kiro (Amazon mandate, fully file-based, its own hook schema).
2. Devin Desktop/CLI (Claude-compatible, still settling).
3. Junie.
4. Factory (Claude-shaped).
5. Kilo (OpenCode adapter).
6. Cline (script hooks, global MCP).
7. Qwen (Gemini adapter).

**4. No dedicated target; document compatibility instead**
- Amp, Goose, Zed, Warp, Crush, Augment, Kimi and Vibe read `AGENTS.md` and `.agents/skills` or `.claude/skills`, which palm already writes.
- Roo Code, Aider and Continue are dead or dormant.

## Sources (accessed 2026-10-02 unless noted)

**Surveys**
- Pragmatic Engineer, AI Tooling 2026 (2026-03-03): https://newsletter.pragmaticengineer.com/p/ai-tooling-2026
- Pragmatic Engineer, How Uber uses AI (2026-03-10): https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development
- GitLab AI Accountability Report (2026-06-23): https://about.gitlab.com/press/releases/2026-06-23-gitlab-research-reveals-organizations-are-generating-ai-code-faster-than-they-can-control-it/
- Sonar press release (2026-01-08): https://www.sonarsource.com/company/press-releases/sonar-data-reveals-critical-verification-gap-in-ai-coding/
- The Register on Sonar (2026-01-09): https://www.theregister.com/software/2026/01/09/devs-doubt-ai-written-code-but-dont-always-check-it/4932910
- Stack Overflow pulse (2026-05-27): https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work/
- Stack Overflow retrospective (2026-09-30): https://stackoverflow.blog/2026/09/30/getting-ready-for-2026-results-a-look-back-on-developer-survey-findings
- Stack Overflow Developer Survey 2025: https://survey.stackoverflow.co/2025/ai
- JetBrains (Apr 2026): https://blog.jetbrains.com/research/2026/04/which-ai-coding-tools-do-developers-actually-use-at-work/
- JetBrains (Aug 2026): https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/
- Greptile: https://www.greptile.com/state-of-ai-coding

**Vendors and events**
- Microsoft FY26 earnings: https://www.microsoft.com/en-us/investor/events/fy-2026/earnings-fy-2026-q1 and the matching q2–q4 pages
- Anthropic Series G (2026-02-12): https://www.anthropic.com/news/anthropic-raises-30-billion-series-g-funding-380-billion-post-money-valuation
- Gemini CLI transition (2026-05-19): https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- Antigravity migration: https://antigravity.google/docs/cli/gcli-migration/
- Devin Desktop (2026-06-02): https://devin.ai/blog/windsurf-is-now-devin-desktop
- Kilo and Anaconda (2026-07-15): https://blog.kilo.ai/p/anaconda-acquires-kilo-code
- Roo Code repo (archived 2026-05-15): https://github.com/RooCodeInc/Roo-Code
- Kilo, "Thank you, Roo": https://blog.kilo.ai/p/thank-you-roo
- Continue (read-only): https://github.com/continuedev/continue
- Amazon Q Developer end of support (2026-04-30): https://aws.amazon.com/blogs/devops/amazon-q-developer-end-of-support-announcement/
- Supermaven sunset (2025-11-21): https://supermaven.com/blog/sunsetting-supermaven
- Cursor ownership (SpaceX, closed 2026-08-14): https://en.wikipedia.org/wiki/Cursor_(company) and https://devops.com/spacex-to-acquire-ai-coding-leader-cursor-in-60-billion-blockbuster-deal/
- OpenAI cutting Cursor's model access: https://the-decoder.com/openai-cuts-off-cursor-after-spacex-acquisition-citing-musks-history-of-breaking-contracts/
- Microsoft and Claude Code (2026-05-15): https://winbuzzer.com/2026/05/15/microsoft-starts-canceling-claude-code-licenses-xcxwbn/
- Amazon relents (May 2026): https://developers.slashdot.org/story/26/05/10/0618225/amazon-relents-lets-its-programmers-use-openais-codex-and-anthropics-claude
- Shopify (2026-04-02): https://www.bvp.com/atlas/inside-shopifys-ai-first-engineering-playbook
- Stripe Minions (2026-02-19): https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2
- Every (2026-09-22): https://every.to/vibe-check/vibe-check-opus-5-5-is-pulling-our-codex-converts-back-to-claude
- Interconnects (2026-03-18): https://www.interconnects.ai/p/gpt-54-is-a-big-step-for-codex
- GitHub Agent HQ: https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/
- AAIF formation (2025-12-09): https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation
- AGENTS.md: https://agents.md/
- Agent Skills: https://agentskills.io/
- Claude Code CHANGELOG (2.1.277, 2026-09-18): https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- opencode.ai homepage (16M figure): https://opencode.ai

**pi**
- Repo at v1.0.0: https://github.com/earendil-works/pi/tree/v1.0.0
- Pi 1.0 announcement (2026-10-01): https://earendil.com/posts/pi-1-0/
- The Register (2026-10-02): https://www.theregister.com/ai-and-ml/2026/10/02/pi-coding-agent-pulls-a-180-and-adds-mcp-support/5300678
- Package gallery: https://pi.dev/packages
- Earendil acquisition: https://mitsuhiko.spicytakes.org/post/2026-04-08-mario-and-earendil
- pi-mcp-adapter: https://github.com/nicobailon/pi-mcp-adapter
- pi-subagents: https://github.com/nicobailon/pi-subagents

**Config docs used in §3** (via the config-survey agent, 2026-10-02)
- Amp: ampcode.com/docs/customize/*
- Kiro: kiro.dev/docs/{configuration,steering,skills,hooks,custom-agents,mcp}
- Devin: docs.devin.ai/cli/extensibility/*
- Cline: docs.cline.bot/customization/*
- Kilo: kilo.ai/docs/customize/*
- Junie: junie.jetbrains.com/docs/*.html
- Factory: docs.factory.com/harness/*
- Qwen Code: qwenlm.github.io/qwen-code-docs
- Antigravity: antigravity.google/docs/*
- Zed: zed.dev/docs/ai/*
- Goose: goose-docs.ai
- Mistral Vibe: docs.mistral.ai/vibe/code/cli/*
- Warp: docs.warp.dev/agents/*
- Crush: github.com/charmbracelet/crush README
- Kimi: moonshotai.github.io/kimi-cli
- Aider: aider.chat/docs/usage/conventions.html

**Own data (2026-10-02)**
- npm: api.npmjs.org/downloads/range/2025-09-01:2026-09-30/<pkg>
- VS Code Marketplace: the extensionquery API
- Wayback: archive.org/wayback/available and web.archive.org/cdx
- GitHub: gh api REST, GraphQL and search/code
