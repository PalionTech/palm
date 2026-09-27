/**
 * Ad hoc MCP definitions from the command line (DESIGN.md §7):
 *   palm install mcp <name> -- <command> [args...] [--env K=V]
 *   palm install mcp <name> --url <url> [--header K=V] [--transport sse]
 */
import { PalmError } from '../core/errors.js';
import type { McpServerConfig } from '../core/types.js';

const NAME = /^[A-Za-z0-9._-]+$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const USAGE_HINT = [
  'Use one of:',
  '  palm install mcp <name> -- <command> [args...] [--env KEY=VALUE]',
  '  palm install mcp <name> --url <url> [--header Name=Value] [--transport sse]',
].join('\n');

function parsePairs(items: string[] | undefined, flag: '--env' | '--header'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of items ?? []) {
    let key: string;
    let value: string;
    const eq = raw.indexOf('=');
    const colon = raw.indexOf(':');
    if (flag === '--header' && colon > 0 && (eq < 0 || colon < eq)) {
      // Also accept the curl-style `Name: value`.
      key = raw.slice(0, colon).trim();
      value = raw.slice(colon + 1).trim();
    } else if (eq > 0) {
      key = raw.slice(0, eq).trim();
      value = raw.slice(eq + 1);
    } else {
      throw new PalmError('E_USAGE', `Invalid ${flag} "${raw}": expected KEY=VALUE`, `Example: ${flag} ${flag === '--env' ? 'API_KEY=${API_KEY}' : "'Authorization=Bearer ${TOKEN}'"}`);
    }
    const valid = flag === '--env' ? ENV_KEY : HEADER_NAME;
    if (!valid.test(key)) {
      throw new PalmError('E_USAGE', `Invalid ${flag} name "${key}"`, flag === '--env' ? 'Environment variable names use letters, digits and "_", and do not start with a digit.' : 'Header names use letters, digits and "-".');
    }
    out[key] = value;
  }
  return out;
}

function normalizeTransport(t: string | undefined): McpServerConfig['transport'] | undefined {
  if (t === undefined || t === '') return undefined;
  const v = t.trim().toLowerCase();
  if (v === 'stdio') return 'stdio';
  if (v === 'http' || v === 'streamable-http' || v === 'streamable_http' || v === 'streamablehttp') return 'http';
  if (v === 'sse') return 'sse';
  throw new PalmError('E_USAGE', `Unknown MCP transport "${t}"`, 'Use one of: stdio, http, sse');
}

/**
 * Build a canonical config from CLI input. `command` is the argv after `--` (first element is the
 * executable). `${VAR}` placeholders in values are kept verbatim; `detectSecrets` finds them later.
 */
export function parseAdhocMcp(
  name: string,
  opts: { command?: string[]; url?: string; headers?: string[]; env?: string[]; transport?: string },
): McpServerConfig {
  if (!name || !NAME.test(name)) {
    throw new PalmError('E_USAGE', `Invalid MCP server name "${name}"`, 'Use letters, digits, ".", "_" or "-" (e.g. "github" or "my-docs").');
  }
  const command = opts.command ?? [];
  const url = opts.url?.trim() ?? '';
  const transport = normalizeTransport(opts.transport);

  if (command.length && url) {
    throw new PalmError('E_USAGE', `MCP server "${name}" cannot have both a command and --url`, USAGE_HINT);
  }
  if (!command.length && !url) {
    throw new PalmError('E_USAGE', `MCP server "${name}" needs a command or --url`, USAGE_HINT);
  }

  if (command.length) {
    const [exe, ...args] = command;
    if (!exe || !exe.trim()) throw new PalmError('E_USAGE', `MCP server "${name}": empty command after --`, USAGE_HINT);
    if (transport && transport !== 'stdio') {
      throw new PalmError('E_USAGE', `--transport ${opts.transport} requires --url; command servers use stdio`, USAGE_HINT);
    }
    if (opts.headers?.length) {
      throw new PalmError('E_USAGE', '--header only applies to --url servers', 'Pass credentials to command servers with --env KEY=VALUE.');
    }
    const cfg: McpServerConfig = { name, transport: 'stdio', command: exe };
    if (args.length) cfg.args = args;
    const env = parsePairs(opts.env, '--env');
    if (Object.keys(env).length) cfg.env = env;
    cfg.source = { type: 'adhoc' };
    return cfg;
  }

  if (!/^https?:\/\/\S+$/i.test(url)) {
    throw new PalmError('E_USAGE', `Invalid --url "${url}": expected an http(s) URL`, USAGE_HINT);
  }
  if (transport === 'stdio') {
    throw new PalmError('E_USAGE', '--transport stdio requires a command after --, not --url', USAGE_HINT);
  }
  if (opts.env?.length) {
    throw new PalmError('E_USAGE', '--env only applies to command servers', 'Pass credentials to URL servers with --header Name=Value.');
  }
  const cfg: McpServerConfig = { name, transport: transport ?? 'http', url };
  const headers = parsePairs(opts.headers, '--header');
  if (Object.keys(headers).length) cfg.headers = headers;
  cfg.source = { type: 'adhoc' };
  return cfg;
}
