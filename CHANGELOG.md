# Changelog

All notable changes to palm are recorded in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and palm uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While palm is on 0.x,
a minor release may contain breaking changes and a patch release never does.

Entries are not written by hand. Each pull request that changes something users
can see adds a changeset (`npx changeset`). When the "Version Packages" pull
request is merged, [Changesets](https://github.com/changesets/changesets)
collects them into a new section below, bumps the version and publishes to npm.

<!-- Changesets inserts each new version above the first version heading in this file.
     The 0.0.0 heading keeps the introduction above the first release; delete it once
     0.1.0 is listed. -->

## 0.1.0

### Minor Changes

- [`e91183e`](https://github.com/PalionTech/palm/commit/e91183e5b9e7baa2e16369ae5dcae40984e788dd) Thanks [@MaxBer04](https://github.com/MaxBer04)! - First public release. palm installs skills, agents, instructions, commands, hooks, MCP servers and plugins from git repositories you choose (origins). It writes each one into the native files of six harnesses: Claude Code, Codex, GitHub Copilot, Cursor, Gemini CLI and OpenCode.
  
  - Commands follow a kubectl-style grammar, `palm <verb> [kind] [names...]`: `install`, `uninstall`, `get`, `describe`, `update`, `create` and `search`, plus the utilities `init`, `doctor`, `outdated`, `why`, `find`, `audit`, `config`, `completion` and `cache`.
  - `palm.yaml` lists what a project asked for. `palm.lock.yaml` (format version 2) records the commit each entity came from, its targets, a hash of every file palm wrote, and each entry palm merged into a shared config file such as `.mcp.json`. `palm install` with no names rebuilds the project from these two files, and `palm uninstall` removes only what palm added.
  - `palm install --frozen` is for CI. It never writes `palm.yaml` or the lockfile, restores missing files from the locked commits, and fails when the manifest, the lockfile, the installed files and the merged config entries disagree.
  - Hooks and stdio MCP servers run commands on your machine. palm lists those commands and asks before it installs them; scripts pass `--yes`.
  - `palm audit` scans installed files for hidden Unicode and for changes since install. `palm install` refuses an entity with critical hidden characters (bidi overrides, tag characters) unless you pass `--force`.
  - `palm update` prints a plan of what would change and asks before it applies it. `palm outdated` shows the locked, wanted and latest ref of each direct install. `palm why` shows why an entity is installed, and `palm find` shows which entity wrote a file.
  - MCP secrets: project files get each harness's environment reference, never the value. With `--secrets literal` (the default for `-g`), the value goes into a user config file created with mode `0600`.
  - palm does not overwrite a file you changed unless you pass `--force`.
  - Requires Node.js 22 or later and git. Windows is not supported yet.

## 0.0.0

Not released. This is the version the repository had before 0.1.0, the first release.
