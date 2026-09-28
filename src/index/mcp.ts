/**
 * MCP config parsing. Accepts:
 *  - wrapped `{ "mcpServers": { name: {...} } }` (Claude `.mcp.json`, Cursor `mcp.json`, Gemini)
 *  - VS Code `{ "servers": { name: {...} } }`
 *  - flat `{ name: {...} }` (claude-plugins-official)
 */

import type { McpServerConfig, SecretRef } from '../core/types.js';
import { isRecord, withoutUndefined } from '../lib/object.js';
import {
  findPlaceholders,
  isFillInValue,
  isRuntimeVar,
  type Placeholder,
} from '../lib/placeholders.js';
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

function toServerConfig(name: string, def: unknown): McpServerConfig | undefined {
  if (!isRecord(def)) return undefined;
  const type = (asString(def.type) ?? asString(def.transport) ?? '').toLowerCase();
  const url = asString(def.url) ?? asString(def.httpUrl) ?? asString(def.serverUrl);
  const command = asString(def.command);
  let transport: McpServerConfig['transport'];
  if (type === 'sse') transport = 'sse';
  else if (['http', 'streamable-http', 'streamablehttp', 'remote'].includes(type))
    transport = 'http';
  else if (type === 'stdio' || type === 'local') transport = 'stdio';
  else if (command) transport = 'stdio';
  else if (url) transport = /\/sse\/?$/.test(url) ? 'sse' : 'http';
  else return undefined;
  if (transport === 'stdio' && !command) return undefined;
  if (transport !== 'stdio' && !url) return undefined;

  const args = Array.isArray(def.args) ? def.args.map((a) => String(a)) : undefined;
  const env = normalizePlaceholders(stringMap(def.env));
  const headers = stringMap(def.headers);
  const cfg: McpServerConfig = withoutUndefined({
    name,
    transport,
    command: transport === 'stdio' ? command : undefined,
    args: transport === 'stdio' && args && args.length > 0 ? args : undefined,
    env,
    cwd: asString(def.cwd),
    url: transport === 'stdio' ? undefined : url,
    headers,
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

/** Adds `ref` to `out` or merges it into the entry of that name (required and header use win). */
function addSecret(out: SecretRef[], ref: SecretRef): void {
  const existing = out.find((s) => s.name === ref.name);
  if (!existing) {
    out.push(ref);
    return;
  }
  existing.required ||= ref.required;
  if (existing.in === 'env' && ref.in === 'header') {
    existing.in = 'header';
    if (ref.header) existing.header = ref.header;
    if (ref.format) existing.format = ref.format;
  }
}

/** Adds a secret for each non-runtime placeholder in `value`; `make` also gets the token count. */
function scanValue(
  value: string,
  out: SecretRef[],
  make: (p: Placeholder, tokens: number) => SecretRef,
): void {
  const found = findPlaceholders(value);
  for (const p of found) if (!isRuntimeVar(p.name)) addSecret(out, make(p, found.length));
}

function envSecret(p: Placeholder): SecretRef {
  return { name: p.name, in: 'env', required: p.default === undefined };
}

/**
 * Placeholders in env values, header values, the URL and args → SecretRefs. A placeholder with a
 * `:-default` is optional. A header value that is more than its one placeholder (`Bearer ${TOKEN}`)
 * records its template in `format` (`Bearer {value}`).
 */
function detectSecrets(cfg: McpServerConfig): SecretRef[] {
  const out: SecretRef[] = [];
  for (const value of Object.values(cfg.env ?? {})) scanValue(value, out, envSecret);
  for (const [header, value] of Object.entries(cfg.headers ?? {})) {
    scanValue(value, out, (p, tokens) => {
      const ref: SecretRef = {
        name: p.name,
        in: 'header',
        header,
        required: p.default === undefined,
      };
      if (tokens === 1 && value !== p.raw) ref.format = value.replace(p.raw, '{value}');
      return ref;
    });
  }
  if (cfg.url !== undefined) scanValue(cfg.url, out, envSecret);
  for (const arg of cfg.args ?? []) scanValue(arg, out, envSecret);
  return out;
}
