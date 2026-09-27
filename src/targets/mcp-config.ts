/**
 * Render a canonical McpServerConfig into one harness's config entry.
 *
 * Placeholders: `${VAR}` / `${env:VAR}` tokens in command, args, url, env values and
 * header values are rewritten to the harness syntax under `env-ref` (claude and
 * Copilot CLI `${VAR}`, cursor and VS Code `${env:VAR}`). Under `literal` they are
 * replaced by `values[VAR]`; when no value is known the env reference is kept and a
 * note is emitted. Declared `secrets` without a placeholder get one added.
 *
 * - claude:  `{ type: stdio|http|sse, command, args, env, url, headers }`
 * - cursor:  `{ command, args, env, url, headers }`
 * - copilot: project (`.vscode/mcp.json` servers) `{ type: stdio|http|sse, ... }`;
 *            global (`~/.copilot/mcp-config.json`) `{ type: local|http|sse, ..., tools: ["*"] }`
 * - codex:   TOML table: stdio `command,args,cwd,env,env_vars`; http `url,
 *            bearer_token_env_var, http_headers, env_http_headers`. SSE unsupported.
 */
import type { McpServerConfig, Scope, SecretPolicy, TargetId } from '../core/types.js';
import { PalmError } from '../core/errors.js';

export interface RenderedMcp {
  /** Harness object / TOML table; undefined when the harness cannot express this server. */
  entry: Record<string, unknown> | undefined;
  notes: string[];
  /** Environment variables the user has to provide (env-ref placements, unresolved literals). */
  envRefs: string[];
}

const TOKEN = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g;
const EXACT_TOKEN = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BEARER_TOKEN = /^Bearer\s+\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/i;

export const OAUTH_NOTE = 'HTTP MCP servers authenticate via OAuth on first connect';

function tokensOf(s: string): string[] {
  return [...s.matchAll(TOKEN)].map((m) => m[1]!);
}

/** `${env:X}` → `${X}` (for human-readable notes). */
function plainRefs(s: string): string {
  return s.replace(TOKEN, (_m, v: string) => `\${${v}}`);
}

class RenderState {
  readonly notes = new Set<string>();
  readonly envRefs = new Set<string>();
  constructor(
    readonly policy: SecretPolicy,
    readonly values: Record<string, string>,
  ) {}

  hasValue(v: string): boolean {
    return this.policy === 'literal' && this.values[v] !== undefined;
  }

  missing(v: string): void {
    if (this.policy === 'literal') this.notes.add(`no value for ${v}; left as an environment reference`);
    this.envRefs.add(v);
  }
}

/** env/header maps with placeholders added for declared secrets that have none. */
function withSecretPlaceholders(cfg: McpServerConfig): { env: Record<string, string>; headers: Record<string, string> } {
  const env = { ...(cfg.env ?? {}) };
  const headers = { ...(cfg.headers ?? {}) };
  for (const s of cfg.secrets ?? []) {
    if (s.in === 'env' && env[s.name] === undefined) env[s.name] = `\${${s.name}}`;
    if (s.in === 'header' && s.header && headers[s.header] === undefined) {
      headers[s.header] = s.format ? s.format.replace('{value}', `\${${s.name}}`) : `\${${s.name}}`;
    }
  }
  return { env, headers };
}

function prune(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function requireField(cfg: McpServerConfig, field: 'command' | 'url'): string {
  const v = cfg[field];
  if (!v) throw new PalmError('E_PARSE', `MCP server "${cfg.name}": ${cfg.transport} transport needs a ${field}`);
  return v;
}

function renderJsonEntry(cfg: McpServerConfig, target: Exclude<TargetId, 'codex'>, scope: Scope, st: RenderState): Record<string, unknown> {
  const style: 'plain' | 'env-colon' = target === 'claude' || (target === 'copilot' && scope === 'global') ? 'plain' : 'env-colon';
  const rewrite = (s: string): string =>
    s.replace(TOKEN, (_m, v: string) => {
      if (st.hasValue(v)) return st.values[v]!;
      st.missing(v);
      return style === 'plain' ? `\${${v}}` : `\${env:${v}}`;
    });
  const mapValues = (r: Record<string, string>): Record<string, string> | undefined =>
    Object.keys(r).length ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, rewrite(v)])) : undefined;
  const { env, headers } = withSecretPlaceholders(cfg);
  if (cfg.cwd) st.notes.add(`cwd (${cfg.cwd}) is not supported in ${target} MCP config; dropped`);
  const copilotCli = target === 'copilot' && scope === 'global';

  if (cfg.transport === 'stdio') {
    const base = {
      command: rewrite(requireField(cfg, 'command')),
      args: cfg.args?.length ? cfg.args.map(rewrite) : undefined,
      env: mapValues(env),
    };
    if (target === 'cursor') return prune(base);
    if (copilotCli) return prune({ type: 'local', ...base, tools: ['*'] });
    return prune({ type: 'stdio', ...base });
  }

  const base = { url: rewrite(requireField(cfg, 'url')), headers: mapValues(headers) };
  if (!base.headers) st.notes.add(OAUTH_NOTE);
  if (target === 'cursor') return prune(base);
  if (copilotCli) return prune({ type: cfg.transport, ...base, tools: ['*'] });
  return prune({ type: cfg.transport, ...base });
}

