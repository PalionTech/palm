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

## 0.2.1

### Patch Changes

- [#19](https://github.com/PalionTech/palm/pull/19) [`47d1747`](https://github.com/PalionTech/palm/commit/47d1747259ff32188c61a3bec0fc461c8d7c456a) Thanks [@MaxBer04](https://github.com/MaxBer04)! - Two or more palm commands started together in a project could fail with `ENOENT` on `.palm/local`: a run that finished removed the empty `.palm/local/` directory while another run was creating its lock in it. palm now keeps `.palm/local/` after a run (it is ignored by git and holds only the lock while palm runs), and a lock whose directory disappears at that moment is created again.

## 0.2.0

### Minor Changes

- [#15](https://github.com/PalionTech/palm/pull/15) [`a7b9a29`](https://github.com/PalionTech/palm/commit/a7b9a293dda8b24fb714ef5989d0502b9fa92135) Thanks [@MaxBer04](https://github.com/MaxBer04)! - palm 0.2 now reads and writes text with LF line ends, so a repository whose `.gitattributes` normalises line ends (`* text=auto eol=lf`) stays clean after a fresh clone; it never deletes through a per-skill symlink into another harness's folder, takes the process lock (now `.palm/local/lock`, released on SIGHUP and SIGTERM too) before it reads palm.yaml, and refuses to run without `HOME` or `PALM_HOME`. Ctrl-C during a run always ends with the report and exit 130. A committed palm.yaml that names a `file://` source outside the project is refused until you pass `--allow-local-sources` (install, update, remove, check), and the lock records such a URL relative to the project.
  
  `palm check` gains the `targets`, `foreign-servers` and `variables` checks, `--strict` (fails on foreign hooks and stdio servers and on checks that could not run), an `ignore:` list in palm.yaml for warnings you accept, and exits 1 without palm.yaml. A fetch or permission failure is reported as itself, never as files that differ; one edited hook prints one line. Programs get their own plan status (`changed program`, `new program`) and a `~ trusted` line; the consent block names skipped targets, marks literal env values and unpinned `npx` packages, and reads `~/` paths under `-g`. Hand-declared servers are keyed `@palm.yaml` everywhere. Listings show plugin rows, whole hook commands and entities an install would refuse; near-miss files, zero-match globs and `apm.yml` dependencies are printed, a layout keeps the plugins a source declares, and `create` writes into the in-repo source palm.yaml declares. A source's high-entropy env or header value becomes `${KEY}`, a URL keeps its host with only the secret parameter referenced, a typed value that is no secret is written as typed, and `palm migrate` lists every file it removes and splits per-skill pins into their own sources.

- [#15](https://github.com/PalionTech/palm/pull/15) [`a7b9a29`](https://github.com/PalionTech/palm/commit/a7b9a293dda8b24fb714ef5989d0502b9fa92135) Thanks [@MaxBer04](https://github.com/MaxBer04)! - palm 0.2 now writes nothing when a run fails before it changed the disk, never gives one file two owners, and treats an in-repo source per entry: two pull requests that edit different skills no longer conflict in palm.lock.yaml. Ctrl-C stops between entities and exits 130; declining a program you named, or the new version of a program you trusted, exits 130 and writes nothing, and a plugin's hook you decline is recorded as `exclude: [hook:<name>]` in palm.yaml. Every hint is a command you can paste, and a value you typed for a secret is written and repeated only as its `${VAR}` reference.
  
  `palm check` has new checks (`render`, `partial`, `orphans`, `pending`, `source-paths`, and the warnings `foreign-hooks`, `agent-names`, `preloads`), groups problems per entity, warns when a generated file is not committed yet, and takes `--quiet`. A hook item changed on disk is reported as changed and never appended again. A hook's closure carries the files its scripts read, in-repo hook scripts are part of the program's hash, and a literal secret in a hook script refuses the hook unless `--force`. Install refuses an `AGENTS.md` above the harness's cap without `--force`, `install --force` removes stray files in folders palm owns, and `--layout kind=glob` declares a new source's layout. `palm migrate` asks before it writes, keeps palm.yaml comments, removes the files 0.1 copied that 0.2 no longer writes there, and ends with `palm check`.

- [#15](https://github.com/PalionTech/palm/pull/15) [`a7b9a29`](https://github.com/PalionTech/palm/commit/a7b9a293dda8b24fb714ef5989d0502b9fa92135) Thanks [@MaxBer04](https://github.com/MaxBer04)! - Breaking: palm 0.2 replaces origins with sources declared in palm.yaml. `palm install <owner/repo> [names]` lists a source or installs from it and records it (a new source gets `ref: ^M.m` of its latest release, and palm says so); `palm install` alone makes the disk match palm.yaml and the new version 3 lock, which records one render hash per target, the file list, merged-entry identities and program hashes. Generated files, including the scripts hooks run under `.palm/assets/`, are committed, and `palm check` is the read-only CI gate. Programs (hooks and stdio MCP servers) need a hash-pinned consent: the prompt defaults to no, `--yes` never consents, and without a terminal palm prints the exact `--allow-exec <key>=<hash>` line; `install <source> --all` leaves programs out. `update [sources] [--to ref]` moves the sha within the ref's range, `remove` deletes exactly what palm wrote, `create` writes a template into an in-repo source such as `./agent-kit`, and `install mcp` takes flags or a README snippet (`--snippet <file or ->`). A literal secret from a source is written as `${VAR}`. The registry client, `search`, `doctor`, `audit`, `outdated`, `why`, `find`, `config`, the `command` kind, `--frozen` and `~/.palm/config.yaml` are gone; the old commands print their replacement.
  
  To migrate a palm 0.1 project, run `palm migrate` in it (`palm migrate -g` for the global scope; `--dry-run` prints the new palm.yaml first), then commit palm.yaml, palm.lock.yaml, `.gitignore` and `.palm/assets/`.

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
