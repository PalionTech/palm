/**
 * Sources the engine meets besides the declared ones: a lock source whose palm.yaml entry is
 * gone (rebuilt from the lock), and the pseudo source `manifest` that holds the MCP servers
 * declared by hand under `mcp:` (DESIGN §9: lock entries with `source: manifest`).
 */
import type {
  Entity,
  LockSource,
  McpManifestEntry,
  McpServerConfig,
  Source,
  SourceCheckout,
} from '../core/types.js';
import { SourceRef } from '../domain/source.js';
import { lockedSource, type ScopeState } from './scope.js';

/** The source name of hand-declared MCP servers in the lock. */
export const MANIFEST_SOURCE = 'manifest';

/** A Source rebuilt from the lock alone (DESIGN §4: url, root, sha, layout suffice). */
export function sourceFromLock(state: ScopeState, name: string, ls: LockSource): Source {
  const src: Source = { name, type: ls.url ? 'git' : 'local' };
  if (ls.url) src.url = ls.url;
  if (ls.root) src.root = ls.root;
  if (ls.ref) src.ref = ls.ref;
  if (ls.path !== undefined) src.path = state.paths.abs(ls.path);
  if (ls.layout) src.layout = ls.layout;
  return src;
}

/** The declared source `name`, else the lock's record of it (as opened), else undefined. */
export function sourceRefOf(state: ScopeState, name: string): SourceRef | undefined {
  const declared = state.sources.byName(name);
  if (declared) return declared;
  const ls = lockedSource(state, name) ?? state.lock.source(name);
  return ls ? SourceRef.of(sourceFromLock(state, name, ls)) : undefined;
}

/** The pseudo source of hand-declared servers: rendered in place from palm.yaml. */
export function manifestSource(state: ScopeState): { ref: SourceRef; checkout: SourceCheckout } {
  const root = state.paths.root;
  const source: Source = { name: MANIFEST_SOURCE, type: 'local', path: root };
  return {
    ref: SourceRef.of(source),
    checkout: { source, sourceId: MANIFEST_SOURCE, root, repoDir: root },
  };
}

/** A palm.yaml `mcp:` entry as a canonical server config. */
export function mcpConfigOf(name: string, e: McpManifestEntry): McpServerConfig {
  const cfg: McpServerConfig = {
    name,
    transport: e.transport ?? (e.url ? 'http' : 'stdio'),
    origin: { type: 'manifest' },
  };
  if (e.command) cfg.command = e.command;
  if (e.args) cfg.args = [...e.args];
  if (e.env) cfg.env = { ...e.env };
  if (e.cwd) cfg.cwd = e.cwd;
  if (e.url) cfg.url = e.url;
  if (e.headers) cfg.headers = { ...e.headers };
  return cfg;
}

/** The palm.yaml form of a server config (targets narrow it per entry). */
export function mcpManifestEntry(cfg: McpServerConfig): McpManifestEntry {
  const e: McpManifestEntry = {};
  if (cfg.transport !== (cfg.url ? 'http' : 'stdio')) e.transport = cfg.transport;
  if (cfg.command) e.command = cfg.command;
  if (cfg.args?.length) e.args = [...cfg.args];
  if (cfg.env && Object.keys(cfg.env).length) e.env = { ...cfg.env };
  if (cfg.cwd) e.cwd = cfg.cwd;
  if (cfg.url) e.url = cfg.url;
  if (cfg.headers && Object.keys(cfg.headers).length) e.headers = { ...cfg.headers };
  return e;
}

/** The entity of a hand-declared server. */
export function mcpEntity(cfg: McpServerConfig): Entity {
  return {
    kind: 'mcp',
    name: cfg.name,
    path: `mcp/${cfg.name}`,
    source: MANIFEST_SOURCE,
    def: { kind: 'mcp', mcp: cfg, references: [], closure: { paths: [] } },
  };
}
