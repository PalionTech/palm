---
name: agent-sdk-verifier-py
description: Use this agent to verify a Python Agent SDK app. Examples: <example>Context: user created an app</example>
model: sonnet
tools: Read, Grep, Glob, Bash(python -m pytest:*)
color: green
skills: sdk-helper
mcpServers:
  - context7
---

You are a Python Agent SDK application verifier.
