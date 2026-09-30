---
title: Policies
description: What palm promises about versions, file formats, platforms, the network and security reports.
---

This page states what palm promises as of 2026-09-30, and what it does not.

```sh
palm --version
palm check --offline
```

| Topic | Policy |
| --- | --- |
| Versions | Semantic versioning, still on 0.x |
| Platforms | macOS and Linux; Windows unsupported |
| Runtime | Node 22 or later, and git |
| Telemetry | None, and no update check |
| Network | git to the sources you declare, nothing else |
| Security reports | Private, through GitHub security advisories |

## Versioning

palm follows semantic versioning and is on 0.x.
Before 1.0, a minor release may change commands, options or file formats, and the changelog says so.
A patch release fixes bugs without such changes.
Only the latest release receives fixes.

| Release | Focus |
| --- | --- |
| 0.2 | Sources in `palm.yaml`, lock version 3, committed generated files, `palm check`, hash-pinned consent, `palm migrate` |
| 0.3 | The personal `palm.local.yaml`, placement with `at:`, one carrier per harness, activation mapping, the hook mapping table, `palm migrate` removed |
| 1.0 | Every placement and hook mapping tested against the real CLIs of all six harnesses |

## File formats

The lock carries `version: 3`.
palm 0.2 reads versions 1 and 2 only through `palm migrate`, and every other command names that command.
`palm.yaml` has no version key. palm detects the 0.1 format by its shape.
palm keeps keys it does not know in `palm.yaml`, together with your comments and key order.

The old command grammar works for one release as hidden aliases, and removed commands print their replacement.

## Platforms

| Platform | Status |
| --- | --- |
| macOS | Supported |
| Linux | Supported |
| Windows | Not supported. Paths use the platform's joiner, so a contributor can add it. |

## Network

palm sends no telemetry, keeps no usage statistics and checks for no updates.
It has no registry client, so it never looks up a name on a server.
Its only connections are git to the hosts of the sources you declare.

| Command | Connects when |
| --- | --- |
| `palm install <source>` | the source is new, or its commit is not cached |
| `palm install` | a locked commit is not cached, or a `ref:` changed |
| `palm update` | always, to read the remote's tags and branches |
| `palm check` | a locked commit is not cached |

`--offline` forbids every connection, and a command that needs one fails with `E_NETWORK`.
Hooks and MCP servers that palm installs run inside your harness, not inside palm. Their own network use is outside these rules.

## Security

Report a vulnerability privately through [GitHub security advisories](https://github.com/PalionTech/palm/security/advisories/new).
Do not open a public issue for it.
The repository's `SECURITY.md` lists what is in scope and the response times.

[The security model](/palm/explanation/security/) explains what palm trusts, asks and refuses.

## Related

- [Troubleshooting](/palm/reference/troubleshooting/)
- [palm.lock.yaml](/palm/reference/palm-lock-yaml/)
- [Environment variables](/palm/reference/environment/)
