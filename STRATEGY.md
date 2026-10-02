# Does palm make sense? Assessment of 2026-10-02

Six research passes answered one question: is a cross-harness manager for agent
configuration still worth building, or are standards and vendors about to make it obsolete?
The reports with their sources are in `research/2026-10/` (R1 standards, R2 competitors,
R3 demand, R4 vendors, R5 usage, R6 positioning). This file is the maintainer's conclusion.

## 1. The short answer

palm is not obsolete, but half of what it advertises is. Translating one skill into six
harness folders loses value every month, because skills and the always-on instructions file
have converged and harnesses now read each other's folders. What has not converged, and what
no vendor or spec covers, is the part palm 0.2 is built around: a committed, pinned setup that
a clone gets without running anything, a lock that CI recomputes, and a yes for executable
content that is hashed over every script byte and replayed for teammates. That is the
product. The README and the landing page still lead with translation, and that has to change.

## 2. What the evidence says

Convergence (R1). Every harness except Aider uses `SKILL.md`; 13 of 15 read `.agents/skills`
(Claude Code and Kiro do not). `AGENTS.md`, run by the Linux Foundation's Agentic AI
Foundation, is read by default by 14 of 16 harnesses; Claude Code reads it since 2.1.277
(2026-09-18) when there is no `CLAUDE.md`. Scoped rules (eight incompatible formats),
subagents (about ten native formats), hooks (no spec; a Claude-style section was removed from
Agent Plugins on 2026-07-10) and MCP client config (about 14 file paths; the only proposal is
an unsponsored draft) are not converging. The Agent Plugins 1.0 committee wrote that hooks,
agents and rules "remain too client-specific for a stable portable contract".

Specs leave distribution out (R4). Agent Plugins 1.0 covers skills and MCP servers and calls
installation, dependencies, location, permissions and trust out of scope. Agent Skills has no
location, locking or distribution in its roadmap. The MCP Registry is still a preview after
13 months and is "not intended to be directly consumed by host applications". No model vendor
installs into a competitor's harness; Codex and Cursor import from others, one way. Team
distribution (org marketplaces, required plugins, enterprise plugins) works only inside each
vendor. Verdict in R4: a thin neutral layer stays needed, about 60 percent; a full manager
28 percent; nothing 12 percent.

Competitors (R2). Nobody does everything palm does. Microsoft APM is the closest (13
harnesses, a lock with content hashes, a CI audit, org policy, 61 releases this year); its
consent gate is off by default, approvals are per package rather than per version, and its
hook translation has shipped broken output. rulesync locks rules and skills across about 60
harnesses but asks no consent. Vercel's `npx skills` had about 27.5 million downloads in
September and does not record the resolved commit. The harnesses' own plugin systems beat palm
on admin push and catalogs; none has a project lockfile or a CI drift check. What only palm
does: consent that defaults to no, hashes every script byte, lives in the committed lock and
is replayed; one lock over all five kinds with committed outputs that `check` recomputes; a
clone that works without the tool, enforced; a secrets check in CI. palm ranks first on
reproducibility and safety and last on adoption.

