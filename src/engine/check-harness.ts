/**
 * The harness files `check` reads for programs nobody installed through palm (Sofia S2, V2'):
 * the hook files and MCP files of the scope's active targets as their layouts name them, plus
 * every file the lock merged a hook or a server into. A hook file palm writes whole (Copilot's
 * `.github/hooks/<name>.json`) is palm's own and `lock-disk` checks it; it is left out here.
 * Nothing is written.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TargetId } from '../core/types.js';
import { claudeSpec } from '../targets/claude.js';
import { codexSpec } from '../targets/codex.js';
import { copilotSpec } from '../targets/copilot.js';
import { cursorSpec } from '../targets/cursor.js';
import { geminiSpec } from '../targets/gemini.js';
import type { TargetLayout, TargetSpec } from '../targets/layout.js';
import { opencodeSpec } from '../targets/opencode.js';
import type { CheckContext } from './check-kit.js';

const SPECS: Readonly<Record<TargetId, TargetSpec>> = {
  claude: claudeSpec,
  codex: codexSpec,
  copilot: copilotSpec,
  cursor: cursorSpec,
  gemini: geminiSpec,
  opencode: opencodeSpec,
};

/** An MCP file: servers are the keys of the object at `path` (JSON) or `[mcp_servers.<n>]` (TOML). */
export interface McpFile {
  /** Lock form. */
  file: string;
  path: string[];
}

const HOOK_AT = /^\/hooks\/[^/]+$/;
const SERVER_AT = /^\/(?:mcpServers|servers|mcp|mcp_servers)\/[^/]+$/;

function layouts(c: CheckContext): TargetLayout[] {
  const { state } = c.run;
  return state.targets.map((t) => SPECS[t].layout(state.paths));
}

/** Files every lock entry lists as its own (whole files palm writes). */
function ownedFiles(c: CheckContext): Set<string> {
  return new Set(c.run.state.lock.entries.flatMap((e) => e.files));
}

async function jsonFilesIn(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith('.json')).map((n) => join(dir, n));
}

/**
 * The hook files of the active targets and the files the lock merged hooks into (lock form,
 * sorted, existing ones only), without the ones palm writes whole.
 */
export async function hookFiles(c: CheckContext): Promise<string[]> {
  const { paths, lock } = c.run.state;
  const out = new Set<string>();
  for (const layout of layouts(c)) {
    const { hooks } = layout;
    if ('mergeFile' in hooks) out.add(paths.lockForm(hooks.mergeFile));
    if ('dir' in hooks)
      for (const abs of await jsonFilesIn(hooks.dir)) out.add(paths.lockForm(abs));
  }
  for (const e of lock.entries)
    for (const m of e.merged ?? []) if (HOOK_AT.test(m.at)) out.add(m.file);
  const owned = ownedFiles(c);
  return [...out].filter((f) => !owned.has(f) && existsSync(paths.abs(f))).sort();
}

/** `/mcpServers/docs` → `['mcpServers']`. */
function containerOf(at: string): string[] {
  return at.split('/').slice(1, -1);
}

/**
 * The MCP files of the active targets and the files the lock merged servers into, each with the
 * path to its server map (lock form, existing ones only).
 */
export function mcpFiles(c: CheckContext): McpFile[] {
  const { paths, lock } = c.run.state;
  const out = new Map<string, McpFile>();
  for (const { mcp } of layouts(c)) {
    const file = paths.lockForm('toml' in mcp ? mcp.toml : mcp.json);
    out.set(file, { file, path: 'toml' in mcp ? ['mcp_servers'] : mcp.path });
  }
  for (const e of lock.entries)
    for (const m of e.merged ?? [])
      if (SERVER_AT.test(m.at) && !out.has(m.file))
        out.set(m.file, { file: m.file, path: containerOf(m.at) });
  return [...out.values()]
    .filter((f) => existsSync(paths.abs(f.file)))
    .sort((a, b) => (a.file < b.file ? -1 : 1));
}
