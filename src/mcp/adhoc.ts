/**
 * Ad hoc MCP definitions from the command line (DESIGN.md §7):
 *   palm install mcp <name> -- <command> [args...] [--env K=V]
 *   palm install mcp <name> --url <url> [--header K=V] [--transport sse]
 */
import { PalmError } from '../core/errors.js';
import type { McpServerConfig } from '../core/types.js';
import { isSafeName } from '../lib/names.js';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const USAGE_HINT = [
  'Use one of:',
  '  palm install mcp <name> -- <command> [args...] [--env KEY=VALUE]',
  '  palm install mcp <name> --url <url> [--header Name=Value] [--transport sse]',
].join('\n');

/** `KEY=VALUE` (and for headers also curl's `Name: value`) split into key and value. */
function splitPair(raw: string, flag: '--env' | '--header'): [string, string] {
  const eq = raw.indexOf('=');
  const colon = raw.indexOf(':');
  if (flag === '--header' && colon > 0 && (eq < 0 || colon < eq))
    return [raw.slice(0, colon).trim(), raw.slice(colon + 1).trim()];
  if (eq > 0) return [raw.slice(0, eq).trim(), raw.slice(eq + 1)];
  const example = flag === '--env' ? `API_KEY=\${API_KEY}` : `'Authorization=Bearer \${TOKEN}'`;
  throw new PalmError(
    'E_USAGE',
    `Invalid ${flag} "${raw}": expected KEY=VALUE`,
    `Example: ${flag} ${example}`,
  );
}

function parsePairs(
  items: string[] | undefined,
  flag: '--env' | '--header',
): Record<string, string> {
  const out: Record<string, string> = {};
  const valid = flag === '--env' ? ENV_KEY : HEADER_NAME;
  for (const raw of items ?? []) {
    const [key, value] = splitPair(raw, flag);
    if (!valid.test(key)) {
      throw new PalmError(
        'E_USAGE',
        `Invalid ${flag} name "${key}"`,
        flag === '--env'
          ? 'Environment variable names use letters, digits and "_", and do not start with a digit.'
          : 'Header names use letters, digits and "-".',
      );
    }
    out[key] = value;
  }
  return out;
}

function normalizeTransport(t: string | undefined): McpServerConfig['transport'] | undefined {
  if (t === undefined || t === '') return undefined;
  const v = t.trim().toLowerCase();
  if (v === 'stdio') return 'stdio';
  if (v === 'http' || v === 'streamable-http' || v === 'streamable_http' || v === 'streamablehttp')
    return 'http';
  if (v === 'sse') return 'sse';
  throw new PalmError('E_USAGE', `Unknown MCP transport "${t}"`, 'Use one of: stdio, http, sse');
}

interface AdhocMcpInput {
  /** The argv after `--` (first element is the executable). */
  command?: string[];
  url?: string;
  headers?: string[];
  env?: string[];
  transport?: string;
}

function usageError(message: string, hint = USAGE_HINT): PalmError {
  return new PalmError('E_USAGE', message, hint);
}

function assertName(name: string): void {
  if (isSafeName(name)) return;
  throw usageError(
    `Invalid MCP server name "${name}"`,
    'Start with a letter or digit, then use letters, digits, ".", "_" or "-" without ".." (e.g. "github" or "my-docs").',
  );
}

/** `palm install mcp <name> -- <command> [args...] [--env K=V]`. */
function commandServer(name: string, opts: AdhocMcpInput): McpServerConfig {
  const [exe, ...args] = opts.command ?? [];
  if (!exe?.trim()) throw usageError(`MCP server "${name}": empty command after --`);
  const transport = normalizeTransport(opts.transport);
  if (transport && transport !== 'stdio')
    throw usageError(`--transport ${opts.transport} requires --url; command servers use stdio`);
  if (opts.headers?.length)
    throw usageError(
      '--header only applies to --url servers',
      'Pass credentials to command servers with --env KEY=VALUE.',
    );
  const cfg: McpServerConfig = { name, transport: 'stdio', command: exe };
  if (args.length) cfg.args = args;
  const env = parsePairs(opts.env, '--env');
  if (Object.keys(env).length) cfg.env = env;
  cfg.source = { type: 'adhoc' };
  return cfg;
}

/** `palm install mcp <name> --url <url> [--header K=V] [--transport sse]`. */
function urlServer(name: string, url: string, opts: AdhocMcpInput): McpServerConfig {
  if (!/^https?:\/\/\S+$/i.test(url))
    throw usageError(`Invalid --url "${url}": expected an http(s) URL`);
  const transport = normalizeTransport(opts.transport);
  if (transport === 'stdio')
    throw usageError('--transport stdio requires a command after --, not --url');
  if (opts.env?.length)
    throw usageError(
      '--env only applies to command servers',
      'Pass credentials to URL servers with --header Name=Value.',
    );
  const cfg: McpServerConfig = { name, transport: transport ?? 'http', url };
  const headers = parsePairs(opts.headers, '--header');
  if (Object.keys(headers).length) cfg.headers = headers;
  cfg.source = { type: 'adhoc' };
  return cfg;
}

/**
 * Build a canonical config from CLI input. `${VAR}` placeholders in values are kept verbatim;
 * `detectSecrets` finds them later.
 */
export function parseAdhocMcp(name: string, opts: AdhocMcpInput): McpServerConfig {
  assertName(name);
  const hasCommand = !!opts.command?.length;
  const url = opts.url?.trim() ?? '';
  if (hasCommand && url)
    throw usageError(`MCP server "${name}" cannot have both a command and --url`);
  if (hasCommand) return commandServer(name, opts);
  if (url) return urlServer(name, url, opts);
  throw usageError(`MCP server "${name}" needs a command or --url`);
}
