# Security policy

palm clones repositories you choose and writes files into your projects, your home directory
and your harness configuration. A bug in how it does that can expose files or run code you did
not agree to, so we treat such reports as a priority.

## Report a vulnerability

Report it privately through GitHub:
[github.com/PalionTech/palm/security/advisories/new](https://github.com/PalionTech/palm/security/advisories/new).
Do not open a public issue, discussion or pull request for it. If you cannot use GitHub, email
[maximilian@paliontech.com](mailto:maximilian@paliontech.com).

Please include:

- the palm version (`palm --version`), your OS and Node.js version;
- the commands you ran, and a minimal origin repository or files that reproduce the problem;
- what an attacker controls in your scenario (an origin's content, a project's `palm.yaml`, an
  environment variable) and what they gain.

## Supported versions

Only the latest release receives fixes. palm is on 0.x, so a fix ships as a new patch or minor
release rather than a backport.

## Scope

In scope, meaning palm's own behaviour:

- **Path confinement.** An entity name, a path in an origin or a path in `palm.lock.yaml` makes
  palm read, write or delete outside the project root (project scope) or outside your home,
  `$PALM_HOME` and the harness directories (global scope).
- **Symlink handling.** A symlink in an origin makes palm copy a file from outside that origin,
  such as `~/.ssh/id_rsa`, or write through a link to a location it should not touch.
- **Git transport hardening.** An origin URL or repository content makes git use a transport
  palm blocks (`ext::`, `fd::`, `file://` for remote origins), prompt for credentials, pick up
  settings from the environment it should ignore, or run a command.
- **Secret placement.** palm writes a secret value into a file meant to be committed (for
  example `.mcp.json` or `palm.yaml`) instead of an environment variable reference, leaves a
  file holding secrets readable by other users, or prints a secret in its output or logs.
- **Lockfile-driven deletion.** `palm uninstall`, `palm update` or `palm install` deletes or
  overwrites a file palm did not write, a file you changed after palm wrote it, or anything
  outside the scope, based on what the lockfile says.
- Anything that makes palm run a hook, a script or an MCP server command without showing it to
  you first, when the documentation says palm asks.

Out of scope:

- **The content of origins you chose to trust.** A skill, agent, hook or MCP server does what
  its author wrote. palm installs it as it is; it does not review or sandbox it. Report a
  malicious package to its repository's host instead.
- Vulnerabilities in a harness (Claude Code, Codex, GitHub Copilot, Cursor, Gemini CLI,
  OpenCode) or in how it runs what palm installed.
- Vulnerabilities in palm's dependencies with no way to reach them through palm. Report those
  upstream; we update when a fix is released.
- Windows, which palm does not support yet.

## What happens after you report

| Step | Target |
|---|---|
| We confirm we received the report | within 3 working days |
| We tell you whether we accept it and how severe we think it is | within 10 working days |
| Fix released for a critical or high severity issue | within 30 days of accepting it |
| Fix released for a moderate or low severity issue | in the next planned release |

We keep you updated while we work on a fix, agree the disclosure date with you, and publish a
GitHub security advisory with a CVE when the fix is released. We credit you in the advisory
unless you ask us not to.
