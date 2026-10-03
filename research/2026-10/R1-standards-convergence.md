# R1: Are coding harnesses converging on common formats?

Research date: 2026-10-02. The question is whether harnesses are converging on common formats for the five things palm manages (skills, instructions/rules, subagents, hooks, MCP server config) so completely that a cross-harness manager stops being needed.

**How this was researched**
- **Sources.** Official docs, official repos (source and docs folders, read through `gh api`), and official changelogs and release notes. Secondary sources are marked as such.
- **Detailed notes.** Per-harness notes with every claim tagged [V] (verified in a primary source) or [U] (uncertain) are in the same folder:
  - `notes-A-claude-codex-copilot.md`
  - `notes-B-cursor-gemini-opencode-pi.md`
  - `notes-C-amp-kiro-windsurf-cline.md`
  - `notes-D-roo-aider-zed-goose-junie.md`
- **Dates.** A date in a table is the page's "last updated" or DateApproved stamp. If the page shows none, it is the date of the last commit to the doc file. Failing both, it is the release that introduced the behaviour. "n.d." means the page shows no date; it was read on 2026-10-02.
- **Counting.** There are 17 rows but 16 harnesses: GitHub Copilot counts once in totals, with separate rows for the CLI and VS Code. Windsurf counts as its current agent, Devin Local (see "Harness churn").

**Versions current on 2026-10-02**

| Harness | Version |
|---|---|
| Claude Code | 2.1.287 |
| Codex CLI | rust-v0.160.0 |
| Copilot CLI | 1.0.91 |
| VS Code | 1.140 |
| pi | `@earendil-works/pi-coding-agent` 1.0.0 |

---

## Bottom line

Convergence is real, but uneven. It mostly happens because harnesses **read each other's directories**, not because they adopt one standard.

| Kind | State today | Full convergence in 12–24 months? |
|---|---|---|
| **Skills** | File format converged (`SKILL.md`, Agent Skills spec). Location nearly converged: 13 of the 15 harnesses that have skills read `.agents/skills`. The exceptions are Claude Code and Kiro. | **Likely for the format and project location**, if Claude Code adopts `.agents/skills`. Frontmatter semantics and user-scope paths will still differ. |
| **Instructions** | The always-on file converged on `AGENTS.md`: 14 of 16 read it by default, Claude Code only as a fallback since 2026-09-18. Scoped rules are not converging: there are 8 incompatible formats. | **Always-on: effectively done. Scoped rules: unlikely.** |
| **Subagents** | No spec. About 10 native formats (Markdown, TOML, JSON, YAML, code). `.claude/agents` is becoming a lingua franca that 3 other harnesses read live. Tool names, permissions and model ids don't port. | **Unlikely.** |
| **Hooks** | No spec. A Claude-derived hooks appendix was drafted in the Open Plugin spec, then removed before Agent Plugins 1.0. Claude's wire protocol is spreading (8 of 16), but files, event names and tool names differ. 3 harnesses use in-process code and 3 have no hooks. | **Unlikely.** |
| **MCP config** | Protocol standardised, client config not. SEP-2633 (`mcp.json`) is an unsponsored draft. `mcpServers` is the majority key (10 of 15), spread over about 14 different file paths. `.mcp.json` is gaining (Claude Code, both Copilot surfaces). | **Unlikely as a single file.** A larger `.mcp.json` majority is plausible. |

**Overall verdict:** within 12–24 months a cross-harness manager does **not** become unnecessary. Two things shrink: format translation for skills, and translation for always-on instructions. Three things remain:
- **Translation** for subagents, hooks, MCP config and scoped rules.
- **A new problem created by cross-reading.** Harnesses now load the same entity from several directories, so de-duplication matters more than before.
- **The supply-chain layer that no spec even attempts:** distribution, version pinning, a lockfile, review and consent for executables, and drift checks.

The standards bodies say this explicitly:
- **Agent Skills:** "does not mandate where skill directories live" and "We don't maintain a directory".
- **Agent Plugins:** "Client-managed installation, distribution, enablement, updates, and user interface are outside the portable specification".

---

## Standards landscape (checked 2026-10-02)

| Kind | Spec / body | Who backs it | Status | Key dates | What it leaves out |
|---|---|---|---|---|---|
| Skills | **Agent Skills** (agentskills.io; repo `agentskills/agentskills`, 25.9k stars) | Anthropic originated it: "originally developed by Anthropic, released as an open standard". Listing and logo requests are "reviewed by the Anthropic team". There is no charter or TSC file. **Not an AAIF project**: aaif.io/projects lists only MCP, goose, AGENTS.md, agentgateway, A2A and Agent Router. A secondary blog claims AAIF stewardship; the primary source does not support it. | Published spec; 46 clients in the showcase | Repo created 2025-12-16. Spec page last changed 2026-08-04. Showcase last changed 2026-08-09. | **Location.** "the Agent Skills specification does not mandate where skill directories live (it only defines what goes inside them)". `.agents/skills/` is only a *recommendation* in the client guide (file last changed 2026-03-09). No install, registry or versioning. |
| Instructions | **AGENTS.md** (agents.md; repo `agentsmd/agents.md`, 24.7k stars) | Contributed by OpenAI to the **Agentic AI Foundation (Linux Foundation)**, formed 2025-12-09. Founding platinum members: AWS, Anthropic, Block, Bloomberg, Cloudflare, Google, Microsoft, OpenAI. LF Projects technical charter "Adopted December 8, 2025" (PDF added to the repo 2026-09-10). AAIF had 146 members by 2026-02-24. | A convention, not a normative spec. The site lists 23+ tools. The LF claims ">60,000 open source projects". | Site 2025-08-19. AAIF 2025-12-09. | **Five gaps, each with an open proposal:**<br>• Scoped rules or frontmatter: issue #10 (2025-08-20) and `.agents/rules/` issue #179 (2026-04-15).<br>• Imports: #11.<br>• A user-level path: #91 proposes `~/.config/agents/AGENTS.md`.<br>• Sub-agents: #149.<br>• A written implementation spec: #211, opened 2026-06-25, which notes "It's not really a standard if no requirements are defined". |
| Packaging (skills + MCP) | **Agent Plugins 1.0.0** (agent-plugins.org; repo `agentplugins/agent-plugins-spec`) | TSC: Clare Liguori (Amazon), Roshan Sadanani (Cursor), Harald Kirschner (Microsoft), Gav Verma (OpenAI) and Jonathan Hefner (Vercel, lead). Google said it is joining (Google Developers Blog, 2026-08-06; carried over from the 2026-09-28 notes, not re-checked). **No Anthropic seat.** | 1.0.0 published 2026-07-24; the 1.1.0 draft (2026-08-12) only bumps versions. | Started as Vercel's "Open Plugin Specification v1.0.0" on 2026-04-03 and was renamed on 2026-07-17. | Covers skills and a plugin-local `mcp.json` only. "commands, hooks, agents, rules, and LSP servers — remain too client-specific for a stable portable contract and are outside the v1 format until their formats converge." |
| Subagents | **None** from any harness vendor or foundation | — | Only small independent proposals: Open Agent Profile (0 stars, 2026-08-14). Oracle's Open Agent Spec targets agent frameworks, not harness subagent files. | — | Everything. |
| Hooks | **None.** The Open Plugin draft (2026-04-03) had an optional Appendix E.4: `hooks/hooks.json`, Claude event names `PreToolUse`/`PostToolUse`/…, action types `command`/`http`/`prompt`/`agent`. Commit `6a505752` "Remove host-specific hook event catalog" (2026-07-10) took it out before 1.0. | — | No AAIF project, no MCP SEP. | — | Everything. |
| MCP client config | **None normative.** The MCP spec (current revision 2026-07-28) covers the wire protocol, and the registry's `server.json` covers the publisher side.<br>• **SEP-2633** "Standard Client-Side Configuration Format - mcp.json": draft PR, no sponsor label. Its motivation: clients "use different file names … different top-level keys (including "servers" and "mcpServers") … different values for the `type` field … different mechanisms … for secret interpolation".<br>• Discussion #2218 (2026-02-06).<br>• Agent Plugins `mcp.json` (`mcpServers`; `type: stdio`, `streamable-http` or `sse`). | MCP is under AAIF (contributed by Anthropic). | SEP-2633 opened 2026-04-22, last activity 2026-07-28. Under the SEP guidelines a PR waits "up to 6 months" for a sponsor, then goes Dormant, so around 2026-10-22. | Agent Plugins itself says: "Clients map this portable format to their native configuration; its field names and values need not match a client-native format." |

