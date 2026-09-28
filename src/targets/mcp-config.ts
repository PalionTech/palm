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
import { withoutUndefined } from '../lib/object.js';
import {
  envRef,
  findPlaceholders,
  isRuntimeVar,
  parsePlaceholder,
  replacePlaceholders,
} from '../lib/placeholders.js';

export interface RenderedMcp {
  /** Harness object / TOML table; undefined when the harness cannot express this server. */
  entry: Record<string, unknown> | undefined;
  notes: string[];
  /** Environment variables the user has to provide (env-ref placements, unresolved literals). */
  envRefs: string[];
}

export const OAUTH_NOTE = 'HTTP MCP servers authenticate via OAuth on first connect';

function tokensOf(s: string): string[] {
  return findPlaceholders(s)
    .map((p) => p.name)
    .filter((v) => !isRuntimeVar(v));
}

/** The variable of a value that is exactly one `${VAR}` token. */
function exactVar(s: string): string | undefined {
  return parsePlaceholder(s.trim())?.name;
}

/** The variable of a `Bearer ${VAR}` value. */
function bearerVar(s: string): string | undefined {
  const m = /^Bearer\s+(.*)$/is.exec(s.trim());
  return m ? exactVar(m[1] as string) : undefined;
}

/** `${env:X}` → `${X}` (for human-readable notes). */
function plainRefs(s: string): string {
  return replacePlaceholders(s, (p) => (isRuntimeVar(p.name) ? undefined : envRef(p.name)));
}

/**
 * Names of the optional secrets of `cfg`: declared with `required: false`, or undeclared and
 * written with a `:-default` wherever an env value, header value, the url or an arg uses them.
 * The same rule as `optionalSecretNames` in src/mcp/secrets (src/targets may not import it).
 */
function optionalSecretNames(cfg: McpServerConfig): Set<string> {
  const required = new Map<string, boolean>();
  for (const s of cfg.secrets ?? []) required.set(s.name, required.get(s.name) || s.required);
  const detected = new Map<string, boolean>();
  const values = [
    ...Object.values(cfg.env ?? {}),
    ...Object.values(cfg.headers ?? {}),
    cfg.url,
    ...(cfg.args ?? []),
  ];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const p of findPlaceholders(value)) {
      if (isRuntimeVar(p.name) || required.has(p.name)) continue;
      detected.set(p.name, detected.get(p.name) || p.default === undefined);
    }
  }
  const optional = [...required, ...detected].filter(([, isRequired]) => !isRequired);
  return new Set(optional.map(([name]) => name));
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
  return fields.some((f) => findPlaceholders(f).some((p) => p.name === name));
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
    const ref = envRef(s.name);
    if (s.in === 'env' && env[s.name] === undefined) env[s.name] = ref;
    if (s.in === 'header' && s.header && headers[s.header] === undefined) {
      headers[s.header] = s.format ? s.format.replace('{value}', ref) : ref;
    }
  }
  return { env, headers };
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
    const out = replacePlaceholders(s, ({ name: v, default: def }) => {
      if (isRuntimeVar(v)) return undefined;
      if (st.hasValue(v)) return st.values[v]!;
      const fallback = st.literalFallback(v, def, where, canDrop);
      if (fallback === DROP) {
        dropped = true;
        return '';
      }
      if (fallback !== undefined) return fallback;
      st.missing(v);
      if (style === 'env-colon') return envRef(v, 'env-colon');
      // Claude fails to load a config whose ${VAR} is unset without a default.
      const withDefault =
        def !== undefined ? def : target === 'claude' && st.optional.has(v) ? '' : undefined;
      return withDefault === undefined || target !== 'claude'
        ? envRef(v)
        : envRef(v, 'dollar-default', withDefault);
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
    if (target === 'cursor') return withoutUndefined(base);
    if (copilotCli) return withoutUndefined({ type: 'local', ...base, tools: ['*'] });
    return withoutUndefined({ type: 'stdio', ...base });
  }

  const base = {
    url: scalar(requireField(cfg, 'url'), 'url'),
    headers: mapValues(headers, 'header'),
  };
  if (!base.headers) st.notes.add(OAUTH_NOTE);
  if (target === 'cursor') return withoutUndefined(base);
  if (copilotCli) return withoutUndefined({ type: cfg.transport, ...base, tools: ['*'] });
  return withoutUndefined({ type: cfg.transport, ...base });
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
    replacePlaceholders(s, ({ name: v, default: def, raw }) => {
      if (isRuntimeVar(v)) return undefined;
      if (st.hasValue(v)) return st.values[v]!;
      const fallback = st.literalFallback(v, def, field, false);
      if (typeof fallback === 'string') return fallback;
      st.envRefs.add(v);
      st.notes.add(
        `Codex does not expand environment variables in ${field}: ${plainRefs(raw)} is passed literally (install with --secrets literal to substitute it)`,
      );
      return undefined;
    });
  /** All tokens resolvable without the environment (values or literal defaults)? Then the substituted text, else undefined. */
  const substituted = (raw: string, where: string): string | typeof DROP | undefined => {
    let dropped = false;
    let unresolved = false;
    const out = replacePlaceholders(raw, ({ name: v, default: def }) => {
      if (isRuntimeVar(v)) return undefined;
      if (st.hasValue(v)) return st.values[v]!;
      const fallback = st.literalFallback(v, def, where, true);
      if (fallback === DROP) dropped = true;
      else if (fallback !== undefined) return fallback;
      else unresolved = true;
      return undefined;
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
      if (exactVar(raw) !== k)
        st.notes.add(`Codex forwards ${k} from your environment: export ${k}="${plainRefs(raw)}"`);
    }
    return withoutUndefined({
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
    const bearerName = bearerVar(raw);
    if (/^authorization$/i.test(h) && bearerName && bearer === undefined) {
      bearer = bearerName;
      st.envRefs.add(bearer);
      continue;
    }
    const exact = exactVar(raw);
    const v = exact ?? toks[0]!;
    envHeaders[h] = v;
    st.envRefs.add(v);
    if (!exact) {
      st.notes.add(
        `Codex sends the value of ${v} as the whole "${h}" header: export ${v}="${plainRefs(raw)}" with the secret filled in (the full header value, not just the secret)`,
      );
    }
  }
  if (Object.keys(headers).length === 0) st.notes.add(OAUTH_NOTE);
  return withoutUndefined({
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
