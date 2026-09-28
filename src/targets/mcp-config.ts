/**
 * Render a canonical McpServerConfig into one harness's config entry.
 *
 * Placeholders: `${VAR}` / `${env:VAR}` / `${VAR:-default}` tokens in command, args, url,
 * env values and header values.
 * - `env-ref`: rewritten to the harness syntax (claude and Copilot CLI `${VAR}`, cursor and
 *   VS Code `${env:VAR}`). Claude rejects a config whose `${VAR}` is unset and has no
 *   default, so optional secrets become `${VAR:-}` (a declared default is kept).
 * - `literal`: replaced by `values[VAR]`; else by the token's default; an optional secret
 *   without a value drops its env entry / header (args and URLs get an empty string);
 *   a required one without a value stays an env reference (with a note).
 * - Runtime variables (`RUNTIME_VARS`: `${CLAUDE_PLUGIN_ROOT}`, `${workspaceFolder}`, …) are
 *   left exactly as written.
 * Declared `secrets` that no field references get a placeholder (env entry or header).
 *
 * - claude:  `{ type: stdio|http|sse, command, args, env, url, headers }`
 * - cursor:  `{ command, args, env, url, headers }`
 * - copilot: project (`.vscode/mcp.json` servers) `{ type: stdio|http|sse, ... }`;
 *            global (`~/.copilot/mcp-config.json`) `{ type: local|http|sse, ..., tools: ["*"] }`
 * - codex:   TOML table: stdio `command,args,cwd,env,env_vars`; http `url,
 *            bearer_token_env_var, http_headers, env_http_headers`. SSE unsupported.
 *            Codex expands nothing in command/args/url: under env-ref a token there is a
 *            documented limitation (note); under literal it is substituted.
 */

import { PalmError } from '../core/errors.js';
import type { McpServerConfig, Scope, SecretPolicy, TargetId } from '../core/types.js';
// biome-ignore lint/style/noRestrictedImports: known layer violation (targets -> mcp); PLAN.md wave 1 moves the ${VAR} token grammar to src/lib.
import { isRuntimeVar, optionalSecretNames } from '../mcp/secrets.js';

export interface RenderedMcp {
  /** Harness object / TOML table; undefined when the harness cannot express this server. */
  entry: Record<string, unknown> | undefined;
  notes: string[];
  /** Environment variables the user has to provide (env-ref placements, unresolved literals). */
  envRefs: string[];
}

/** Groups: 1 = variable name, 2 = default (after `:-`), undefined when absent. */
const TOKEN = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const EXACT_TOKEN = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/;
const BEARER_TOKEN = /^Bearer\s+\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/i;

export const OAUTH_NOTE = 'HTTP MCP servers authenticate via OAuth on first connect';

function tokensOf(s: string): string[] {
  return [...s.matchAll(TOKEN)].map((m) => m[1]!).filter((v) => !isRuntimeVar(v));
}

/** `${env:X}` → `${X}` (for human-readable notes). */
function plainRefs(s: string): string {
  return s.replace(TOKEN, (m, v: string) => (isRuntimeVar(v) ? m : `\${${v}}`));
}

/** Marker for a value that must be left out (optional secret without a value under `literal`). */
const DROP = Symbol('drop');

class RenderState {
  readonly notes = new Set<string>();
  readonly envRefs = new Set<string>();
  constructor(
    readonly policy: SecretPolicy,
    readonly values: Record<string, string>,
    readonly optional: Set<string>,
  ) {}

  hasValue(v: string): boolean {
    return this.policy === 'literal' && this.values[v] !== undefined;
  }

  missing(v: string): void {
    if (this.policy === 'literal')
      this.notes.add(`no value for ${v}; left as an environment reference`);
    this.envRefs.add(v);
  }

  /** Under `literal`: the value to write for an unresolved token, DROP, or undefined (keep a reference). */
  literalFallback(
    v: string,
    def: string | undefined,
    where: string,
    canDrop: boolean,
  ): string | typeof DROP | undefined {
    if (this.policy !== 'literal') return undefined;
    if (def !== undefined) return def;
    if (!this.optional.has(v)) return undefined;
    this.notes.add(
      canDrop
        ? `optional ${v} not set; ${where} left out`
        : `optional ${v} not set; empty in ${where}`,
    );
    return canDrop ? DROP : '';
  }
}

/** True when some field of `cfg` already references `${name}`. */
function referenced(cfg: McpServerConfig, name: string): boolean {
  const fields = [
    cfg.command ?? '',
    cfg.url ?? '',
    ...(cfg.args ?? []),
    ...Object.values(cfg.env ?? {}),
    ...Object.values(cfg.headers ?? {}),
  ];
  return fields.some((f) => [...f.matchAll(TOKEN)].some((m) => m[1] === name));
}