**Evidence from the vendors' own cross-harness installers.** Vendors themselves ship tools that place files per harness. That shows they don't expect a single location soon.
- **`gh skill` (GitHub, gh 2.97.0, 2026-07-31).** It places skills "in a host-specific directory" and accepts about 50 `--agent` values.
- **`npx skills` (Vercel; vercel-labs/skills README, 2026-09-26).** It maps 79 agent ids, and only 23 of them install to project `.agents/skills`.

The second table is also the clearest trend measure. The count of agent ids mapped to project `.agents/skills` grew steadily:

| Date | Agent ids mapped to `.agents/skills` |
|---|---|
| 2026-01-25 | 1 of 25 (Amp) |
| 2026-04-01 | 14 of 47 |
| 2026-07-01 | 19 of 74 |
| 2026-10-02 | 23 of 81 |

These counts come from README snapshots at those dates. On 2026-01-25 Codex, Cursor, Gemini, Copilot and OpenCode still had their own directories; today all five are on `.agents/skills`. The long tail of new agents still mostly launches with a private `.<name>/skills`.

---

## 1. Skills

| Harness | Native location (project · user) | Reads `.agents/skills`? | Reads foreign skill dirs live? | Source (date) |
|---|---|---|---|---|
| Claude Code | `.claude/skills` (ancestors to the repo root, nested ones on demand) · `~/.claude/skills`. Frontmatter extends the spec with `context: fork`, `hooks`, `paths`, `model`, `effort` and more. | **No** | No | CC-SKILLS (n.d.); skills since v2.0.20, 2025-10-16 |
| Codex CLI | `.agents/skills` (working dir up to the repo root) · `~/.agents/skills`, `/etc/codex/skills`. The source also loads `.codex/skills`, which the docs don't list. Honours only `name`, `description` and `metadata.short-description`; extras go in `agents/openai.yaml`. | **Yes, as the primary location** (v0.94.0 2026-02-02 / v0.95.0 2026-02-04) | No. `.claude/skills` only through a one-shot `/import`. | CX-SKILLS, CX-IMPORT (n.d.); CX-SRC @ HEAD 2026-10-02 |
| Copilot CLI | `.github/skills` > `.agents/skills` > `.claude/skills` · `~/.copilot/skills`, `~/.agents/skills` | Yes (0.0.401, 2026-02-03) | `.claude/skills` since launch (2025-12-18). User-level `~/.claude/*` was **dropped** in 1.0.36 (2026-04-24). | CP-REF (2026-10-02); CP-CL |
| VS Code (Copilot) | `.github/skills` · `~/.copilot/skills` | Yes (commit 2026-02-03; exact release [U]) | `.claude/skills`, `~/.claude/skills` (1.107, 2025-12-10) | VS-SKILLS (DateApproved 2026-09-30) |
| Cursor | `.cursor/skills` · `~/.cursor/skills`, nested copies included | Yes | `.claude/skills`, `.codex/skills` and their user equivalents, behind the "Third-Party Imports" toggle (default on) | CU-SKILLS (n.d.); 2.4, 2026-01-22 |
| Gemini CLI | `.gemini/skills` · `~/.gemini/skills` | Yes; it wins over `.gemini/skills` in the same tier (v0.28.0, 2026-02-10) | No | GE-SKILLS (2026-04-30) |
| OpenCode | `.opencode/skills` · `~/.config/opencode/skills` | Yes (v1.1.50, 2026-02-04) | `.claude/skills`, `~/.claude/skills` (v1.0.208, 2025-12-29) | OC-SKILLS (2026-02-04) |
| pi | `.pi/skills` · `~/.pi/agent/skills` | Yes (v0.54.0, 2026-02-19) | Only if added in settings. Automatic reading of `~/.claude/skills` and `~/.codex/skills` was **removed** in v0.50.0 (2026-01-26). | PI-SKILLS (2026-09-22) |
| Amp | `.agents/skills` · `~/.config/agents/skills`, `~/.config/amp/skills` | Yes (native) | `.claude/skills`, `~/.claude/skills`, the Claude plugin cache | AM-SKILLS (n.d.); ampcode.com/news/agent-skills 2025-12-10 |
| Kiro | `.kiro/skills` · `~/.kiro/skills`; Powers use the Agent Plugins `skills/` | **No** | No (import means copying) | KI-SKILLS (updated 2026-09-02); CLI 1.24.0 2026-01-16, IDE 0.9 2026-02-05 |
| Windsurf, now Devin Desktop (agent: Devin Local / Devin CLI) | `.devin/skills` (legacy `.windsurf/skills`) · `~/.config/devin/skills` | Yes. Cascade, before its removal, had read it since 2026-02-12. | `.claude/skills`, `.claude/commands`, `.github/skills`, `~/.copilot/skills`, `.cursor/skills` (the last since 2026-09-10) | DV-SKILLS (n.d.); CLI changelog 2026-03 to 2026-09 |
| Cline | `.cline/skills`, `.clinerules/skills` · `~/.cline/skills` | Yes in source; not in the docs [U] | `.claude/skills` (docs) | CL-SKILLS (2026-06-26); v3.48.0 2026-01-09 |
| Roo Code (archived 2026-05-15) | `.roo/skills[-mode]` · `~/.roo/skills` | Yes (v3.47.2, 2026-02-05) | No | RO-SKILLS (2026-05-12) |
| Aider | — (no skills) | — | — | Last GitHub release v0.86.0, 2025-08-09; the cecli fork adds skills |
| Zed | none of its own | **Yes, its only location** (v1.4, 2026-05-27; custom paths unsupported) | No | ZE-SKILLS (2026-09-19) |
| Goose | `.goose/skills` · `~/.config/goose/skills` | Yes, documented as "recommended" (v1.18.0, 2025-12-19) | `.claude/skills`, `~/.claude/skills` | GO-SKILLS (2026-08-19) |
| JetBrains Junie | `.junie/skills` · `~/.junie/skills` | Yes, for trusted projects. It first appears in docs between the 2026-08-14 and 2026-09-09 snapshots. | Import only: it offers to copy `.claude`, `.cursor` and `.codex` skills | JU-SKILLS (site build 2026-10-01) |

**Shared location and format**
- 15 of 16 harnesses load `SKILL.md`; Aider is the exception. 13 of those 15 read `.agents/skills`; Claude Code and Kiro do not.
- 7 also read `.claude/skills` live: Copilot, Cursor, OpenCode, Amp, Devin, Cline and Goose. Counting Claude Code itself, 8 read it.
- So writing to `.agents/skills` and `.claude/skills` reaches 14 of 15. Only Kiro needs its own copy.
- But 7 harnesses would then see the same skill twice. The Agent Skills client guide only says to "pick one and be consistent. Log a warning".

**Standard.** Agent Skills (Anthropic-originated, informally governed) fixes the format but not the location.

**Trend over 12 months**
- Before Dec 2025 only Claude Code had skills.
- From December 2025 to February 2026 nearly every major harness added `SKILL.md`, then `.agents/skills`:
  - Goose 2025-12-19.
  - Codex 2026-02-02, Copilot CLI 2026-02-03, OpenCode 2026-02-04, Roo 2026-02-05.
  - Gemini 2026-02-10, Cascade 2026-02-12, pi 2026-02-19.
  - Zed 2026-05 and Junie around 2026-08/09.
- Cross-reading is not monotonic: pi (2026-01-26) and Copilot CLI (2026-04-24) both *stopped* reading user-level Claude dirs.

**Judgement.** Format: already converged. Project location: likely to converge within 12–24 months, *if* Claude Code adopts `.agents/skills`.
- Anthropic's own client guide recommends `.agents/skills`.
- Claude Code has just conceded AGENTS.md (2.1.277, 2026-09-18), after holding out for 13 months against agents.md issue #34 (2025-08-29). That shows it yields when adoption is overwhelming.
- Kiro keeps everything under `.kiro/`.

