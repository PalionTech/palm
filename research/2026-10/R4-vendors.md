# R4: Are the harness vendors solving cross-tool configuration, or building lock-in?

Research date: 2026-10-02. Sources: vendor docs and changelogs, source code (openai/codex at
`dff5270`, 2026-10-02; earendil-works/pi docs at HEAD, 2026-10-02), GitHub issues and discussions
read through the GitHub API, and press coverage. Every claim carries a link and a date. Docs pages
have no publication date, so they are marked "accessed 2026-10-02". `[I]` marks my inference.
`[2nd]` marks a claim that comes only from a secondary source.

---

## 1. Short answer

1. **Vendors are converging on reading each other's files. Nobody manages files across vendors.**
   Five of the seven harness families now read another vendor's files: Claude plugin manifests
   and marketplaces, `.claude/skills`, Claude hooks, `.agents/skills`, `AGENTS.md`, or Agent
   Plugins `plugin.json`. Almost all of that reading points toward Claude's formats or toward the
   `.agents/` convention. Claude Code itself reads only `AGENTS.md`, and only as a fallback.
2. **Nobody writes into a competitor's harness.** The only cross-vendor features that harness
   vendors have shipped are one-way imports into their own product: Codex `/import` (from Claude
   Code, Cowork and Cursor) and Cursor's "Third-Party Imports". The OpenAI docs say it directly:
   "importing is one-way".
3. **Every standards body has declared distribution out of scope.**
   - Agent Skills defines no install location. The issue asking for one has been open for 10
     months with 100 comments.
   - The Agent Plugins lead wrote that "distribution is outside the scope of the Agent Plugins
     spec". The same answer went to dependencies and to marketplaces.
   - The MCP Registry is "not intended to be directly consumed by host applications" and is still
     in preview 13 months after launch.
   - ARD and AI Catalog cover discovery only.
4. **Lock-in is being built in team distribution.** Each vendor ties pinning, team sharing,
   policy and sync to its own accounts:
   - Claude: org sync and private marketplaces.
   - Cursor: team marketplaces with a "Required" install mode.
   - Copilot: enterprise-managed plugins.
   - ChatGPT: the workspace plugin directory.

   Each vendor also keeps adding component types only it supports (Claude Mods, monitors,
   workflows and channels; Cursor rules and hooks; Antigravity `mcp_config.json`).
5. **The one vendor shipping neutral managers is GitHub/Microsoft.** `gh skill` (public preview)
   installs skills into about 50 agents, and APM (in the `microsoft` org) installs into 13
   harnesses. palm's competition from vendors comes from here, not from the model vendors.

**Verdict: (b), a thin layer, with a probability of about 60%.** Placing skills and instructions
will cost nothing by 2027. Three jobs stay unsolved by any vendor or spec:
- pinning and lock
- consent for executables, and a CI drift check
- translating the three kinds that will not converge (hooks, subagents and MCP config)

The detail is in §6.

---

## 2. Vendor-by-vendor table

Period covered: October 2025 to October 2026. "Reads" means the harness loads another vendor's
files natively or imports them. "Writes" means the vendor ships a tool that installs into another
vendor's harness.