/** env/header maps with placeholders added for declared secrets that no field references. */
function withSecretPlaceholders(cfg: McpServerConfig): {
  env: Record<string, string>;
  headers: Record<string, string>;
} {
  const env = { ...(cfg.env ?? {}) };
  const headers = { ...(cfg.headers ?? {}) };
  for (const s of cfg.secrets ?? []) {
    if (referenced(cfg, s.name)) continue;
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
  if (!v)
    throw new PalmError(
      'E_PARSE',
      `MCP server "${cfg.name}": ${cfg.transport} transport needs a ${field}`,
    );
  return v;
}

function renderJsonEntry(
  cfg: McpServerConfig,
  target: Exclude<TargetId, 'codex'>,
  scope: Scope,
  st: RenderState,
): Record<string, unknown> {
  const style: 'plain' | 'env-colon' =
    target === 'claude' || (target === 'copilot' && scope === 'global') ? 'plain' : 'env-colon';
  const rewrite = (s: string, where: string, canDrop: boolean): string | typeof DROP => {
    let dropped = false;
    const out = s.replace(TOKEN, (m, v: string, def: string | undefined) => {
      if (isRuntimeVar(v)) return m;
      if (st.hasValue(v)) return st.values[v]!;
      const fallback = st.literalFallback(v, def, where, canDrop);
      if (fallback === DROP) {
        dropped = true;
        return '';
      }
      if (fallback !== undefined) return fallback;
      st.missing(v);
      if (style === 'env-colon') return `\${env:${v}}`;
      // Claude fails to load a config whose ${VAR} is unset without a default.
      const withDefault =
        def !== undefined ? def : target === 'claude' && st.optional.has(v) ? '' : undefined;
      return withDefault === undefined || target !== 'claude'
        ? `\${${v}}`
        : `\${${v}:-${withDefault}}`;
    });
    return dropped ? DROP : out;
  };
  const scalar = (s: string, where: string): string => rewrite(s, where, false) as string;
  const mapValues = (
    r: Record<string, string>,
    what: 'env' | 'header',
  ): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      const next = rewrite(v, `${what} ${k}`, true);
      if (next !== DROP) out[k] = next;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const { env, headers } = withSecretPlaceholders(cfg);
  if (cfg.cwd) st.notes.add(`cwd (${cfg.cwd}) is not supported in ${target} MCP config; dropped`);
  const copilotCli = target === 'copilot' && scope === 'global';

  if (cfg.transport === 'stdio') {
    const base = {
      command: scalar(requireField(cfg, 'command'), 'command'),
      args: cfg.args?.length ? cfg.args.map((a) => scalar(a, 'args')) : undefined,
      env: mapValues(env, 'env'),
    };
    if (target === 'cursor') return prune(base);
    if (copilotCli) return prune({ type: 'local', ...base, tools: ['*'] });
    return prune({ type: 'stdio', ...base });
  }

  const base = {
    url: scalar(requireField(cfg, 'url'), 'url'),
    headers: mapValues(headers, 'header'),
  };
  if (!base.headers) st.notes.add(OAUTH_NOTE);
  if (target === 'cursor') return prune(base);
  if (copilotCli) return prune({ type: cfg.transport, ...base, tools: ['*'] });
  return prune({ type: cfg.transport, ...base });
}

function renderCodexTable(
  cfg: McpServerConfig,
  st: RenderState,
): Record<string, unknown> | undefined {
  if (cfg.transport === 'sse') {
    st.notes.add(`Codex does not support SSE MCP servers; "${cfg.name}" skipped for codex`);
    return undefined;
  }
  // Codex expands nothing in command/args/url: substitute known values (literal), else keep the token.
  const literalOnly = (s: string, field: string): string =>
    s.replace(TOKEN, (m, v: string, def: string | undefined) => {
      if (isRuntimeVar(v)) return m;
      if (st.hasValue(v)) return st.values[v]!;
      const fallback = st.literalFallback(v, def, field, false);
      if (typeof fallback === 'string') return fallback;
      st.envRefs.add(v);
      st.notes.add(
        `Codex does not expand environment variables in ${field}: ${plainRefs(m)} is passed literally (install with --secrets literal to substitute it)`,
      );
      return m;
    });
  /** All tokens resolvable without the environment (values or literal defaults)? Then the substituted text, else undefined. */
  const substituted = (raw: string, where: string): string | typeof DROP | undefined => {
    let dropped = false;
    let unresolved = false;
    const out = raw.replace(TOKEN, (m, v: string, def: string | undefined) => {
      if (isRuntimeVar(v)) return m;
      if (st.hasValue(v)) return st.values[v]!;
      const fallback = st.literalFallback(v, def, where, true);
      if (fallback === DROP) dropped = true;
      else if (fallback !== undefined) return fallback;
      else unresolved = true;
      return m;
    });
    if (dropped) return DROP;
    return unresolved ? undefined : out;
  };
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
      const sub = substituted(raw, `env ${k}`);
      if (sub === DROP) continue;
      if (sub !== undefined) {
        literalEnv[k] = sub;
        continue;
      }
      for (const t of toks)
        if (!st.hasValue(t) && st.policy === 'literal')
          st.notes.add(`no value for ${t}; left as an environment reference`);
      envVars.push(k);
      st.envRefs.add(k);
      const exact = EXACT_TOKEN.exec(raw.trim());
      if (!exact || exact[1] !== k)
        st.notes.add(`Codex forwards ${k} from your environment: export ${k}="${plainRefs(raw)}"`);
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
    const sub = substituted(raw, `header ${h}`);
    if (sub === DROP) continue;
    if (sub !== undefined) {
      httpHeaders[h] = sub;
      continue;
    }
    for (const t of toks)
      if (!st.hasValue(t) && st.policy === 'literal')
        st.notes.add(`no value for ${t}; left as an environment reference`);
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
    if (!exact) {
      st.notes.add(
        `Codex sends the value of ${v} as the whole "${h}" header: export ${v}="${plainRefs(raw)}" with the secret filled in (the full header value, not just the secret)`,
      );
    }
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
  const st = new RenderState(policy, values, optionalSecretNames(cfg));
  const entry =
    target === 'codex' ? renderCodexTable(cfg, st) : renderJsonEntry(cfg, target, scope, st);
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