What will not converge:
- **User-scope paths:** `~/.agents/skills`, `~/.config/agents/skills` (Amp) and `~/.codex/skills` (deprecated).
- **Frontmatter semantics**, e.g. Claude's `context: fork` and `hooks`, Cursor's `paths` and `icon`, Codex's `agents/openai.yaml`.

---

## 2. Instructions / rules

| Harness | Always-on files | `AGENTS.md` | Scoped / conditional rule format | Foreign files read | Source (date) |
|---|---|---|---|---|---|
| Claude Code | `CLAUDE.md` hierarchy (managed, user, project, `.claude/`, ancestors, subdirs on demand), `CLAUDE.local.md` | **Fallback only**, when a folder has no CLAUDE.md (2.1.277, 2026-09-18). Can be switched to read both in `/config`. Extended to Bedrock/Vertex/Foundry in 2.1.281 (2026-09-23). | `.claude/rules/**/*.md` with `paths:` (v2.0.64, 2025-12-10) | AGENTS.md as fallback | CC-MEM (n.d.); CC-CL |
| Codex CLI | `AGENTS.override.md` > `AGENTS.md` per directory, root to cwd; `~/.codex/AGENTS.md`; 32 KiB cap | Native (originator) | **None.** Nested AGENTS.md only; Codex "rules" are Starlark command policy. | Only via `project_doc_fallback_filenames`; `/import` converts | CX-AGENTSMD (n.d.); CX-SRC |
| Copilot CLI | AGENTS.md, CLAUDE.md, `.claude/CLAUDE.md`, GEMINI.md, `.github/copilot-instructions.md` | Yes | `.github/instructions/**/*.instructions.md` (`applyTo`), and `.claude/rules` (`paths`) since 1.0.89 (2026-09-28) | CLAUDE.md, GEMINI.md, `.claude/rules` | CP-REF (2026-10-02); CP-CL |
| VS Code (Copilot) | `.github/copilot-instructions.md`, AGENTS.md (nested is opt-in), CLAUDE.md, `.claude/CLAUDE.md`, `~/.claude/CLAUDE.md` | Yes (1.104, 2025-09-11) | `.github/instructions` (`applyTo`) and `.claude/rules` (`paths`) (1.109, 2026-02-04) | CLAUDE.md, `.claude/rules`; not GEMINI.md | VS-INSTR (2026-09-30) |
| Cursor | AGENTS.md (root and nested), CLAUDE.md (per the help center, not the rules reference), User/Team Rules, `~/.cursor/rules` | Yes | `.cursor/rules/**/*.mdc` (`description`, `globs`, `alwaysApply`); a plain `.md` there "is ignored" | CLAUDE.md | CU-RULES (n.d.); 2.1, 2025-11-21 |
| Gemini CLI | `GEMINI.md` (global, ancestors, loaded when a file is touched) | **Only if listed in `context.fileName`** | None | AGENTS.md or CLAUDE.md only by configuration | GE-GEMINIMD (2026-06-18) |
| OpenCode | AGENTS.md, else CLAUDE.md; globally `~/.config/opencode/AGENTS.md`, else `~/.claude/CLAUDE.md` | Yes | None native; `instructions: []` with globs or URLs | CLAUDE.md fallback; the unfinished v2 core reads AGENTS.md only [U] | OC-RULES (2026-04-01) |
| pi | Per directory, the first of `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` | Yes | None | CLAUDE.md fallback | PI-CONFIG (2026-09-29) |
| Amp | AGENTS.md (cwd, parents, subtrees), `~/.config/amp/AGENTS.md` | Yes (2025-08-20) | @-mentioned files with `globs:` | `AGENT.md` or `CLAUDE.md` fallback | AM-AGENTSMD (n.d.) |
| Kiro | `.kiro/steering/*.md`, `~/.kiro/steering/`, AGENTS.md | Yes (IDE 0.5, 2025-10-31; nested 2026-08) | Steering frontmatter `inclusion: always/fileMatch/manual/auto` with `fileMatchPattern` | No CLAUDE.md | KI-STEERING (updated 2026-10-02) |
| Windsurf → Devin Local | `.devin/rules`, `.windsurf/rules`, `.windsurfrules`, AGENTS.md, `AGENTS.local.md`, CLAUDE.md, `~/.claude/CLAUDE.md` | Yes (Cascade since 2025-10-23) | `trigger: always_on/model_decision/glob/manual` with `globs`; also Cursor `.mdc` | CLAUDE.md, `.cursor/rules` | DV-RULES (n.d.) |
| Cline | `.clinerules/`, `.cline/rules/`, AGENTS.md, `~/.agents/AGENTS.md` | Yes (v3.37.1, 2025-11-14) | `paths:` frontmatter | `.cursorrules`, `.cursor/rules` (source), `.windsurfrules`; not CLAUDE.md | CL-RULES (2026-09-19) |
| Roo Code (archived) | `.roo/rules/`, `rules-{mode}/`, `.roorules`, `.clinerules` | Yes, root (v3.24.0, 2025-07-25) | Mode-scoped directories only | `.clinerules` | RO-INSTR (2026-05-12) |
| Aider | Only files passed with `--read` or `read:` (e.g. CONVENTIONS.md) | No (manual) | None | None | AI-CONV (2024-12-13) |
| Zed | The **first match** of `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`; `~/.config/zed/AGENTS.md` | Yes (v0.190, 2025-06), unless a higher-priority file exists | None | 8 foreign names, first match only | ZE-INSTR (2026-09-19) |
| Goose | `.goosehints` and AGENTS.md (root to cwd, nested as touched), `~/.agents/AGENTS.md` (v1.39.0, 2026-06-25) | Yes, by default (v1.6.0, 2025-08-22) | None (by directory only) | CLAUDE.md opt-in via `CONTEXT_FILE_NAMES` | GO-HINTS (2026-06-16) |
| JetBrains Junie | `.junie/AGENTS.md` alone; otherwise root AGENTS.md, `.junie/playbook.md` and `.junie/rules/*.md`; `~/.junie/AGENTS.md` | Yes | None documented | Import only | JU-GUIDE (site build 2026-10-01) |

**Shared location and format**
- **AGENTS.md is read by default by 14 of 16.** Claude Code reads it only as a fallback; Zed only when no higher-priority file exists. Gemini needs it configured, and Aider needs a manual `--read`.
- **CLAUDE.md is the second shared file**, read by Copilot, Cursor, OpenCode, pi, Amp, Devin and Zed.
- **Scoped rules have at least 8 incompatible formats:**
  - `.claude/rules` with `paths`: Claude Code, Copilot CLI, VS Code.
  - `.github/instructions` with `applyTo`: Copilot CLI, VS Code.
  - `.cursor/rules/*.mdc` with `globs`: Cursor; also read by Devin and Cline.
  - Kiro steering with `fileMatchPattern`.
  - Windsurf/Devin `trigger: glob`.
  - Cline `paths`.
  - Amp `globs` in @-mentioned files.
  - Roo mode directories.
- Codex, Gemini, OpenCode, pi, Zed, Goose, Junie and Aider have **no** scoped format at all. Nested AGENTS.md (scope by directory) is the only shared scoping mechanism.

**Standard.** AGENTS.md, under AAIF/LF since 2025-12-09. It has no normative text, no frontmatter, no imports and no user-level path. The proposals for each have been open since August 2025.

**Trend over 12 months.** AGENTS.md went from "Codex plus a few" to universal:
- VS Code 2025-09, Kiro 2025-10, Cascade 2025-10, Cline 2025-11.
- Claude Code (fallback) 2026-09-18.

For scoped rules, the only movement is Microsoft adopting Claude's `.claude/rules`: VS Code in 2026-02, Copilot CLI on 2026-09-28.

