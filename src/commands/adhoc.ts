/**
 * An MCP server declared by flags (DESIGN.md §9, way 3):
 *   palm install mcp docs --url https://example.com/mcp --header 'Authorization=Bearer ${DOCS_TOKEN}'
 *   palm install mcp xcodebuild --command npx --arg -y --arg xcodebuildmcp@latest --env KEY=${KEY}
 * `${VAR}` in values stays a reference; the engine decides what is a secret.
 */
import { PalmError } from '../core/errors.js';
import type { McpServerConfig } from '../core/types.js';
import { isSafeName } from '../lib/names.js';

export interface AdhocMcpOptions {
  command?: string;
  args?: string[];
  url?: string;
  headers?: string[];
  env?: string[];
  transport?: string;
  cwd?: string;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const EXAMPLES = [
  'palm install mcp docs --url https://example.com/mcp',
  'palm install mcp fs --command npx --arg -y --arg @modelcontextprotocol/server-filesystem',
].join('\n');

function usageError(message: string, hint = EXAMPLES): PalmError {
  return new PalmError('E_USAGE', message, hint);
}

/** `KEY=VALUE` (for headers also curl's `Name: value`) split into key and value. */
function splitPair(raw: string, flag: '--env' | '--header'): [string, string] {
  const eq = raw.indexOf('=');
  const colon = raw.indexOf(':');
  if (flag === '--header' && colon > 0 && (eq < 0 || colon < eq))
    return [raw.slice(0, colon).trim(), raw.slice(colon + 1).trim()];
  if (eq > 0) return [raw.slice(0, eq).trim(), raw.slice(eq + 1)];
  const example = flag === '--env' ? `API_KEY=\${API_KEY}` : `'Authorization=Bearer \${TOKEN}'`;
  throw usageError(`${flag} "${raw}" is not KEY=VALUE`, `${flag} ${example}`);
}

function parsePairs(
  items: string[] | undefined,
  flag: '--env' | '--header',
): Record<string, string> {
  const pairs: Record<string, string> = {};
  const valid = flag === '--env' ? ENV_KEY : HEADER_NAME;
  for (const raw of items ?? []) {
    const [key, value] = splitPair(raw, flag);
    if (!valid.test(key))
      throw usageError(
        `${flag} name "${key}" is not valid`,
        flag === '--env' ? `--env API_KEY=\${API_KEY}` : `--header 'X-Api-Key=\${API_KEY}'`,
      );
    pairs[key] = value;
  }
  return pairs;
}

function transportOf(t: string | undefined): McpServerConfig['transport'] | undefined {
  const v = t?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'stdio' || v === 'sse') return v;
  if (['http', 'streamable-http', 'streamable_http', 'streamablehttp'].includes(v)) return 'http';
  throw usageError(`--transport ${t} is not stdio, http or sse`, '--transport http');
}

function commandServer(name: string, opts: AdhocMcpOptions): McpServerConfig {
  const transport = transportOf(opts.transport);
  if (transport && transport !== 'stdio')
    throw usageError(`--transport ${opts.transport} needs --url; a --command server uses stdio`);
  if (opts.headers?.length)
    throw usageError(
      '--header belongs to --url servers',
      `palm install mcp ${name} --env KEY=\${KEY}`,
    );
  const cfg: McpServerConfig = { name, transport: 'stdio', command: opts.command?.trim() };
  if (opts.args?.length) cfg.args = [...opts.args];
  const env = parsePairs(opts.env, '--env');
  if (Object.keys(env).length) cfg.env = env;
  if (opts.cwd) cfg.cwd = opts.cwd;
  return { ...cfg, origin: { type: 'flags' } };
}

function urlServer(name: string, url: string, opts: AdhocMcpOptions): McpServerConfig {
  if (!/^https?:\/\/\S+$/i.test(url)) throw usageError(`--url ${url} is not an http(s) URL`);
  const transport = transportOf(opts.transport);
  if (transport === 'stdio') throw usageError('--transport stdio needs --command, not --url');
  if (opts.env?.length || opts.args?.length || opts.cwd)
    throw usageError(
      '--env, --arg and --cwd belong to --command servers',
      `palm install mcp ${name} --url ${url} --header 'Authorization=Bearer \${TOKEN}'`,
    );
  const cfg: McpServerConfig = { name, transport: transport ?? 'http', url };
  const headers = parsePairs(opts.headers, '--header');
  if (Object.keys(headers).length) cfg.headers = headers;
  return { ...cfg, origin: { type: 'flags' } };
}

/** The canonical server from `install mcp <name>` flags; E_USAGE for anything malformed. */
export function parseAdhocMcp(name: string, opts: AdhocMcpOptions): McpServerConfig {
  if (!isSafeName(name))
    throw usageError(
      `"${name}" is not a server name: use letters, digits, ".", "_" or "-"`,
      'palm install mcp docs --url https://example.com/mcp',
    );
  const url = opts.url?.trim() ?? '';
  const command = opts.command?.trim() ?? '';
  if (command && url) throw usageError(`give ${name} either --command or --url, not both`);
  if (command) return commandServer(name, opts);
  if (url) return urlServer(name, url, opts);
  throw usageError(`${name} needs --url (a remote server) or --command (a local one)`);
}
