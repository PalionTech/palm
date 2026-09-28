---
title: Policies
description: What palm promises about versions, platforms, the network and security reports.
---

This page states what palm promises today, as of 2026-09-28, and what it does not.

```sh
palm --version
palm doctor --offline
```

| Topic | Policy |
| --- | --- |
| Versions | Semantic versioning, still on 0.x |
| Platforms | macOS and Linux; Windows untested |
| Runtime | Node 22 or later, and git |
| Telemetry | None, and no update check |
| Network | git to your origins, the MCP registry, and URLs you pass |
| Security reports | Private, through GitHub security advisories |

## Versioning

palm follows semantic versioning and is on 0.x.
Before 1.0, a minor release may change commands, options or file formats, and the changelog says so.
A patch release fixes bugs without such changes.
Only the latest release receives fixes; there are no backports.

The lockfile carries a `version`, currently `2`.
palm reads version 1 and converts it, and refuses a version it does not know.
`palm.yaml` and `config.yaml` have no version key.
palm keeps the keys it does not know in both files.

## Platforms

| Platform | Status |
| --- | --- |
| macOS | Supported |
| Linux | Supported |
| Windows | Untested. Paths, hook commands and file modes may not work. |

palm needs Node 22 or later and git on `PATH`.
`palm doctor` checks both.

## Network

palm sends no telemetry, keeps no usage statistics and checks for no updates.
It opens a connection only in these cases:

| Connection | When |
| --- | --- |
| git `ls-remote`, `clone` and `fetch` to an origin's host | Adding an origin; installing from an origin that is not cached at the wanted commit; `palm update`; `palm outdated`; `palm search --refresh` |
| git `ls-remote` to each origin | `palm doctor` |
| HTTPS to the MCP registry: `registry.modelcontextprotocol.io`, or your `mcpRegistryUrl` | `palm search` without a kind or with `mcp`; installing, updating or checking a registry server; the MCP server search in `palm create agent` |
| HTTPS to a URL you pass | `palm install origin` with an `https://` URL to a `marketplace.json` |

`--offline` skips every connection in the table.
A command that cannot work without one then fails with `E_NETWORK`, or shows `?` in `palm outdated`.

MCP servers and hooks that palm installs run inside your harness, not inside palm.
Their own network use is outside these rules.

## Security

Report a vulnerability privately through [GitHub security advisories](https://github.com/PalionTech/palm/security/advisories/new).
Do not open a public issue for it.
The repository's `SECURITY.md` lists what is in scope and the response times.

[The security model](/palm/explanation/security/) explains what palm trusts and what it refuses.

## Related

- [Troubleshooting](/palm/reference/troubleshooting/)
- [palm.lock.yaml](/palm/reference/palm-lock-yaml/)
- [Environment variables](/palm/reference/environment/)