**Judgement**
- **Always-on instructions:** converged now in practice. One caveat: Claude Code ignores AGENTS.md when a CLAUDE.md exists (the default setting), so mixed repos still need both files or an `@AGENTS.md` import.
- **Scoped rules:** full convergence within 24 months is unlikely.
  - There is no spec work. The frontmatter issue (#10) has been open since 2025-08-20.
  - Cursor `.mdc`, Kiro steering and Windsurf triggers are entrenched.
  - At best, `.claude/rules` becomes a second de facto format.

---

## 3. Subagents / custom agents

| Harness | Native location · container | Schema notes | Foreign or shared dirs read | Source (date) |
|---|---|---|---|---|
| Claude Code | `.claude/agents/*.md`, `~/.claude/agents` · Markdown + YAML | `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `skills`, `mcpServers`, `hooks`, `memory`, `isolation` | None | CC-SUB (n.d.); since v1.0.60, 2025-07-24 |
| Codex CLI | `.codex/agents/*.toml`, `~/.codex/agents` · **TOML**; `[agents]` in config.toml | Requires `name`, `description` and `developer_instructions`; any config key is allowed | None live; `/import` converts `.claude/agents` | CX-SUB (n.d.); files via PR #14177, merged 2026-03-10 |
| Copilot CLI | `.github/agents/*.agent.md`, `~/.copilot/agents` · Markdown + YAML | `description`, `tools`, `model(s)`, `mcp-servers`, `infer`, … | **`.claude/agents`** (project only, Claude tool names mapped); `~/.claude/agents` dropped 2026-04-24 | CP-AGENTS (2026-09-30) |
| VS Code (Copilot) | `.github/agents/*.agent.md`, `~/.copilot/agents` | `tools`, `agents`, `model`, `handoffs`, `target`, `hooks` | **`.claude/agents`, `~/.claude/agents`** (1.109, 2026-02-04). `.agents/agents` is only proposed (open PR #331160). | VS-AGENTS (2026-09-30) |
| Cursor | `.cursor/agents`, `~/.cursor/agents` · Markdown + YAML | `name`, `description`, `model`, `readonly`, `is_background` | **`.claude/agents`, `.codex/agents`** and their user equivalents; `.cursor/` wins on a name clash | CU-SUB (n.d.); 2.4, 2026-01-22 |
| Gemini CLI | `.gemini/agents/*.md`, `~/.gemini/agents` · Markdown + YAML, **strict** (an unknown key rejects the file) | `kind`, `tools` (Gemini tool names), `mcpServers` (source: `mcp_servers`), `model`, `max_turns`, `timeout_mins` | None | GE-SUB (2026-06-08); on by default from v0.35.0, 2026-03-24 |
| OpenCode | `.opencode/agents`, `~/.config/opencode/agents` · Markdown + YAML or JSON | `mode: subagent`, `permission` map, `model` as "provider/id"; unknown keys go to the provider | None | OC-AGENTS (2026-05-08) |
| pi | None built in. The README says it "skips features like sub-agents"; there is an example extension. | — | — | PI README (2026-10-02) |
| Amp | None in files. Custom agents are TypeScript (`amp.createAgent`). | code | None | AM-PLUGINS (n.d.); news 2026-06-19 |
| Kiro | `.kiro/agents/*.json` or `*.md`, `~/.kiro/agents` | `prompt`, `tools` (tags), `resources`, `mcpServers`, `includeMcpJson` | None | KI-AGENTS (updated 2026-09-02) |
| Windsurf → Devin Local | `.devin/agents`, **`.agents/agents`**, `~/.config/devin/agents` · `<name>.md` or `<name>/AGENT.md` | `allowed-tools`, `max-nesting` | `.agents/agents`; `.claude/agents` is undocumented [U] | DV-SUB (n.d.); 2026-03-23 |
| Cline | `.cline/agents/*.yaml`, `~/.cline/agents` (source; not in the user docs) | `providerId`, `modelId`, `maxIterations`, `skills` | None | CL-SUB (2026-05-12); source 2026-07-17 |
| Roo Code (archived) | `.roomodes` YAML/JSON custom modes | `slug`, `roleDefinition`, `groups` | None | RO-MODES (2026-05-12) |
| Aider | none | — | — | — |
| Zed | None in files: a built-in `spawn_agent` tool (v0.227, 2026-03-04) and profiles in settings.json | — | None | ZE-TOOLS (2026-07-01) |
| Goose | `.agents/agents`, `.goose/agents`, `~/.config/goose/agents` · Markdown + YAML | `name`, `description`, `model` | **`.claude/agents`, `~/.claude/agents`** (v1.25.0, 2026-02-18) | GO-AGENTS (2026-06-22) |
| JetBrains Junie | `.junie/agents`, **`.agents/*.md`** (not `.agents/agents/`), `~/.agents/` | Claude-like: `tools`, `disallowedTools`, `mcpServers`, `permissionMode`, `maxTurns`, `skills` | `.claude/.cursor/.codex` agents are import only | JU-SUB (page exists since 2026-03-10) |

**Shared location and format**
- 12 of 16 have file-defined subagents. They use about 10 native container/location combinations: Markdown in 7 directory conventions, plus TOML (Codex), JSON (Kiro), YAML (Cline, Roo) and code (Amp).
- **`.claude/agents` is read live by Copilot (CLI and VS Code), Cursor and Goose.** Codex and Junie convert it on import.
- **`.agents/agents` is emerging, with a conflict:** Devin and Goose use `.agents/agents`, Junie uses `.agents/*.md`, and VS Code has only a proposal.
- **The real barrier is inside the file:**
  - Tool vocabularies differ (Claude `Read`/`Bash`, Gemini `read_file`/`run_shell_command`, OpenCode's `permission` map).
  - Model ids are vendor-specific.
  - Gemini rejects unknown keys, and OpenCode forwards them to the model provider.

**Standard.** None. Agent Plugins 1.0 explicitly excludes "agents". AGENTS.md issue #149 (2026-02-08) is open.

**Trend over 12 months.** Rapid spread of the *concept*: Copilot 2025-10/11, Cursor 2026-01, Codex 2026-02/03, Gemini 2026-03, Kiro, Devin, Goose and Junie in spring 2026. Microsoft, Cursor and Goose began reading `.claude/agents`.

**Judgement.** Full convergence within 24 months is unlikely: there is no venue, the TSC that tried declared it out of scope, and the schemas encode each harness's tool and permission model. Expect `.claude/agents` to grow as a lingua franca, but with each reader mapping, dropping or rejecting fields differently. That is precisely a translation job.

---

## 4. Hooks

| Harness | Mechanism and config | Event vocabulary | Claude-format compatibility | Source (date) |
|---|---|---|---|---|
| Claude Code | `command`, `http`, `mcp_tool`, `prompt` and `agent` handlers in `settings.json` (`~/.claude`, `.claude/settings(.local).json`), plugins and frontmatter | 33 PascalCase events | Reference format: JSON on stdin, exit 2 blocks, JSON on stdout | CC-HOOKS (n.d.); since 1.0.38 2025-06-30; http 2026-02-28; mcp_tool 2026-04-22 |
| Codex CLI | `hooks.json` or `[hooks]` in config.toml (`~/.codex`, `.codex`) | 12 PascalCase (a subset); `prompt` and `agent` are parsed but skipped | **Same JSON shape and wire protocol**, sets `CLAUDE_PLUGIN_ROOT`; does **not** read `.claude/settings.json` (`/import` converts) | CX-HOOKS (n.d.); v0.114.0 2026-03-11, stable v0.124.0 2026-04-23 |
| Copilot CLI | `.github/hooks/*.json`, `~/.copilot/hooks`, settings files | camelCase with PascalCase aliases; `command`, `http`, `prompt` | **Reads repo `.claude/settings(.local).json` live** (1.0.12, 2026-03-26); Claude matcher format (1.0.6) | CP-HOOKREF (2026-10-02); CP-CL |
| VS Code (Copilot) | The Copilot harness uses the Copilot CLI implementation. The legacy Local agent reads `.github/hooks` and `~/.copilot/hooks`. | Local agent: 8 PascalCase, `command` only | `.claude/settings.json` only behind `chat.useClaudeHooks` (**default off**), and matchers are ignored | VS-HOOKS (2026-09-30) |
| Cursor | `.cursor/hooks.json`, `~/.cursor/hooks.json` (`version: 1`), MDM and team copies | 21 camelCase; `command` or `prompt` | **Live-loads** `.claude/settings.local.json`, `.claude/settings.json` and `~/.claude/settings.json` (Third-Party Imports, default on), mapping event names. `Notification` and `PermissionRequest` are unsupported, and there is no `Glob` equivalent. | CU-HOOKS, CU-3P (n.d.); hooks 1.7 2025-09-29; Claude import CLI 2026-01 |
| Gemini CLI | `hooks` in `.gemini/settings.json`, `~/.gemini/settings.json`, system settings and extensions | 11 PascalCase, but its own names (`BeforeTool`, `AfterAgent`, `PreCompress`…); timeout in ms | Claude-shaped schema and `CLAUDE_PROJECT_DIR` alias; a one-shot `gemini hooks migrate --from-claude` renames events and tools. No live loading. | GE-HOOKS (2026-04-13); v0.21.0 2025-12-16, default on v0.27.0 2026-02-04 |
| OpenCode | **In-process JS/TS plugins** | `tool.execute.before/after`, `permission.ask`, `event` | No | OC-PLUGINS (2026-02-20) |
| pi | **In-process TS extensions** (called "hooks" until v0.35.0, 2026-01-05) | about 41 snake_case | No | PI-EXT (2026-09-30) |
| Amp | **In-process TS plugin API** (`amp.on`), since the "Neo" rebuild | 6 dotted names | No | AM-PLUGINS (n.d.); Neo 2026-05-06 |
| Kiro | `.kiro/hooks/*.json`, `~/.kiro/hooks` (`version: "v1"`); legacy `*.kiro.hook` and hooks in agent JSON | Claude-style PascalCase plus file and spec-task events | Own file schema; does not read Claude files. One doc says exit 2 blocks, another says any non-zero blocks. | KI-HOOKS (updated 2026-09-30); IDE 1.0 2026-06-25 |
| Windsurf → Devin Local | `.devin/hooks.v1.json`, config files | Claude's events | **Reads `.claude/settings(.local).json`, `~/.claude.json` and `~/.claude/settings.json` natively**. Cascade (removed 2026-09-08) used its own 12 snake_case events in `.windsurf/hooks.json`. | DV-HOOKS (n.d.); 2026-03-23 / 2026-04-01 |
| Cline | Executables named after the event in `.clinerules/hooks`, `.cline/hooks`, `~/.cline/hooks` | `TaskStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`… | Some names overlap; its own JSON I/O (`cancel`, `context`, `overrideInput`) | CL-HOOKS (2026-09-03); v3.36.0 2025-11-06 |
| Roo Code (archived) | none (Claude-style hook PRs never merged) | — | — | RO repo (archived 2026-05-15) |
| Aider | none (only lint/test commands) | — | — | AI-LINT (2025-05-02) |
| Zed | none for the agent | — | — | ZE-TASKS (2026-06-09) |
| Goose | `hooks/hooks.json` **inside plugins only** (`.agents/plugins/<p>/`, `~/.agents/plugins/<p>/`) | 12, Claude-named | Follows the withdrawn Open Plugin draft hooks: Claude-shaped, but the payload key is `event`, not `hook_event_name`. Tool names are Goose's. Does not read `.claude/settings.json`. | GO-HOOKS (2026-09-21); v1.41.0 2026-07-03 |
| JetBrains Junie | `hooks` in `~/.junie/config.json`; project hooks only via `--config-location`; extension `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}` | 7 Claude events | Claude wire format (`hook_event_name`, `tool_input`, `hookSpecificOutput`, exit 2); the docs claim scripts can be reused | JU-HOOKS (page exists since 2026-07-29; Early Access) |

**Shared location and format**
- **Claude's wire protocol** (JSON on stdin, exit 2 blocks, `PreToolUse`-style events) is used or mapped by 8 of 16: Codex, Copilot, Cursor, Gemini (renamed events), Kiro, Devin, Goose and Junie.
- **Claude's own files are read live** by Copilot CLI, Cursor and Devin, and by VS Code behind an opt-in that defaults to off.
- Three harnesses (OpenCode, pi, Amp) use in-process code that cannot run a shell hook declaration. Three (Roo, Aider, Zed) have no hooks.
- **Even "compatible" readers differ:** the event set (Cursor 21 vs Codex 12 vs Junie 7), handler types, matcher semantics, the payload key (Goose), and the **tool names inside payloads**. A script that tests `tool_name == "Bash"` breaks under Gemini, Goose or Cursor.

**Standard.** None. The one attempt (Open Plugin draft Appendix E.4, 2026-04-03) was removed on 2026-07-10. The multi-vendor TSC now calls hooks "too client-specific … until their formats converge".

**Trend over 12 months.** Fast and toward Claude:
- Cursor 2025-09, Cline 2025-11, Gemini 2025-12, Codex 2026-03, Copilot reading Claude files 2026-03.
- Devin 2026-03/04, Kiro 2026-06, Goose 2026-07, Junie 2026-07.

The independent source-code study of 11 harnesses (arXiv 2609.00006, secondary) reports "Codex adopts Claude Code's hook vocabulary verbatim and ships an importer".

**Judgement.** Expect deeper *semantic* convergence on Claude's protocol. Full convergence (one file, one event set, portable payloads) within 24 months is unlikely, for three reasons:
- No standards venue is working on it.
- The in-process-plugin harnesses are a different architecture.
- Payloads carry harness-specific tool names.

Hooks also carry the highest security stakes, so the translation needs a reviewer. Silent cross-reading (Cursor's default-on import of `~/.claude/settings.json`) is itself a risk to manage.

---

## 5. MCP server configuration

| Harness | Project file | User file | Format · key | Transport, interpolation | Reads `.mcp.json`? | Source (date) |
|---|---|---|---|---|---|---|
| Claude Code | `.mcp.json` | `~/.claude.json` | JSON `mcpServers` | `type: stdio/http/sse/ws`; `${VAR}`, `${VAR:-default}` | Native | CC-MCP (n.d.) |
| Codex CLI | `.codex/config.toml` (trusted projects) | `~/.codex/config.toml` | **TOML** `[mcp_servers.<n>]` | No `type`; `bearer_token_env_var`, `env_vars`, `env_http_headers`; no `${}` | No (only plugins may ship `.mcp.json`; `/import` converts) | CX-MCP (n.d.); project config v0.78.0 2026-01-06 |
| Copilot CLI | `.mcp.json` (searched up to the repo root), `.github/mcp.json` | `~/.copilot/mcp-config.json` | JSON `mcpServers` (or a bare map) | `type: local/stdio/http/sse`; `tools` is required; `${VAR:-default}` | **Yes.** `.vscode/mcp.json` was added, then **removed** in 1.0.22 (2026-04-09). | CP-MCP (2026-09-30); CP-CL |
| VS Code (Copilot) | **`.mcp.json`** (1.118, 2026-04-29); `.vscode/mcp.json` **deprecated** in 1.140 | `~/.copilot/mcp-config.json` (1.140, 2026-09-30); the profile `mcp.json` is deprecated | `servers` (legacy format) or `mcpServers` | `${input:}`, `${env:}`, `${workspaceFolder}` | Yes. Discovery of Claude Desktop, Cursor and Windsurf configs is opt-in. | VS-MCP, VS-1.140 (2026-09-30) |
| Cursor | `.cursor/mcp.json` | `~/.cursor/mcp.json` | JSON `mcpServers` | `type`, `envFile`, `auth`; `${env:NAME}`, `${workspaceFolder}` | Not documented [U] | CU-MCP (n.d.) |
| Gemini CLI | `.gemini/settings.json` | `~/.gemini/settings.json` | JSON `mcpServers` inside settings | Docs use `url` (SSE) and `httpUrl`; the source deprecates `httpUrl` in favour of `url` + `type`. `$VAR`/`${VAR}`. | No | GE-MCP (2026-09-02) |
| OpenCode | `opencode.json[c]` | `~/.config/opencode/opencode.json` | JSON **`mcp`**: `type: local` with a `command` array and `environment`, or `type: remote` | `{env:VAR}`, `{file:path}` | No | OC-MCP (2026-06-11) |
| pi | `.pi/mcp.json` (trusted projects) | `~/.pi/agent/mcp.json` | JSON `mcpServers` ("matches other MCP clients"), plus `exposure` | `${VAR}`, `!command`; built in since v0.99.0 (2026-09-29), after a "No MCP" stance | No (the docs say to copy entries over) | PI-MCP (2026-10-02) |
| Amp | `.amp/settings.json` (needs approval) | `~/.config/amp/settings.json` | JSON **`amp.mcpServers`** | `${VAR}` | No | AM-MCP (n.d.); 2025-11-04 |
| Kiro | `.kiro/settings/mcp.json` | `~/.kiro/settings/mcp.json` | JSON `mcpServers` | `oauth`, `autoApprove`; `${VAR}` (each variable must be approved) | No | KI-MCP (updated 2026-10-01) |
| Windsurf → Devin Local | `.devin/mcp_config.json` (+`.local`) | `~/.config/devin/mcp_config.json` | JSON `mcpServers` | `transport`; `${env:VAR}`, `${file:}`. Cascade had a user file only and used `serverUrl`. | **Imports** `.mcp.json`, Claude, Cursor, OpenCode and Zed configs | DV-MCP (n.d.); 2026-07-29 |
| Cline | none | `~/.cline/data/settings/cline_mcp_settings.json` (the docs also give `~/.cline/mcp.json`) | JSON `mcpServers` | `type: streamableHttp/sse` (default sse); no interpolation documented | No | CL-MCP (2026-06-24) |
| Roo Code (archived) | `.roo/mcp.json` | `mcp_settings.json` | JSON `mcpServers` | `alwaysAllow`, `watchPaths`; `${env:VAR}` | No | RO-MCP (2026-05-12) |
| Aider | none | none | — | — | — | MCP PR #5539 still open |
| Zed | `.zed/settings.json` (trusted worktree) | `~/.config/zed/settings.json` | JSON **`context_servers`** | `oauth`; no interpolation found | No | ZE-MCP (2026-09-19) |
| Goose | none (recipes; plugin `.mcp.json`) | `~/.config/goose/config.yaml` | **YAML `extensions`** (`cmd`, `envs`, `env_keys`, `uri`) | `env_keys` | No | GO-CONFIG (2026-09-14) |
| JetBrains Junie | `.junie/mcp/mcp.json` | `~/.junie/mcp/mcp.json` | JSON `mcpServers` | The IDE docs say secrets in the config are not supported | No | JU-MCP (site build 2026-10-01) |

**Shared location and format**
- **Project `.mcp.json` is read natively by Claude Code and both Copilot surfaces;** Devin imports it.
- **The `mcpServers` key is used by 10 of the 15 harnesses that have MCP,** but in about 14 distinct files.
- **The other 5 use different keys:**
  - Codex: TOML `mcp_servers`.
  - OpenCode: `mcp`.
  - Amp: `amp.mcpServers`.
  - Zed: `context_servers`.
  - Goose: YAML `extensions`.
  - VS Code's legacy format, still widely deployed, uses `servers`.
- **Inside the entries, things still diverge:**
  - The remote `type` value: `http`, `streamableHttp`, `streamable-http`, `remote`, a separate `httpUrl` key, or `serverUrl`.
  - Secret interpolation: `${VAR}`, `${VAR:-d}`, `${env:VAR}`, `{env:VAR}`, `$VAR`, `${input:}`, or none.
- **Project-scope MCP is missing entirely** in Cline, Goose and the old Cascade.

**Standard.** None for client config. SEP-2633 is a draft that has been waiting for a sponsor since 2026-04-22. Agent Plugins' `mcp.json` is a packaging format that clients map from.

**Trend over 12 months.** The one strong move was Microsoft consolidating on Claude's `.mcp.json`:
- Copilot CLI dropped `.vscode/mcp.json` (2026-04-09).
- VS Code began reading `.mcp.json` (2026-04-29) and deprecated `.vscode/mcp.json` (2026-09-30).

Codex, OpenCode, Zed, Goose and Amp show no movement. pi went from "No MCP" to built-in MCP (2026-09-29) with yet another file.

**Judgement.** Full convergence within 24 months is unlikely. A `.mcp.json` majority is plausible. It would need Cursor and Gemini (both already use `mcpServers` JSON) to read it, and SEP-2633 to find a sponsor. Codex's TOML, OpenCode's schema and Goose's YAML are structural choices, not accidents. Secret handling is the least converged part and the most security-relevant.

---

## Harness churn in the last 12 months

Churn matters for any manager, and for whether "convergence" is stable:
- **Windsurf is now "Devin Desktop"** (rename at v3.0.12, 2026-06-02).
  - Cascade was removed in v3.9.19 (2026-09-08). The only agent is Devin Local, on the Devin CLI config model.
  - docs.windsurf.com 308-redirects to docs.devin.ai/desktop (checked 2026-10-02).
- **Roo Code shut down.** The repo was archived on 2026-05-15 (verified via `gh api`). The README points to the Zoo Code fork and to Cline.
- **Aider has stalled.** The last GitHub release is v0.86.0 (2025-08-09) and the last commit 2026-05-22. The cecli fork adds MCP, skills, subagents and hooks.
- **Amp was rebuilt as "Neo"** (2026-05-06). Hooks and custom agents are now TypeScript plugin code only.
- **Kiro unified its config** with IDE 1.0 (2026-06-25) and the CLI V3 engine (2026-06-17).
- **Cline 4.0.0** (2026-06-26) moved onto the Cline SDK and added `.cline/`.
- **pi:**
  - `github.com/badlogic/pi-mono` now redirects to `github.com/earendil-works/pi` (111.7k stars; checked with `gh api`).
  - The npm package `@mariozechner/pi-coding-agent` is deprecated ("please use @earendil-works/pi-coding-agent instead"); the new package reached 1.0.0 on 2026-10-01.
  - The "No MCP / No sub-agents" philosophy section was removed from the README in v0.87.1 (2026-09-22), and MCP shipped built in in v0.99.0 (2026-09-29).
- **Goose** moved to `aaif-goose/goose` under AAIF, with docs at goose-docs.ai.

### Note on "pi"

The "pi" harness is Mario Zechner's minimal coding agent. Its old home `github.com/badlogic/pi-mono` (`packages/coding-agent`) now redirects to `earendil-works/pi`, by Earendil Inc. Its site is pi.dev; shittycodingagent.ai redirects there. The design post is at mariozechner.at/posts/2025-11-30-pi-coding-agent/. No other notable coding harness uses the name; Inflection's Pi is a chatbot.

**Config model**
- **User dir:** `~/.pi/agent/` (override with `PI_CODING_AGENT_DIR`). It holds:
  - files: `settings.json`, `mcp.json`, `models.json`, `auth.json`, `keybindings.json`, `AGENTS.md`/`CLAUDE.md`, `SYSTEM.md`/`APPEND_SYSTEM.md`;
  - folders: `extensions/`, `skills/`, `prompts/`, `themes/`.
- **Project dir:** `.pi/` holds the same set and loads only after the project is trusted.
- **Instructions:** per directory, the first of `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`.
- **Skills:** `.agents/skills` is shared.
- **Packages:** bundle resources from npm or git (since v0.50.0).
- **Behaviour hooks** are in-process TypeScript extensions; there are no shell hooks.
- **Subagents** are not built in; the README "skips features like sub-agents and plan mode".

**Stance as quoted from the earlier README** (unpkg 0.86.0):
- "**No MCP.** Build CLI tools with READMEs ... or build an extension that adds MCP support."
- "**No sub-agents.** ... Spawn pi instances via tmux, or build your own with extensions"

---

## Verdict

| Kind | Shared location / format today | Who doesn't read it | Standard and backers | 12-month trend | Full convergence in 12–24 months? |
|---|---|---|---|---|---|
| Skills | `SKILL.md` everywhere; `.agents/skills` (13 of 15); `.claude/skills` (8 of 15) | Claude Code (no `.agents/skills`); Kiro (`.kiro/skills` only); Aider (no skills) | Agent Skills, Anthropic-originated, informal governance, 46 listed clients; says nothing about location | Strongly converging. Shared-dir adoption grew from 1 to 23 of the agents mapped by `npx skills` in 8 months. | **Format: yes, already. Project location: likely** (needs Claude Code; moderate confidence). User paths and frontmatter semantics: no. |
| Instructions (always-on) | `AGENTS.md` (14 of 16 by default) | Gemini (opt-in), Aider (manual); Claude Code only when no CLAUDE.md | AGENTS.md under AAIF/LF (OpenAI-contributed; AWS, Anthropic, Google, Microsoft and others are members); no normative text | Converged; the last major holdout (Claude Code) moved on 2026-09-18 | **Yes, effectively now** |
| Instructions (scoped) | No shared format; `.claude/rules` read by Claude Code and both Copilot surfaces | Everyone else has its own format or none | None (AGENTS.md frontmatter proposal idle since 2025-08) | Flat, apart from Microsoft adopting `.claude/rules` | **Unlikely** |
| Subagents | No shared format; `.claude/agents` read by Copilot, Cursor and Goose | Codex (TOML), Gemini (strict), OpenCode, Kiro, Cline, Devin, Junie, Roo use their own; pi, Amp, Zed, Aider have no file agents | None; Agent Plugins excludes agents | The concept spread fast; formats did not converge | **Unlikely** |
| Hooks | Claude protocol used or mapped by 8 of 16; Claude files read live by 3 (+1 opt-in) | OpenCode, pi, Amp (in-process); Cline (own); Roo, Aider, Zed (none) | None; a Claude-derived draft was withdrawn from Agent Plugins on 2026-07-10 | Semantics converging toward Claude; files and events not | **Unlikely** (semantic alignment likely) |
| MCP config | `mcpServers` JSON (10 of 15); `.mcp.json` in Claude Code and both Copilot surfaces | Codex (TOML), OpenCode, Amp, Zed, Goose (other keys); 10 different paths | MCP protocol under AAIF; client config only in SEP-2633 (draft, no sponsor) | Microsoft consolidated on `.mcp.json`; others unchanged | **Unlikely** (`.mcp.json` majority plausible) |

### What this means for "is a cross-harness manager still needed?"

1. **The parts that are converging are the cheap parts.**
   - Skills and always-on instructions are where palm's rendering is already near-trivial: copy to `.agents/skills` or `.claude/skills`, or write a block in AGENTS.md.
   - Free tools already cover skills, including `gh skill` from GitHub and `npx skills` from Vercel.
   - **So palm should not rest its value on "we write skills to the right folder".**
2. **The expensive parts are not converging:** subagent field and tool mapping, hook event and tool-name translation, MCP schema, transport and secret syntax, and scoped-rule frontmatter. No standards venue is working on any of them.
   - Agent Plugins' TSC (Amazon, Cursor, Microsoft, OpenAI, Vercel) wrote in 1.0.0 that commands, hooks, agents and rules "remain too client-specific for a stable portable contract".
3. **Convergence through cross-reading creates a new problem: double loading.**
   - Cursor reads `.cursor/`, `.claude/` and `.codex/` agents.
   - Copilot reads `.github/`, `.agents/` and `.claude/` skills.
   - Several harnesses read both AGENTS.md and CLAUDE.md.
   - So a naive "write everywhere" approach makes things worse. "One carrier per harness" (DESIGN.md rule 16) becomes *more* valuable as harnesses read each other's directories.
   - Cross-reading also changes direction. Copilot CLI dropped `~/.claude/*` on 2026-04-24 and `.vscode/mcp.json` on 2026-04-09; pi dropped automatic Claude skill dirs on 2026-01-26. The mapping table needs versioned maintenance.
4. **No spec covers the supply chain, and none plans to.**
   - Agent Skills has "no install or distribution mechanism".
   - AGENTS.md is a file.
   - Agent Plugins leaves "installation, distribution, enablement, updates" to clients and defers trust, signing, secrets and dependency resolution (FUTURE_CONSIDERATIONS.md).
   - Pinning, locking, review-before-execute and CI drift checks are therefore durable reasons for palm to exist, independent of format convergence.

**Signals that would change this verdict:**
- Claude Code reading `.agents/skills`.
- Anthropic joining Agent Plugins, or Claude Code adopting its `plugin.json`.
- SEP-2633 getting a sponsor.
- Agent Plugins 1.x adding agents or hooks.
- AGENTS.md adopting frontmatter or scoped rules (#10, #179, #211).
- Cursor and Gemini reading `.mcp.json`.

---

## Sources

Dates: page stamp, else the last commit to the doc file, else the release date. n.d. means no date shown; read on 2026-10-02.

### Standards and cross-cutting

| Key | Source | Date |
|---|---|---|
| Agent Skills spec | https://agentskills.io/specification (repo `docs/specification.mdx`) | 2026-08-04 |
| Agent Skills client guide | https://agentskills.io/client-implementation/adding-skills-support (`docs/client-implementation/adding-skills-support.mdx`) | 2026-03-09 |
| Agent Skills repo | https://github.com/agentskills/agentskills | README 2026-04-22, CONTRIBUTING 2026-04-01, `docs/snippets/clients.jsx` 2026-08-09 |
| AAIF projects | https://aaif.io/projects/ | n.d. |
| AAIF formation | https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation | 2025-12-09 |
| AAIF membership | https://www.linuxfoundation.org/press/agentic-ai-foundation-welcomes-97-new-members | 2026-02-24 |
| AGENTS.md | https://agents.md and https://github.com/agentsmd/agents.md (Technical_Charter.pdf, "Adopted December 8, 2025") | last commit 2026-09-10 |
| AGENTS.md issues | https://github.com/agentsmd/agents.md/issues/10, /11, /34, /91, /149, /179, /211, /244 | — |
| Agent Plugins spec | https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md (published 2026-07-24; the quote is at line 608); `MAINTAINERS.md`; `FUTURE_CONSIDERATIONS.md`; `schemas/1.0.0/mcp.schema.json` | — |
| Open Plugin draft | repo commit `c01f3921` (2026-04-03), Appendix D/E.4 hooks; removal commit `6a505752` "Remove host-specific hook event catalog" (2026-07-10); rename commit `d83795f9` (2026-07-17) | — |
| Agent Plugins clients | https://github.com/agentplugins/agent-plugins-site/blob/main/lib/compatible-clients.ts | 2026-09-19 |
| GitHub blog, Agent Plugins | https://github.blog/changelog/2026-08-12-agent-plugins-1-0-in-vs-code-copilot-cli-and-the-copilot-app/ | 2026-08-12 |
| SEP-2633 | https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2633 (draft, opened 2026-04-22, last activity 2026-07-28) | — |
| MCP Discussion #2218 | https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2218 | 2026-02-06 |
| SEP guidelines | https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/community/sep-guidelines.mdx | — |
| npx skills | https://github.com/vercel-labs/skills README "Supported Agents" (snapshots by commit at 2026-01-25, 2026-04-01, 2026-07-01) | 2026-09-26 |
| gh skill | `gh skill install --help`, gh 2.97.0 | 2026-07-31 |
| Secondary | Barbaste et al., "Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents", https://arxiv.org/abs/2609.00006 | 2026 |

### Claude Code, Codex, Copilot

Full list in notes-A.

| Key | Source | Date |
|---|---|---|
| CC-SKILLS | https://code.claude.com/docs/en/skills | n.d. |
| CC-MEM | https://code.claude.com/docs/en/memory | n.d. |
| CC-SUB | https://code.claude.com/docs/en/sub-agents | n.d. |
| CC-HOOKS | https://code.claude.com/docs/en/hooks | n.d. |
| CC-MCP | https://code.claude.com/docs/en/mcp | n.d. |
| CC-CL | https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md: 2.1.277 "Added AGENTS.md support: in a project with no CLAUDE.md, Claude Code reads AGENTS.md instead"; release v2.1.277 | 2026-09-18 |
| CX-SKILLS | https://learn.chatgpt.com/docs/build-skills | n.d. |
| CX-AGENTSMD | https://learn.chatgpt.com/docs/agent-configuration/agents-md | n.d. |
| CX-SUB | https://learn.chatgpt.com/docs/agent-configuration/subagents | n.d. |
| CX-HOOKS | https://learn.chatgpt.com/docs/hooks | n.d. |
| CX-MCP | https://learn.chatgpt.com/docs/extend/mcp | n.d. |
| CX-IMPORT | https://learn.chatgpt.com/docs/import | n.d. |
| CX-SRC | github.com/openai/codex `codex-rs` @ HEAD | 2026-10-02 |
| CP-REF | https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference | 2026-10-02 |
| CP-HOOKREF | https://docs.github.com/en/copilot/reference/hooks-reference | 2026-10-02 |
| CP-AGENTS | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli | 2026-09-30 |
| CP-MCP | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers | 2026-09-30 |
| CP-CL | https://github.com/github/copilot-cli/blob/main/changelog.md: 1.0.89 "Add support for Claude Code rule files in .claude/rules"; "Remove .vscode/mcp.json … CLI now only reads .mcp.json"; "Read .claude/settings.json and .claude/settings.local.json as additional repo config sources"; "Custom agents, skills, and commands from ~/.claude/ are no longer loaded" | 2026-10-01 |
| VS-SKILLS | https://code.visualstudio.com/docs/agent-customization/agent-skills | 2026-09-30 |
| VS-INSTR | https://code.visualstudio.com/docs/agent-customization/custom-instructions | 2026-09-30 |
| VS-AGENTS | https://code.visualstudio.com/docs/agent-customization/custom-agents | 2026-09-30 |
| VS-HOOKS | https://code.visualstudio.com/docs/agent-customization/hooks | 2026-09-30 |
| VS-MCP | https://code.visualstudio.com/docs/agent-customization/mcp-servers | 2026-09-30 |
| VS-1.140 | https://code.visualstudio.com/updates/v1_140 | 2026-09-30 |

### Cursor, Gemini CLI, OpenCode, pi

Full list in notes-B.

| Key | Source | Date |
|---|---|---|
| CU-SKILLS | https://cursor.com/docs/skills | n.d. |
| CU-RULES | https://cursor.com/docs/rules and https://cursor.com/help/customization/rules | n.d. |
| CU-SUB | https://cursor.com/docs/subagents (verified directly 2026-10-02) | n.d. |
| CU-HOOKS | https://cursor.com/docs/hooks | n.d. |
| CU-3P | https://cursor.com/docs/reference/third-party-hooks (verified directly 2026-10-02) | n.d. |
| CU-MCP | https://cursor.com/docs/mcp | n.d. |
| Cursor changelogs | https://cursor.com/changelog/2-4 (2026-01-22); https://cursor.com/changelog/1-7 (2025-09-29) | — |
| GE-SKILLS | https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md | 2026-04-30 |
| GE-GEMINIMD | https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md | 2026-06-18 |
| GE-SUB | https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md | 2026-06-08 |
| GE-HOOKS | https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md | 2026-04-13 |
| GE-MCP | https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md | 2026-09-02 |
| OC-SKILLS | https://opencode.ai/docs/skills/ | 2026-02-04 |
| OC-RULES | https://opencode.ai/docs/rules/ | 2026-04-01 |
| OC-AGENTS | https://opencode.ai/docs/agents/ | 2026-05-08 |
| OC-PLUGINS | https://opencode.ai/docs/plugins/ | 2026-02-20 |
| OC-MCP | https://opencode.ai/docs/mcp-servers/ | 2026-06-11 |
| PI-CONFIG | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md | 2026-09-29 |
| PI-SKILLS | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md | 2026-09-22 |
| PI-MCP | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md | 2026-10-02 |
| PI-EXT | https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md | 2026-09-30 |
| pi old README | https://unpkg.com/@earendil-works/pi-coding-agent@0.86.0/README.md | — |

### Amp, Kiro, Windsurf/Devin, Cline

Full list in notes-C.

| Key | Source | Date |
|---|---|---|
| AM-SKILLS | https://ampcode.com/docs/customize/skills | n.d. |
| AM-AGENTSMD | https://ampcode.com/docs/customize/agents-md | n.d. |
| AM-MCP | https://ampcode.com/docs/customize/mcp | n.d. |
| AM-PLUGINS | https://ampcode.com/docs/customize/plugins | n.d. |
| Amp news | https://ampcode.com/news/neo (2026-05-06); https://ampcode.com/news/agent-skills (2025-12-10) | — |
| KI-SKILLS | https://kiro.dev/docs/skills/ | 2026-09-02 |
| KI-STEERING | https://kiro.dev/docs/steering/ | 2026-10-02 |
| KI-AGENTS | https://kiro.dev/docs/custom-agents/ | 2026-09-02 |
| KI-HOOKS | https://kiro.dev/docs/hooks/ | 2026-09-30 |
| KI-MCP | https://kiro.dev/docs/mcp/configuration/ | 2026-10-01 |
| Kiro changelog | https://kiro.dev/changelog/ide/1-0/ (2026-06-25); https://kiro.dev/changelog/ide/1-0-288/ (2026-08-07, Powers per Agent Plugins) | — |
| DV-SKILLS | https://docs.devin.ai/cli/extensibility/skills/overview | n.d. |
| DV-RULES | https://docs.devin.ai/cli/extensibility/rules | n.d. |
| DV-SUB | https://docs.devin.ai/cli/subagents | n.d. |
| DV-HOOKS | https://docs.devin.ai/cli/extensibility/hooks/overview | n.d. |
| DV-MCP | https://docs.devin.ai/cli/extensibility/mcp/configuration and https://docs.devin.ai/cli/reference/configuration/read-config-from | n.d. |
| Devin Desktop changelog | https://docs.devin.ai/desktop/changelog: rename v3.0.12 2026-06-02; Cascade removed v3.9.19 2026-09-08 | — |
| CL-SKILLS | https://github.com/cline/cline/blob/main/docs/customization/skills.mdx | 2026-06-26 |
| CL-RULES | https://github.com/cline/cline/blob/main/docs/customization/cline-rules.mdx | 2026-09-19 |
| CL-SUB | https://github.com/cline/cline/blob/main/docs/features/subagents.mdx | 2026-05-12 |
| CL-HOOKS | https://github.com/cline/cline/blob/main/sdk/examples/hooks/README.md | 2026-09-03 |
| CL-MCP | https://github.com/cline/cline/blob/main/docs/mcp/mcp-overview.mdx | 2026-06-24 |
| Cline changelog | https://github.com/cline/cline/blob/main/CHANGELOG.md | — |

### Roo Code, Aider, Zed, Goose, Junie

Full list in notes-D.

| Key | Source | Date |
|---|---|---|
| RO-SKILLS | https://roocodeinc.github.io/Roo-Code/features/skills | 2026-05-12 |
| RO-INSTR | https://roocodeinc.github.io/Roo-Code/features/custom-instructions | 2026-05-12 |
| RO-MODES | https://roocodeinc.github.io/Roo-Code/features/custom-modes | 2026-05-12 |
| RO-MCP | https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo | 2026-05-12 |
| Roo repo | https://github.com/RooCodeInc/Roo-Code (archived; last push 2026-05-15) | — |
| AI-CONV | https://aider.chat/docs/usage/conventions.html | 2024-12-13 |
| AI-LINT | https://aider.chat/docs/usage/lint-test.html | 2025-05-02 |
| Aider repo | https://github.com/Aider-AI/aider | — |
| ZE-SKILLS | https://zed.dev/docs/ai/skills | 2026-09-19 |
| ZE-INSTR | https://zed.dev/docs/ai/instructions | 2026-09-19 |
| ZE-TOOLS | https://zed.dev/docs/ai/tools | 2026-07-01 |
| ZE-MCP | https://zed.dev/docs/ai/mcp | 2026-09-19 |
| ZE-TASKS | https://zed.dev/docs/tasks#hooks | 2026-06-09 |
| GO-SKILLS | https://goose-docs.ai/docs/guides/context-engineering/using-skills | 2026-08-19 |
| GO-HINTS | https://goose-docs.ai/docs/guides/context-engineering/using-goosehints | 2026-06-16 |
| GO-AGENTS | https://goose-docs.ai/docs/guides/context-engineering/custom-agents | 2026-06-22 |
| GO-HOOKS | https://goose-docs.ai/docs/guides/context-engineering/hooks | 2026-09-21 |
| GO-CONFIG | https://goose-docs.ai/docs/guides/config-files | 2026-09-14 |
| Goose repo | https://github.com/aaif-goose/goose | — |
| JU-SKILLS | https://junie.jetbrains.com/docs/agent-skills.html | site build 2026-10-01 |
| JU-GUIDE | https://junie.jetbrains.com/docs/guidelines-and-memory.html | site build 2026-10-01 |
| JU-SUB | https://junie.jetbrains.com/docs/junie-cli-subagents.html | site build 2026-10-01 |
| JU-HOOKS | https://junie.jetbrains.com/docs/junie-cli-hooks.html | site build 2026-10-01 |
| JU-MCP | https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html | site build 2026-10-01 |

All Junie pages show only the site build date; first-seen dates come from Wayback Machine snapshots.
