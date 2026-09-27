/**
 * MCP config parsing. Accepts:
 *  - wrapped `{ "mcpServers": { name: {...} } }` (Claude `.mcp.json`, Cursor `mcp.json`, Gemini)
 *  - VS Code `{ "servers": { name: {...} } }`
 *  - flat `{ name: {...} }` (claude-plugins-official)
 */

import type { McpServerConfig, SecretRef } from '../core/types.js';
import { asString, compact, isRecord } from './util.js';

const SERVER_HINT_KEYS = ['command', 'url', 'type', 'httpUrl', 'serverUrl', 'transport'];

function looksLikeServer(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && SERVER_HINT_KEYS.some((k) => k in v);
}

/** The name → server map inside an MCP config, or undefined when the JSON is not one. */
export function mcpServerMap(json: unknown): Record<string, unknown> | undefined {
  if (!isRecord(json)) return undefined;
  if (isRecord(json.mcpServers)) return json.mcpServers;
  if (isRecord(json.servers)) return json.servers;
  if (isRecord(json.mcp_servers)) return json.mcp_servers;
  const entries = Object.entries(json).filter(([k]) => !k.startsWith('$'));
  if (entries.length > 0 && entries.every(([, v]) => looksLikeServer(v))) return Object.fromEntries(entries);
  return undefined;
}

export function parseMcpJson(json: unknown): McpServerConfig[] {
  const map = mcpServerMap(json);
  if (!map) return [];
  const out: McpServerConfig[] = [];
  for (const [name, def] of Object.entries(map)) {
    const cfg = toServerConfig(name, def);
    if (cfg) out.push(cfg);
  }
  return out;
}

function stringMap(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    const s = typeof x === 'string' ? x : asString(x);
    if (s !== undefined) out[k] = s;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toServerConfig(name: string, def: unknown): McpServerConfig | undefined {
  if (!isRecord(def)) return undefined;
  const type = (asString(def.type) ?? asString(def.transport) ?? '').toLowerCase();
  const url = asString(def.url) ?? asString(def.httpUrl) ?? asString(def.serverUrl);
  const command = asString(def.command);
  let transport: McpServerConfig['transport'];
  if (type === 'sse') transport = 'sse';
  else if (['http', 'streamable-http', 'streamablehttp', 'remote'].includes(type)) transport = 'http';
  else if (type === 'stdio' || type === 'local') transport = 'stdio';
  else if (command) transport = 'stdio';
  else if (url) transport = /\/sse\/?$/.test(url) ? 'sse' : 'http';
  else return undefined;
  if (transport === 'stdio' && !command) return undefined;
  if (transport !== 'stdio' && !url) return undefined;

  const args = Array.isArray(def.args) ? def.args.map((a) => String(a)) : undefined;
  const env = stringMap(def.env);
  const headers = stringMap(def.headers);
  const secrets = findSecrets(env, headers);
  return compact({
    name,
    transport,
    command: transport === 'stdio' ? command : undefined,
    args: transport === 'stdio' && args && args.length > 0 ? args : undefined,
    env,
    cwd: asString(def.cwd),
    url: transport === 'stdio' ? undefined : url,
    headers,
    secrets: secrets.length > 0 ? secrets : undefined,
    source: { type: 'origin' as const },
  });
}

/** Variables that are provided by the harness, never by the user. */
const NON_SECRET_VARS = new Set([
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PROJECT_DIR',
  'CURSOR_PLUGIN_ROOT',
  'PLUGIN_ROOT',
  'workspaceFolder',
  'workspaceRoot',
  'userHome',
  'HOME',
  'PWD',
  'PATH',
  'USER',
]);

const VAR_RE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;

/** `${VAR}`, `${VAR:-default}` and `${env:VAR}` placeholders in env values and headers. */
export function findSecrets(env?: Record<string, string>, headers?: Record<string, string>): SecretRef[] {
  const out: SecretRef[] = [];
  const seen = new Set<string>();
  const add = (ref: SecretRef) => {
    if (seen.has(ref.name)) return;
    seen.add(ref.name);
    out.push(ref);
  };
  for (const [key, value] of Object.entries(env ?? {})) {
    let matched = false;
    for (const m of value.matchAll(VAR_RE)) {
      const v = m[1];
      if (v === undefined || NON_SECRET_VARS.has(v)) continue;
      matched = true;
      add({ name: v, in: 'env', required: m[2] === undefined });
    }
    if (!matched && (value === '' || /^<.*>$/.test(value) || /^your[-_ ]/i.test(value))) {
      add({ name: key, in: 'env', required: true });
    }
  }
  for (const [header, value] of Object.entries(headers ?? {})) {
    const matches = [...value.matchAll(VAR_RE)].filter((m) => m[1] !== undefined && !NON_SECRET_VARS.has(m[1]));
    for (const m of matches) {
      const name = m[1] as string;
      const format = matches.length === 1 ? value.replace(m[0], '{value}') : undefined;
      add(compact({ name, in: 'header' as const, header, required: m[2] === undefined, format: format === '{value}' ? undefined : format }));
    }
  }
  return out;
}
