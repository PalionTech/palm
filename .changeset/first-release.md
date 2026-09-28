---
"@paliontech/palm": minor
---

First public release. palm installs skills, agents, instructions, commands, hooks, MCP servers and plugins from git repositories you choose (origins) into the native files of Claude Code, Codex, GitHub Copilot and Cursor. It records what it wrote in `palm.yaml` and `palm.lock.yaml`, so `palm install` reproduces a project on another machine and `palm uninstall` removes exactly what palm added.
