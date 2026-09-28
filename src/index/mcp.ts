/**
 * MCP config parsing. Accepts:
 *  - wrapped `{ "mcpServers": { name: {...} } }` (Claude `.mcp.json`, Cursor `mcp.json`, Gemini)
 *  - VS Code `{ "servers": { name: {...} } }`
 *  - flat `{ name: {...} }` (claude-plugins-official)
 */

import type { McpServerConfig } from '../core/types.js';
import { detectSecrets } from '../domain/secrets.js';
import { isRecord, withoutUndefined } from '../lib/object.js';
import { isFillInValue } from '../lib/placeholders.js';
import { asString } from './util.js';

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
  if (entries.length > 0 && entries.every(([, v]) => looksLikeServer(v)))
    return Object.fromEntries(entries);
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

const HTTP_TYPES = ['http', 'streamable-http', 'streamablehttp', 'remote'];

/** The transport a server definition declares or implies; undefined when it has neither. */
function transportOf(
  type: string,
  command: string | undefined,
  url: string | undefined,
): McpServerConfig['transport'] | undefined {
  if (type === 'sse') return 'sse';
  if (HTTP_TYPES.includes(type)) return 'http';
  if (type === 'stdio' || type === 'local' || command) return 'stdio';
  if (url) return /\/sse\/?$/.test(url) ? 'sse' : 'http';
  return undefined;
}

function toServerConfig(name: string, def: unknown): McpServerConfig | undefined {
  if (!isRecord(def)) return undefined;
  const type = (asString(def.type) ?? asString(def.transport) ?? '').toLowerCase();
  const url = asString(def.url) ?? asString(def.httpUrl) ?? asString(def.serverUrl);
  const command = asString(def.command);
  const transport = transportOf(type, command, url);
  if (!transport || (transport === 'stdio' ? !command : !url)) return undefined;

  const stdio = transport === 'stdio';
  const args = Array.isArray(def.args) ? def.args.map((a) => String(a)) : [];
  const cfg: McpServerConfig = withoutUndefined({
    name,
    transport,
    command: stdio ? command : undefined,
    args: stdio && args.length > 0 ? args : undefined,
    env: normalizePlaceholders(stringMap(def.env)),
    cwd: asString(def.cwd),
    url: stdio ? undefined : url,
    headers: stringMap(def.headers),
    source: { type: 'origin' as const },
  });
  const secrets = detectSecrets(cfg);
  return secrets.length > 0 ? { ...cfg, secrets } : cfg;
}

/** `API_KEY: ""` / `"<your key>"` / `"your-token"` → `API_KEY: "${API_KEY}"`, so the value becomes a secret the user supplies. */
function normalizePlaceholders(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env) return env;
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, isFillInValue(v) ? `\${${k}}` : v]),
  );
}