| Vendor | What shipped for distribution | Own format open, reused by others? | Reads other harnesses' files | Writes to other harnesses | Neutral governance role | Lock-in moves | Net direction |
|---|---|---|---|---|---|---|---|
| **Anthropic** (Claude Code, Cowork, Agent SDK) | Plugins + git marketplaces (2025-10-09); Agent Skills (2025-10-16); plugin dependencies with semver; Cowork plugins (2026-01-30); private marketplaces (2026-02-24); claude.ai org sync; AGENTS.md fallback (2026-09-18); Mods (2026-10-01) | Plugin format documented but the product is proprietary. **Read by Codex, Copilot CLI, VS Code and Cursor.** Agent Skills is open and has 46 clients | `AGENTS.md` only, as a fallback when there is no `CLAUDE.md`. No `.agents/skills`: #31005 is open, and #66352 was closed as not planned. Agent Plugins loads only partly [I] | None (imports only from Claude Desktop) | Donated MCP to AAIF (2025-12-09). Proposed Agent Skills to AAIF (TC approved 2026-10-01, Governing Board vote pending). **Not on the Agent Plugins TSC** | Kinds only Claude supports (Mods, monitors, workflows, channels, themes, `bin/`, LSP); claude.ai org sync; no user version pin (#63986 open); project scope does not reach teammates (#89683 open) | Gives away the content formats it invented and keeps the container and the distribution |
| **OpenAI** (Codex, ChatGPT) | AGENTS.md donated to AAIF (2025-12-09); Codex plugins (2026-03-27); one plugin directory for ChatGPT and Codex (2026-07-09); `/import` from Claude Code, Cowork and Cursor (≈May 2026); openai/skills deprecated in favour of openai/plugins | Codex CLI is Apache-2.0. Recommends the **Agent Plugins** manifest, with OpenAI-specific fields under `extensions.com.openai` | Agent Plugins, `.codex-plugin`, `.claude-plugin` manifests; `.agents/`, `.claude-plugin/` and `.cursor-plugin/` marketplaces (source); one-way migration of Claude and Cursor setups | None ("importing is one-way") | AGENTS.md now sits at AAIF; Agent Plugins TSC seat | Directory tied to ChatGPT accounts and workspaces; the desktop app can keep imported Claude work in sync | Open formats, wins users by absorbing their setups |
| **GitHub / Microsoft** (Copilot CLI, VS Code, Copilot app; `gh`; APM) | Custom agents `.github/agents` (2025-10-28); Copilot CLI GA (2026-02-25); enterprise-managed plugins (2026-05-06); Agent Plugins GA in VS Code, Copilot CLI and app (2026-08-12); **`gh skill`** (preview, 2026-04-16); **APM** v0.33.0 (2026-10-02) | Agent Plugins, Copilot plugin, APM (MIT), `gh` (MIT); the Copilot CLI is proprietary | `.claude/skills`, `.agents/skills`, `.claude/settings.json` (2026-03-26), `.claude/rules` (2026-09-28), `.claude-plugin` manifests and marketplaces, Claude `extraKnownMarketplaces`. VS Code auto-detects Agent Plugins, Copilot, Claude and legacy formats | **Yes.** `gh skill` installs skills into Claude Code, Codex, Cursor, Gemini, Antigravity, pi and others. APM writes 13 harnesses | Agent Plugins TSC (Microsoft); ARD launch contributor and co-author; MCP Registry backer | Enterprise policy bound to GitHub accounts; awesome-copilot as the default marketplace | **The only vendor building neutral managers.** Largest overlap with palm |
| **Cursor** | Plugins + marketplace in 2.5 (2026-02-17); CLI plugins (Mar 2026); marketplaces from git, including "plugins imported from Claude Code" (2026-05-07); team marketplaces | Agent Plugins and its own `.cursor-plugin` format. The app is proprietary | Skills from `.agents`, `.cursor`, `.claude` and `.codex`; **Claude hooks** from `.claude/settings*.json` (on by default); AGENTS.md; Claude Code plugins | None | Agent Plugins TSC seat | Rules, agents, commands and hooks exist only in the Cursor format; team marketplaces (1 on Teams, unlimited on Enterprise) with Required mode | Reads everything, writes nothing |
| **Google** (Gemini CLI → Antigravity) | Gemini CLI extensions + gallery (2025-10-08); skills with an `.agents/skills` alias; **Gemini CLI transition announced 2026-05-19, consumer service stopped 2026-06-18**; Antigravity plugins; ARD (2026-06-17); joined Agent Plugins (2026-08-06) | Gemini CLI stays Apache-2.0 (nightly builds as of 2026-10-02, for enterprise). Antigravity has its own `plugin.json` schema, `mcp_config.json` and `hooks.json` | `.agents/skills`; Antigravity plugins described as a "superset" of Agent Plugins [2nd]. No Claude plugin import (Gemini #17475 closed as a duplicate) | Partial: Agents CLI installs Google's skills into "any AI coding agent" | Agent Plugins core maintainer (announced; not yet in MAINTAINERS.md as of 2026-10-02); ARD / AI Catalog | Product churn; the successor CLI is closed source (community criticism); own file names | Churn plus a bet on federated discovery |
| **OpenCode** (anomalyco) | `opencode plugin` (npm JS plugins); skills; MCP; agent wizard | MIT | `AGENTS.md`; `CLAUDE.md` and `~/.claude/skills` as fallbacks (can be switched off); `.agents/skills` | None | None | Low | Open and a follower. **No marketplace** (#28696, open since 2026-05-21) and **no Agent Plugins** (#40993, open since 2026-08-07) |
| **pi** (Earendil since 2026-04-08) | pi packages (npm, git, URL, local; pinned refs; project scope after a trust check; pi.dev gallery); built-in MCP (`.pi/mcp.json`) | MIT | `.agents/skills`, `AGENTS.md`, `CLAUDE.md`. MCP entries from other clients are copied by hand | None | None | Low | Its own package system; cross-tool compatibility stops at skills and AGENTS.md |

---

## 3. Evidence per vendor

### 3.1 Anthropic

**Shipped**
- **Claude Code plugins and git-hosted marketplaces**, public beta 2025-10-09
  ([summary, 2025-10](https://alirezarezvani.medium.com/claude-code-2-0-13-be2c0a723856) [2nd]).
- **Agent Skills**: product launch 2025-10-16, open standard 2025-12-18
  ([AAIF proposal #47, 2026-09-24](https://github.com/aaif/project-proposals/issues/47)).
- **Cowork plugins** (2026-01-30). **Private plugin marketplaces** with private GitHub repos as
  sources (2026-02-24). Anthropic's own wording: "Plugins are simple, portable file systems that
  you own. They work across Cowork and anything built on the Claude Agent SDK"
  ([Claude blog, 2026-02-24](https://claude.com/blog/cowork-plugins-across-enterprise)). The
  portability is **within Anthropic's surfaces**.
- **Plugin manifest and components.** Plugin-to-plugin `dependencies` with version constraints,
  `userConfig` with keychain storage, and an optional manifest
  ([plugins reference, accessed 2026-10-02](https://code.claude.com/docs/en/plugins-reference)).
  The component list keeps growing with kinds only Claude supports: `outputStyles`, `workflows`,
  `channels`, `experimental.themes/monitors/evals`, `bin/`, `lspServers`, and **Mods**, added in
  2.1.287 on 2026-10-01: "plugins may now modify deeper behavior"
  ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).
- **AGENTS.md support** in 2.1.277 (2026-09-18), after #6235, which collected 6,686 reactions
  and 409 comments. It is a fallback only: "in a project with no CLAUDE.md, Claude Code reads
  AGENTS.md instead"
  ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md);
  [The Register, 2026-09-18](https://www.theregister.com/ai-and-ml/2026/09/18/anthropic-decides-to-support-openais-markdown-instructions-spec/5297588)).

**Does not read other vendors' files**
- **Skill locations.** Skills load only from `.claude/skills`, `~/.claude/skills`, nested
  `.claude/skills`, managed settings and plugins. The docs list no `.agents/skills`
  ([skills docs, accessed 2026-10-02](https://code.claude.com/docs/en/skills)).
- **Issues on `.agents/skills`.**
  - [#31005](https://github.com/anthropics/claude-code/issues/31005) ("Support for AGENTS.md and
    .agents/skills/") has been open since 2026-03-05.
  - [#66352](https://github.com/anthropics/claude-code/issues/66352) (user-level `.agents/skills`)
    was closed as **not planned** on 2026-07-16.
- **No import from other agents.** The changelog has no import from Codex, Cursor or Gemini. The
  only import is `claude mcp add-from-claude-desktop`.
- **Agent Plugins.** Anthropic holds no TSC seat; MAINTAINERS.md lists Amazon, Cursor, Microsoft,
  OpenAI and Vercel
  ([MAINTAINERS.md, accessed 2026-10-02](https://github.com/agentplugins/agent-plugins-spec/blob/main/MAINTAINERS.md)).
- **Loading an Agent Plugin.** Claude's manifest is optional, and `skills/` is a default
  location. A Claude plugin's MCP file, however, is `.mcp.json`, not the spec's `mcp.json`. So an
  Agent Plugin's skills load in Claude and its MCP servers do not [I, from the plugins
  reference]. One article claims Agent Plugins "do install into Claude Code today"
  ([scienceshot, 2026-08](https://scienceshot.com/post/agent-plugins-1-0-claude-code) [2nd]).

**Opening the formats it invented**
- **MCP** went to the Linux Foundation's Agentic AI Foundation on 2025-12-09
  ([AAIF press release, 2025-12-09](https://aaif.io/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation-aaif-anchored-by-new-project-contributions-including-model-context-protocol-mcp-goose-and-agents-md/)).
- **Agent Skills** was proposed to AAIF on 2026-09-24, with the domain, GitHub org and name to be
  donated. The Technical Committee approved it on 2026-10-01; the paperwork and the Governing
  Board vote are pending ([#47](https://github.com/aaif/project-proposals/issues/47)).

**Team-sharing gaps (still open)**
- No `--version` pin on install
  ([#63986](https://github.com/anthropics/claude-code/issues/63986), open since 2026-05-30).
- Project-scope plugins "not shareable across team clones"
  ([#89683](https://github.com/anthropics/claude-code/issues/89683), open since 2026-08-26).

**Reading:** Anthropic opens the formats it invented (MCP, skills, and now AGENTS.md as a
reader). It keeps the plugin container, the directory layout, and team distribution through
claude.ai as its own.

### 3.2 OpenAI

- **AGENTS.md**, co-launched in 2025, was contributed to AAIF on 2025-12-09 (same press release
  as §3.1). The site now says "AGENTS.md is now stewarded by the Agentic AI Foundation under the
  Linux Foundation" ([agents.md, accessed 2026-10-02](https://agents.md/)).
- **Codex plugins** launched 2026-03-27
  ([The New Stack](https://thenewstack.io/openais-codex-gets-plugins/)). The app directory
  migrated into one Plugin directory shared by ChatGPT and Codex on 2026-07-09
  ([OpenAI Help](https://help.openai.com/en/articles/20001256-plugins-in-codex)).
- **Accepted formats.** The docs recommend the **Agent Plugins** root `plugin.json`, keep
  `.codex-plugin/plugin.json` as a fallback and `.claude-plugin/plugin.json` as "legacy
  compatibility", and also read `$REPO_ROOT/.claude-plugin/marketplace.json`
  ([plugin build docs, accessed 2026-10-02](https://developers.openai.com/plugins/build/plugins)).
- **The source confirms it.** Codex looks for marketplaces at `.agents/plugins/marketplace.json`,
  `.claude-plugin/marketplace.json` and `.cursor-plugin/marketplace.json`
  ([marketplace.rs L21–24 @dff5270](https://github.com/openai/codex/blob/dff5270b298b7ee5fb1c47460a3d6e0d89985cad/codex-rs/core-plugins/src/marketplace.rs)).
- **`/import`** brings in "instructions, settings, skills, plugins, projects, and recent work"
  from Claude Code, Claude Cowork (desktop only) and Cursor. In the desktop app you can "turn on
  automatic updates to keep imported work in sync with the original agent"
  ([Import docs, accessed 2026-10-02](https://learn.chatgpt.com/docs/import)).
  - The code is a dedicated crate, `codex-rs/external-agent-migration`, with sources `cla.rs`
    (`.claude`, `CLAUDE.md`) and `cur.rs` (`.cursor`, `.cursorrules`)
    ([source @dff5270](https://github.com/openai/codex/tree/dff5270b298b7ee5fb1c47460a3d6e0d89985cad/codex-rs/external-agent-migration/src)).
  - Shipped in CLI 0.128–0.130, about May 2026; "importing is one-way; changes made in Codex do
    not propagate back to Claude Code"
    ([D. Vaughan, 2026-05-13, updated 2026-10-02](https://codex.danielvaughan.com/2026/05/13/codex-cli-agent-migration-system-import-claude-code-sessions-skills-config/) [2nd]).
- **Skills over MCP.** ChatGPT has "Partial" support for the MCP Skills extension
  ([MCP extension matrix, accessed 2026-10-02](https://modelcontextprotocol.io/extensions/client-matrix)).
- **Reading:** OpenAI is the most open on formats (Agent Plugins first, three manifest dialects,
  three marketplace dialects). It competes by importing other vendors' setups and offers no
  export.

### 3.3 GitHub / Microsoft

**Harness features**
- **Custom agents** for Copilot CLI
  ([changelog, 2025-10-28](https://github.blog/changelog/2025-10-28-github-copilot-cli-use-custom-agents-and-delegate-to-copilot-coding-agent/)).
  **Copilot CLI GA**
  ([changelog, 2026-02-25](https://github.blog/changelog/2026-02-25-github-copilot-cli-is-now-generally-available/)).
- **Enterprise-managed plugins**, distributed from
  `.github-private/.github/copilot/settings.json`
  ([changelog, 2026-05-06](https://github.blog/changelog/2026-05-06-enterprise-managed-plugins-in-github-copilot-cli-are-now-in-public-preview/)).
- **Agent Plugins 1.0** in VS Code, Copilot CLI, the Copilot SDK and the Copilot app. "Existing
  GitHub Copilot plugins that don't target Agent Plugins 1.0 remain supported"
  ([changelog, 2026-08-12](https://github.blog/changelog/2026-08-12-agent-plugins-1-0-in-vs-code-copilot-cli-and-the-copilot-app/)).

**Copilot reads Claude's files.** From the
[Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md):

| Version | Date | Change |
|---|---|---|
| 0.0.401 | 2026-02-03 | Loads `.agents/skills` |
| 0.0.421 | 2026-03-03 | Reads `extraKnownMarketplaces` from `.claude/settings.json` |
| 1.0.12 | 2026-03-26 | Reads `.claude/settings.json` and `.claude/settings.local.json` as repo config |
| 1.0.36 | 2026-04-24 | Stopped loading `~/.claude/` agents, skills and commands (user-level retreat) |
| 1.0.89 | 2026-09-28 | Reads `.claude/rules` as custom instructions |

- **Skill locations.** Copilot reads skills from `.github/skills`, `.claude/skills`,
  `.agents/skills`, `~/.copilot/skills` and `~/.agents/skills`
  ([GitHub Docs, accessed 2026-10-02](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)).
- **VS Code formats.** VS Code auto-detects Agent Plugins 1.0, Copilot, Claude
  (`.claude-plugin/plugin.json`) and legacy OpenPlugin formats. It marks only skills and MCP as
  portable: agents, hooks, commands and rules are "client-specific"
  ([VS Code docs, 2026-09-30](https://code.visualstudio.com/docs/copilot/customization/agent-plugins)).

**Neutral managers**
- **`gh skill`** shipped in gh v2.90.0 as a public preview on 2026-04-16
  ([changelog](https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/);
  [gh releases](https://github.com/cli/cli/releases)).
  - Installs into Copilot, Claude Code, Cursor, Codex, Gemini CLI and Antigravity, later
    "a large number of agent hosts" (v2.91, 2026-04-22) and pi (v2.99, 2026-09-01).
  - Pins with `--pin` and writes provenance (repo, ref, tree SHA) into SKILL.md frontmatter.
  - Skills only. The request for `gh` to support Agent Plugins is backlogged as "not committing"
    ([cli/cli#14092](https://github.com/cli/cli/issues/14092), opened 2026-08-06).
- **APM**, in the `microsoft` org: MIT, 3,928★, v0.33.0 on 2026-10-02, 13 harness targets with a
  lockfile ([releases](https://github.com/microsoft/apm/releases); prior notes in
  `research/notes-A-apm-specs.md`). It is an open-source project led by one Microsoft engineer
  and one EPAM engineer, not a Copilot product feature.

**Standards roles**
- Harald Kirschner (Microsoft) holds a seat on the Agent Plugins TSC.
- ARD is co-authored by R. V. Guha (Microsoft), with GitHub and Microsoft as launch contributors
  ([Synscribe, 2026](https://www.synscribe.com/blog/google-agentic-resource-discovery-ard-specification) [2nd]).
- Copilot is "exploring" plugin dependencies under `extensions.com.github.copilot`
  ([Agent Plugins discussion #51, comment 2026-09-22](https://github.com/agentplugins/agent-plugins-spec/discussions/51)).

**Reading:** GitHub/Microsoft is the most neutral of the vendors and the most direct competitor
to palm. An aggregator gains from neutrality, and it ships that neutrality as tools.

### 3.4 Cursor

- **Plugins in 2.5** (2026-02-17): "Plugins package skills, subagents, MCP servers, hooks, and
  rules, into a single install"
  ([changelog 2.5](https://cursor.com/changelog/2-5)).
- **Accepted formats.** Agent Plugins and `.cursor-plugin/plugin.json`. Rules, agents, commands
  and hooks are available in "Cursor Plugins only". Team marketplaces have Default Off, Default On
  and **Required** modes ([plugins docs, accessed 2026-10-02](https://cursor.com/docs/plugins)).
- **Skill locations.** `.agents/skills` and `.cursor/skills`, and "For compatibility, Cursor also
  loads skills from Claude and Codex directories"
  ([skills docs](https://cursor.com/docs/skills)).
- **Claude hooks.** Claude Code hooks load from `.claude/settings.local.json`,
  `.claude/settings.json` and `~/.claude/settings.json` when "Include Third-Party Plugins,
  Skills, and Other Configs" is on, which is the default. Eight events are mapped; `Notification`,
  `PermissionRequest` and `Glob` matching are unsupported
  ([third-party hooks](https://cursor.com/docs/reference/third-party-hooks)).
- **CLI history**
  ([Cursor CLI changelog](https://cursor.com/docs/cli/changelog)):

  | Date | Change |
  |---|---|
  | Jan 2026 | Claude `settings.json` hooks read |
  | Mar 2026 | Skills from `.claude`, `.agents` and `.codex` |
  | 2026-05-07 | "Plugins imported from Claude Code appear alongside native ones in the marketplace" |

- **AGENTS.md** is supported, including nested files; `CLAUDE.md` is not mentioned
  ([rules docs](https://cursor.com/docs/context/rules)).
- **Reading:** Cursor reads Claude's files everywhere. Its own extras (rules, team marketplaces,
  cloud-agent sync) work only inside Cursor.

### 3.5 Google

**Timeline**
- **Gemini CLI extensions** and the geminicli.com gallery launched on 2025-10-08
  ([Google blog](https://blog.google/innovation-and-ai/technology/developers-tools/gemini-cli-extensions/)).
- **Skills.** Gemini CLI reads `.agents/skills` and `~/.agents/skills` as aliases, ahead of
  `.gemini/skills` ([docs, accessed 2026-10-02](https://geminicli.com/docs/cli/skills/)).
- **Transition to Antigravity CLI.**
  - Announced 2026-05-19. Gemini CLI stopped serving Google AI Pro, Ultra and free-tier users on
    2026-06-18 ([Google Developers Blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)).
  - Kept features: "Agent Skills, Hooks, Subagents, and Extensions (now as Antigravity plugins)".
  - The repo "remains available to the community as an Apache 2.0 licensed repository" for
    enterprise. It still ships nightly builds (v0.64.0-nightly, 2026-10-02).
  - The community calls the move "basically ... closed source", and the announcement drew 301
    down-votes ([discussion #27274](https://github.com/google-gemini/gemini-cli/discussions/27274)).

**Antigravity plugins**
- Own schema URL `https://antigravity.google/schemas/v1/plugin.json`.
- Components: `skills/`, `agents/`, `rules/`, `mcp_config.json` and `hooks.json`.
- Installed to `.agents/plugins/` (workspace) or `~/.gemini/config/plugins/`, with
  `agy plugin install|list|enable|disable`
  ([Antigravity docs, accessed 2026-10-02](https://antigravity.google/docs/plugins/)).
- Workspace config sits under `.agents/` for skills, rules, `mcp_config.json`, `hooks.json`,
  agents and plugins
  ([Atamel, 2026-08-21](https://atamel.dev/posts/2026/08-21_where_agy_configuration_summary/) [2nd]).
- Described as "currently a superset of Agent Plugins"
  ([Atamel, 2026-08-18](https://atamel.dev/posts/2026/08-18_where_agy_plugins/) [2nd]).

**Standards**
- Joined Agent Plugins as a Core Maintainer on 2026-08-06, with support in Agents CLI and the
  Data Agent Kit. The blog says the spec "defines no install mechanism, no distribution protocol,
  no permission model ... no trust or provenance verification". It points to ARD and AI Catalog
  for discovery
  ([Google Developers Blog, 2026-08-06](https://developers.googleblog.com/agent-plugins-package-your-skills-tools-and-more/)).
- **ARD** (Agentic Resource Discovery), announced 2026-06-17. It is `/.well-known` catalogs plus
  crawling registries, at v0.91 "Proposal" as of 2026-08-26, and covers discovery only
  ([letsdatascience](https://letsdatascience.com/news/google-publishes-agentic-resource-discovery-specification-c80b3e40) [2nd]).

**Reading:** Google is the clearest case of churn. The harness palm targets as "Gemini" lost its
consumer users in June 2026. Its successor is closed source, uses new file names, and adopted
`.agents/` as its workspace directory.

### 3.6 OpenCode (anomalyco/opencode, 211k★)

- **Context files.** Reads `AGENTS.md`, then falls back to `CLAUDE.md`, `~/.claude/CLAUDE.md` and
  `~/.claude/skills/`. `OPENCODE_DISABLE_CLAUDE_CODE*` switches turn this off
  ([rules docs, accessed 2026-10-02](https://opencode.ai/docs/rules/)).
- **Packaging gaps (still open)**
  - No marketplace or registry:
    [#28696](https://github.com/anomalyco/opencode/issues/28696), open since 2026-05-21.
  - No Agent Plugins:
    [#40993](https://github.com/anomalyco/opencode/issues/40993), open since 2026-08-07. Its
    latest comment (2026-10-02) reads "You're losing pace".
- **Plugins** are npm JavaScript modules, not content bundles (prior notes C).
- **Reading:** OpenCode is open but not organised around packaging. Its compatibility comes from
  reading Claude's and the `.agents` directories.

### 3.7 pi (earendil-works/pi, 112k★)

- **Ownership.** Mario Zechner joined Earendil with pi on 2026-04-08, and the repo moved from
  badlogic/pi-mono ([Pi Map](https://www.pi-map.org/news/pi-joins-earendil/) [2nd];
  [pi.dev changelog 2026-05-07](https://pi.dev/changelog/2026/5/7/pi-has-a-new-home)).
- **Packages** install from `npm:`, `git:`, URL or a local path. "Versioned npm specifications are
  pinned. Git tags and commits are also pinned." Project packages load "only after project trust
  is resolved". There is a gallery at pi.dev/packages
  ([packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)).
- **Skills** follow the Agent Skills spec and load from `~/.agents/skills` and `.agents/skills`
  ([skills.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)).
- **Context files**: `AGENTS.md` and `CLAUDE.md`.
- **MCP** is now built in (`pi mcp add`, `~/.pi/agent/mcp.json`, `.pi/mcp.json`). For servers
  configured in other clients, the docs say "Copy the existing `mcpServers` entry" (Claude,
  Cursor) or convert TOML by hand (Codex) (docs/mcp.md at HEAD, 2026-10-02).
- **Reading:** pi has its own package system, adds yet another MCP file, and reads no plugin
  formats.

---

## 4. The shared standards and registries

### 4.1 Agent Skills (agentskills.io)

**Who controls it.** Anthropic, today. The AAIF proposal states: "Today the maintainers listed
above are all at Anthropic" (Mahesh Murag and David Soria Parra). "There is no separate steering
body"; "spec changes are merged on GitHub without a written approval rule."
- Anthropic has invited engineers from organisations with production implementations to an
  initial TSC.
- What changes hands on acceptance: "the canonical repository, the agentskills.io domain, the
  GitHub organization, and the name."
- Status: TC approved 2026-10-01; contribution agreement unsigned; Governing Board vote pending
  ([#47](https://github.com/aaif/project-proposals/issues/47)).

**Adoption.** 46 clients ship support, 44 of them built by organisations other than Anthropic.
They include VS Code and Copilot, Gemini CLI, ChatGPT and Codex, Junie, Kiro, Goose, Cursor,
Mistral Vibe and Databricks (same source).

**12-month roadmap.** Versioned releases, a numbered change process, a TSC, security guidance,
and stabilising or removing `allowed-tools`. **Nothing on distribution, location, versioning of
skills, or locking** (same source).

**Open issues that overlap palm.** All still open on 2026-10-02:

| Issue | Opened | Comments | Topic |
|---|---|---|---|
| [#15](https://github.com/agentskills/agentskills/issues/15) | 2025-12-19 | 100 | Standard folder for skills |
| [#46](https://github.com/agentskills/agentskills/issues/46) | 2025-12-24 | 19 | Versioning and locking |
| [#27](https://github.com/agentskills/agentskills/issues/27) | 2025-12-20 | – | Distribution standard |
| [#255](https://github.com/agentskills/agentskills/issues/255) | 2026-03-17 | 20 | `.well-known` discovery |
| [#86](https://github.com/agentskills/agentskills/issues/86) | 2026-01-14 | – | Secrets |
| [#110](https://github.com/agentskills/agentskills/issues/110) | 2026-01-28 | – | Dependencies |
| [Discussion #588](https://github.com/agentskills/agentskills/discussions/588) | 2026-10-01 | – | `skills-lock.json` draft spec (third party, at draft-03 the next day) |

- **#15, the folder question.** Jonathan Hefner, who also leads Agent Plugins, argued against
  mandating `.agents/skills`: "provide guidance outside of the spec — recommendations, not
  mandates"
  ([comment, 2026-02-24](https://github.com/agentskills/agentskills/issues/15#issuecomment-3953421393)).
- **#27, distribution.** "Many folks are standardizing on `.agents/skills`" (Lee Robinson,
  2026-02-03).

### 4.2 AGENTS.md

- **Stewardship.** AAIF has held it since 2025-12-09. The project added a Technical Charter on
  2026-09-10 ([commits](https://github.com/agentsmd/agents.md/commits/main)).
- **No spec.** "AGENTS.md is just standard Markdown" ([agents.md](https://agents.md/)). An
  implementation-spec request is open
  ([#211](https://github.com/agentsmd/agents.md/issues/211), 2026-06-25), and so is a
  standardised `.agents/rules/` format
  ([#179](https://github.com/agentsmd/agents.md/issues/179), 2026-04-15).
- **Readers.** Now read by every harness in the table. Claude Code reads it only when there is no
  `CLAUDE.md` (since 2026-09-18).
- **Effect on palm.** The root instruction file is effectively solved. Scoped rules are not:
  - `.claude/rules`
  - `.cursor/rules/*.mdc`
  - `.github/instructions`
  - `.agents/rules` (Antigravity)

### 4.3 Agent Plugins (agent-plugins.org)

- **Release and governance.**
  - 1.0.0 published 2026-07-27 and announced 2026-08-06.
  - TSC: Amazon, Cursor, Microsoft, OpenAI and Vercel (lead); Google announced. No Anthropic seat.
  - The 1.1.0 working draft (2026-08-12) has only bumped versions so far
    ([commits](https://github.com/agentplugins/agent-plugins-spec/commits/main)).
- **Scope.** Skills and `mcp.json` only. VS Code says agents, hooks, commands and rules are
  client-specific (§3.3).
- **Distribution is out of scope, in the lead maintainer's own words.**
  - Marketplaces: "I think marketplaces are a distribution artifact, and I think distribution is
    outside the scope of the Agent Plugins spec ... my personal recommendation is AI Catalog (or
    ARD)" ([discussion #52, 2026-08-18](https://github.com/agentplugins/agent-plugins-spec/discussions/52)).
  - Dependencies: "plugins should be monolithic units, with no required dependencies between
    them" ([#51](https://github.com/agentplugins/agent-plugins-spec/discussions/51)).
  - Repo-local plugin location: "would fall outside the scope of the spec"
    ([#57](https://github.com/agentplugins/agent-plugins-spec/discussions/57)).
  - A proposal for a portable hooks component has had no maintainer response since 2026-08-12
    ([#54](https://github.com/agentplugins/agent-plugins-spec/discussions/54)).
- **The companion installer looks abandoned.** Vercel's `npx plugins` appears to be unmaintained:
  "its referenced github repository ... is not available"
  ([#53, comment 2026-09-25](https://github.com/agentplugins/agent-plugins-spec/discussions/53)).

### 4.4 MCP Registry and Skills over MCP

**Registry status**
- In preview since 2025-09-08, with the v0.1 API frozen on 2025-10-24. The service is at v1.8.1
  (2026-08-06), and the docs still warn: "Breaking changes or data resets may occur before
  general availability" ([about page, accessed 2026-10-02](https://modelcontextprotocol.io/registry/about);
  [README](https://github.com/modelcontextprotocol/registry)).
- **Not for clients**: "The MCP Registry is not intended to be directly consumed by host
  applications. Instead, host applications should consume other MCP registries, such as
  downstream marketplaces" (about page).
- **Explicitly out of scope:** curation, quality rankings, "Unified runtime: Not solving how
  servers are executed", search engine, tags. The roadmap's phase labels are "out of date as of
  2026-08-10"
  ([registry roadmap](https://github.com/modelcontextprotocol/registry/blob/main/docs/design/roadmap.md)).
- **Missing from the protocol roadmap.** The MCP roadmap of 2026-08-22 does not mention the
  registry ([roadmap](https://modelcontextprotocol.io/development/roadmap)).

**Skills over MCP**
- **Status.** SEP-2640 is Final, and the stable spec was finalised on 2026-09-08
  ([overview](https://modelcontextprotocol.io/extensions/skills/overview);
  [decision log](https://github.com/modelcontextprotocol/ext-skills/blob/main/docs/decisions.md)).
- **What it does.** Servers list skills with per-file SHA-256 manifests, and "Persisted approval
  MUST bind to the complete set of file URIs and digests".
- **Who supports it.** ChatGPT (partial), fast-agent (partial), MCP Inspector (partial) and mcpc.
  **None of Claude Code, Codex CLI, Cursor, VS Code or Copilot**
  ([matrix](https://modelcontextprotocol.io/extensions/client-matrix)).
- **Relevance to palm.** It is a second, server-side route for distributing vendor skills, and it
  shares palm's consent-by-hash idea. Adoption is too thin to matter before 2027.

### 4.5 Discovery layers (adjacent, not install)

- **AI Catalog** (Linux Foundation working group): "A JSON format for making all your AI
  artifacts discoverable", with no install or lock semantics ([ai-catalog.io](https://ai-catalog.io/)).
- **ARD** is built on top of AI Catalog (§3.5).
- **ARA**, an AWS-originated "package registry and distribution system for AI development
  artifacts", has 3 commits ([ara-registry/spec](https://github.com/ara-registry/spec)).

### 4.6 Proposals AAIF did not take

Agent Plugins has not been proposed to AAIF, and "workspace.json" was declined
([proposal list](https://github.com/aaif/project-proposals/issues)). No foundation project covers
installing, pinning or syncing agent configuration.

---

## 5. palm's jobs: who will do each one by late 2027 or 2028

| palm job | State on 2026-10-02 | Who is solving it | 12–24 month outlook |
|---|---|---|---|
| Put skills where each harness reads them | `.agents/skills` is read by Codex, Cursor, Copilot, Gemini/Antigravity, pi and OpenCode. `.claude/skills` is read by Claude, Cursor, Copilot and OpenCode | Convergence by reading | **Nothing needed** beyond writing two directories or a symlink. Claude adopting `.agents/skills` (#31005) removes even that |
| Root instructions | AGENTS.md everywhere; Claude reads it only as a fallback | AAIF | **Nothing needed** |
| Scoped rules | 4+ formats (§4.2) | No one; Copilot reads `.claude/rules` | Thin translation |
| Skill + MCP bundles | Agent Plugins read by Codex, Cursor, Copilot, VS Code and (as a superset) Antigravity. Claude's format read by Codex, Copilot, VS Code and Cursor | Agent Plugins TSC | **Nothing needed** for the bundle format. Enabling the bundle is still per harness (each has its own marketplace and enable entry) |
| Subagents | Formats differ (`.claude/agents` md, Codex toml, `.github/agents/*.agent.md`, Cursor, `.agents/agents`) | No one; Codex imports one-way; Copilot reads `.claude/agents` | Translation stays |
| Hooks | Event names and shapes differ; Cursor maps 8 Claude events; Codex imports; outside Agent Plugins | No one | Translation stays (the hardest part) |
| MCP config in a project | Eight or more files (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.github/mcp.json`, `.codex/config.toml`, `.gemini/settings.json`, `.agents/mcp_config.json`, `.pi/mcp.json`, `opencode.json`), with different secret syntax | No one. The registry is metadata for aggregators | Translation stays |
| Pin and lock across harnesses | No harness CLI has a committable cross-harness lock. Claude has no user version pin. `gh skill` pins skills only, in frontmatter | APM, `gh skill` (skills), community drafts (agentskills #46, #588) | **Neutral layer needed.** Every spec defers it |
| Team reproducibility (clone and it works) | Claude #89683 open. Vendors solve it inside their own accounts (claude.ai org sync, Cursor team marketplaces, Copilot enterprise-managed plugins, ChatGPT workspaces) | Each vendor, for its own harness | **Neutral layer needed** for mixed-harness teams. This is where lock-in grows |
| Consent for executables, bound to a hash | Per harness: Codex hook trust, Gemini consent, Claude managed policy, MCP Skills approval bound to digests | Each vendor | **Neutral layer needed** for one review that covers every harness |
| CI drift check | None from vendors | APM `audit`, palm `check` | **Neutral layer needed** |
| Install into other harnesses and remove exactly | Vendors only import (Codex) or read (Cursor, Copilot, OpenCode) | `gh skill`, APM, rulesync, Vercel `skills` | **Neutral layer needed**, in a crowded field |

---

## 6. Verdict

**(b) Only a thin layer will be needed. Probability about 60%; (a) about 28%; (c) about 12%.**

**Why not (c), "nothing needed".** For (c), four things would all have to happen within two
years, and the evidence points against each:
1. **Anthropic reads `.agents/` and Agent Plugins.** It has refused user-level `.agents/skills`
   and keeps adding Claude-only kinds.
2. **Agent Plugins grows to cover hooks, agents and distribution.** The lead keeps declaring
   these out of scope.
3. **A lockfile standard is adopted by the harness CLIs.** The only drafts are community ones,
   and the Agent Skills 12-month roadmap omits it.
4. **Vendors make team distribution work across vendors.** Every vendor builds it inside its own
   account system, and the only cross-vendor movement is one-way import.

**Why not (a), "a full manager".** The expensive part of palm's job is shrinking fast:
- Skills and root instructions are converging on `.agents/skills`, `.claude/skills` and
  `AGENTS.md`.
- Skill-and-MCP bundles are converging on Agent Plugins.
- Harnesses increasingly read Claude's files natively (Cursor, Copilot, OpenCode) or import them
  (Codex).

A tool whose main value is "copy this skill into six folders" will be obsolete by 2027.

**Why (b).** Two kinds of work stay neutral and unsolved, and neither is large:
- **A governance core** that no vendor or spec plans to build: a cross-harness lock pinned to
  commits, provenance, one consent pinned by hash for programs, a read-only CI check, and exact
  removal.
- **A translation shim** for the three kinds that are not converging: hooks, subagents, and the
  MCP config in each project. It also writes each harness's plugin enable or marketplace entries.

Over time, the shim's job moves from converting formats to "write the native pointer to the
portable thing".

**What would move it to (a).** The evidence for (a) is real and could grow:
- Vendors keep adding proprietary component types (Claude Mods, workflows and channels).
- Google's successor uses new file names.
- pi added yet another MCP file.
- Copilot retreated from reading `~/.claude`.

If Anthropic stays outside Agent Plugins and `.agents/`, and Antigravity keeps its own schema, the
translation work stays substantial.

**Who palm actually competes with.** Not the model vendors: their tools never write into another
vendor's harness. The competition is GitHub/Microsoft:
- `gh skill` gives skill pinning and provenance in the `gh` binary every GitHub user has.
- APM gives lock, audit and 13 targets.

If GitHub folds Agent Plugins (cli/cli#14092) and MCP into `gh`, case (b) moves from "neutral
tool" toward "neutral feature of `gh`".

### Signals to watch (each one changes the verdict)

| Signal | Where | Pushes toward |
|---|---|---|
| Claude Code reads `.agents/skills` or Agent Plugins `mcp.json`; Anthropic joins the Agent Plugins TSC | claude-code #31005; agent-plugins MAINTAINERS.md | (c) |
| Agent Skills under AAIF adopts a location recommendation, a lockfile, or `.well-known` distribution | agentskills #15, #46, #255, #588 | (c) for skills |
| Agent Plugins 1.1 or 2.0 adds hooks, agents or dependencies | discussions #51, #54 | (c) for bundles |
| `gh` gains `gh plugin` and Agent Plugins support, or `gh skill` leaves preview with a lockfile | cli/cli#14092, gh release notes | (b) taken by GitHub |
| More harnesses ship one-way import with ongoing sync (like Codex desktop) | vendor changelogs | (b), with migration rather than sharing |
| More proprietary kinds, closed successors, new MCP file names | Claude changelog, Antigravity docs, pi docs | (a) |
| MCP Registry reaches GA, and Skills over MCP lands in Claude Code, Codex or Cursor | registry README; MCP extension matrix | Less file-based distribution for vendor skills; palm's lock and consent still apply |

### Implications for palm, briefly

- Make the governance core the product: lock, consent pinned by hash, `check`, exact removal.
  Present file placement as the easy part, not the pitch.
- Prefer the portable targets when a harness reads them:
  - `.agents/skills` alongside `.claude/skills`
  - `AGENTS.md` with a `CLAUDE.md` pointer
  - Agent Plugins `plugin.json` and `mcp.json` when packaging

  Translate only hooks, agents, MCP config and plugin-enable entries.
- **Revisit the "gemini" target.** Consumer Gemini CLI stopped serving on 2026-06-18, and
  Antigravity uses `.agents/` with `mcp_config.json` and `hooks.json`. Consider an Antigravity
  target, and consider pi, which `gh skill` already supports.
- Position against `gh skill` and APM on the governance core. `gh skill` covers skills only and
  is in preview. APM resolves literal secrets for Codex, Cursor and Gemini and needs a compile
  step (prior notes A).