Demand (R3). Three demands, not one. One source every harness reads is mass market and now
mostly solved for instructions (the Claude Code request had 6,686 reactions; the launch post
5.6 million views). Team distribution is growing and vendor-siloed (Claude #28729 159
reactions, #4800 open 14 months, Codex #18115 67 reactions). Security of executable config is
the steepest trend: three npm worms in 2026 persisted through SessionStart hooks in
`.claude/settings.json`, a typosquat campaign on skills.sh reached 1.7 million installs, and
GitGuardian found 2,117 valid secrets in public MCP configs. Only Codex re-checks hooks by
hash. Counterweights: 12.1 percent of repositories that commit agent config cover two or more
tools, hooks appear in 1.5 percent, and about 90 config managers launched on Show HN this
year with a median of 2 points.

Usage (R5). 91 percent of organisations run two or more AI coding tools and 70 percent of
developers use two to four, but 69 percent work in one main agent. Repositories with agent
config went from 9.3 to 29.5 percent in a year, and among those the share with two or more
config carriers from 25 to 55 percent. The harness set churns: Roo Code shut down, Gemini CLI
left consumers (Antigravity CLI replaces it, config under `.agents/`), Windsurf became Devin
Desktop, Aider went dormant, pi moved to `earendil-works/pi` and gained MCP on 2026-09-29.
pi: `AGENTS.md`, `.agents/skills` and `.pi/skills`, `.pi/prompts`, `.pi/mcp.json`, hooks only as
TypeScript extensions, packages without a lock.

Positioning (R6). Ranked by value and effort: team reproducibility with the CI gate first;
consent as the second message, not a market ("the only tool" is false because APM gates too;
what holds is the byte hash and `check --strict`); migration as the on-ramp; a GitHub Action
plus a public "verified against" matrix as distribution. Do not build an SDK or an MCP server
that installs things (agent-install has 3.1 million weekly downloads and agent-driven installs
contradict default-no consent), an org-policy product (Claude Code, Codex, Copilot, Cursor,
APM, Tessl and Runlayer ship it), or a hosted registry (Smithery sold, ClawHub carried 1,184
malicious skills, and 0.2 removed the registry client on evidence).

## 3. Decisions

1. Positioning. Tagline: "The same agent setup in every clone, checked in CI." The README
   leads with three bullets: one pull request sets up every agent; CI proves it still matches;
   programs need a yes you can read. "Package manager", "the only", "secure by default",
   "registry", "marketplace" and "one setup for every coding agent" leave the first lines. The
   docs hero and the npm description change with it. The comparison with APM is rewritten
   against APM as it is today (executables gate, hidden-Unicode scan, drift replay).
2. Proof before features. In order: a `PalionTech/palm-action` that runs `palm check --strict`;
   the CI guide as the second link on the landing page; a capture of `check` failing on a
   hand-added hook; `import` for `skills-lock.json` and `apm.yml`; a Renovate recipe; the
   generated "verified against" matrix from the compatibility job.
3. Translation stays, but as plumbing. Skills and always-on instructions placement is nearly
   free now and should read the Agent Plugins 1.0 and Agent Skills formats as sources. The
   value of translation is in the kinds that did not converge: scoped rules, subagents, hooks,
   per-project MCP config, and the one-carrier rule that stops double loading (Claude Code
   2.1.277 now loads palm's `AGENTS.md` block and `.claude/rules` twice in a project without
   `CLAUDE.md`; fix in 0.3).
4. Targets. Add pi and Antigravity CLI; mark `gemini` legacy (enterprise accounts only);
   compatibility notes rather than targets for Amp, Goose, Zed, Warp, Crush and Augment, which
   read what palm already writes; later, by usage: Kiro, Devin, Junie, Factory, Kilo, Cline,
   Qwen. The compatibility job of PLAN.md 10.4 is what keeps this list honest.
5. Not building: hosted registry or marketplace, an installer SDK or MCP server, an org-policy
   product. The global scope stays as a footnote for dotfiles users.
6. Say the limit openly. Hooks committed to a repository run on a teammate's machine once the
   harness trusts the folder, with no palm prompt (CVE-2025-59536 is that vector). For everyone
   but the person who installed them, the gate is pull-request review plus `palm check
   --strict` in CI. The security page states this in its first paragraph.

## 4. What this changes in PLAN.md

Section 7, 0.3: the carrier fix for Claude Code 2.1.277, `import`, and the Agent Plugins 1.0
source format move to the front; pi and Antigravity targets join; the hook mapping table and
agent field tables stay. Section 10: the installers and the pentest stay as written; "more
harnesses" follows the ranked list above; the compatibility job also publishes the matrix.

## 5. Risks

A vendor could add a repo-local lock and CI check tomorrow; APM is the nearest and is backed by
Microsoft. palm's defence is to be the neutral one that works for every harness a team uses,
to keep the consent model stricter than any vendor wants their own to be, and to ship the
GitHub Action before anyone else does. Adoption is near zero today and launch noise is high;
distribution through CI and the compatibility matrix beats another "package manager" launch.