function renderCodexTable(cfg: McpServerConfig, st: RenderState): Record<string, unknown> | undefined {
  if (cfg.transport === 'sse') {
    st.notes.add(`Codex does not support SSE MCP servers; "${cfg.name}" skipped for codex`);
    return undefined;
  }
  // Codex expands nothing in command/args/url: substitute known values, else keep the token.
  const literalOnly = (s: string, field: string): string =>
    s.replace(TOKEN, (m, v: string) => {
      if (st.hasValue(v)) return st.values[v]!;
      st.notes.add(`Codex does not expand ${plainRefs(m)} in ${field}; left as is`);
      return m;
    });
  const substituteAll = (s: string): string => s.replace(TOKEN, (_m, v: string) => st.values[v]!);
  const { env, headers } = withSecretPlaceholders(cfg);

  if (cfg.transport === 'stdio') {
    const literalEnv: Record<string, string> = {};
    const envVars: string[] = [];
    for (const [k, raw] of Object.entries(env)) {
      const toks = tokensOf(raw);
      if (toks.length === 0) {
        literalEnv[k] = raw;
        continue;
      }
      if (toks.every((t) => st.hasValue(t))) {
        literalEnv[k] = substituteAll(raw);
        continue;
      }
      for (const t of toks) if (!st.hasValue(t) && st.policy === 'literal') st.notes.add(`no value for ${t}; left as an environment reference`);
      envVars.push(k);
      st.envRefs.add(k);
      const exact = EXACT_TOKEN.exec(raw.trim());
      if (!exact || exact[1] !== k) st.notes.add(`Codex forwards ${k} from your environment: export ${k}="${plainRefs(raw)}"`);
    }
    return prune({
      command: literalOnly(requireField(cfg, 'command'), 'command'),
      args: cfg.args?.length ? cfg.args.map((a) => literalOnly(a, 'args')) : undefined,
      cwd: cfg.cwd,
      env_vars: envVars.length ? envVars : undefined,
      env: Object.keys(literalEnv).length ? literalEnv : undefined,
    });
  }

  const httpHeaders: Record<string, string> = {};
  const envHeaders: Record<string, string> = {};
  let bearer: string | undefined;
  for (const [h, raw] of Object.entries(headers)) {
    const toks = tokensOf(raw);
    if (toks.length === 0) {
      httpHeaders[h] = raw;
      continue;
    }
    if (toks.every((t) => st.hasValue(t))) {
      httpHeaders[h] = substituteAll(raw);
      continue;
    }
    for (const t of toks) if (!st.hasValue(t) && st.policy === 'literal') st.notes.add(`no value for ${t}; left as an environment reference`);
    const bearerMatch = BEARER_TOKEN.exec(raw.trim());
    if (/^authorization$/i.test(h) && bearerMatch && bearer === undefined) {
      bearer = bearerMatch[1]!;
      st.envRefs.add(bearer);
      continue;
    }
    const exact = EXACT_TOKEN.exec(raw.trim());
    const v = exact ? exact[1]! : toks[0]!;
    envHeaders[h] = v;
    st.envRefs.add(v);
    if (!exact) st.notes.add(`Codex reads the complete "${h}" header value from ${v}; set ${v} to "${plainRefs(raw)}" with the value filled in`);
  }
  if (Object.keys(headers).length === 0) st.notes.add(OAUTH_NOTE);
  return prune({
    url: literalOnly(requireField(cfg, 'url'), 'url'),
    bearer_token_env_var: bearer,
    http_headers: Object.keys(httpHeaders).length ? httpHeaders : undefined,
    env_http_headers: Object.keys(envHeaders).length ? envHeaders : undefined,
  });
}

/** Full render with notes and the env vars to export. `scope` only matters for copilot. */
export function renderMcp(
  cfg: McpServerConfig,
  target: TargetId,
  policy: SecretPolicy,
  values: Record<string, string> = {},
  scope: Scope = 'project',
): RenderedMcp {
  const st = new RenderState(policy, values);
  const entry = target === 'codex' ? renderCodexTable(cfg, st) : renderJsonEntry(cfg, target, scope, st);
  return { entry, notes: [...st.notes], envRefs: [...st.envRefs] };
}

/**
 * Harness-specific object (JSON targets) or TOML table (codex); undefined when the
 * harness cannot express the server (codex + sse). `opts.scope` selects the Copilot
 * format (project: VS Code `.vscode/mcp.json`; global: Copilot CLI). Default project.
 */
export function renderMcpEntry(
  cfg: McpServerConfig,
  target: TargetId,
  policy: SecretPolicy,
  values?: Record<string, string>,
  opts?: { scope?: Scope },
): unknown {
  return renderMcp(cfg, target, policy, values, opts?.scope).entry;
}
