/**
 * Render a canonical McpServerConfig into one harness's config entry.
 *
 * Placeholders: `${VAR}` / `${env:VAR}` / `${VAR:-default}` tokens in command, args, url,
 * env values and header values.
 * - `env-ref`: rewritten to the harness syntax (claude, gemini and Copilot CLI `${VAR}`, cursor
 *   and VS Code `${env:VAR}`, opencode `{env:VAR}`). Claude rejects a config whose `${VAR}` is
 *   unset and has no default, and Gemini CLI keeps such a token literally ("an unset var
 *   without a default stays literal", R7 §7), so for both optional secrets become `${VAR:-}` (a
 *   declared default is kept). OpenCode has no default syntax (unset is `""`): a non-empty
 *   declared default is lost (noted).
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
 * - gemini:  `{ command, args, env, cwd }` / `{ url, type: http|sse, headers }` in
 *            settings.json `mcpServers`: `httpUrl` is "deprecated… migrate to 'url' with
 *            'type: "http"'" (packages/core/src/tools/mcp-client.ts)
 * - opencode: `{ type: local, command: [cmd, ...args], cwd, environment, enabled }` /
 *            `{ type: remote, url, headers, oauth: false (header auth), enabled }` in
 *            opencode.json `mcp`; http and sse are both `remote` (StreamableHTTP, then SSE)
 * - codex:   TOML table: stdio `command,args,cwd,env,env_vars`; http `url,
 *            bearer_token_env_var, http_headers, env_http_headers`. SSE unsupported.
 *            Codex expands nothing in command/args/url: under env-ref a token there is a
 *            documented limitation (note); under literal it is substituted.
 */

import { PalmError } from '../core/errors.js';
import type { McpServerConfig, Scope, SecretPolicy, TargetId } from '../core/types.js';
import { optionalSecretNames } from '../domain/secret-refs.js';
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

/** Marker for a value that must be left out (optional secret without a value under `literal`). */
const DROP = Symbol('drop');

class RenderState {
  readonly notes = new Set<string>();
  readonly envRefs = new Set<string>();
  constructor(
    /** The server's name (for hints). */
    readonly name: string,
    readonly policy: SecretPolicy,
    readonly values: Record<string, string>,
    readonly optional: Set<string>,
  ) {}

  /** Under `literal`, the value supplied for `v`. */
  valueOf(v: string): string | undefined {
    return this.policy === 'literal' ? this.values[v] : undefined;
  }

  missing(v: string): void {
    if (this.policy === 'literal')
      this.notes.add(`no value for ${v}; left as an environment reference`);
    this.envRefs.add(v);
  }

  /** Under `literal`, a note for each of `vars` that has no value. */
  noteUnresolved(vars: string[]): void {
    if (this.policy !== 'literal') return;
    for (const v of vars)
      if (this.values[v] === undefined)
        this.notes.add(`no value for ${v}; left as an environment reference`);
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

/** Claude fails to load a config whose `${VAR}` is unset without a default: optional secrets get `${VAR:-}`. */
function claudeRef(v: string, def: string | undefined, optional: boolean): string {
  const fallback = def ?? (optional ? '' : undefined);
  return fallback === undefined ? envRef(v) : envRef(v, 'dollar-default', fallback);
}

/** A JSON harness and the scope (it selects the Copilot format). */
interface JsonTarget {
  target: Exclude<TargetId, 'codex'>;
  scope: Scope;
}

/**
 * How a harness writes an environment reference: `${VAR}` with `${VAR:-}` for optional
 * secrets (claude, gemini), plain `${VAR}` (Copilot CLI), `${env:VAR}` (Cursor, VS Code) or
 * `{env:VAR}` (OpenCode).
 */
type RefStyle = 'dollar-default' | 'dollar' | 'env-colon' | 'opencode';

function refStyleOf({ target, scope }: JsonTarget): RefStyle {
  if (target === 'claude' || target === 'gemini') return 'dollar-default';
  if (target === 'opencode') return 'opencode';
  return target === 'copilot' && scope === 'global' ? 'dollar' : 'env-colon';
}

/** The reference to `v` (with its declared default `def`) in `style`. */
function harnessRef(style: RefStyle, v: string, def: string | undefined, st: RenderState): string {
  switch (style) {
    case 'dollar-default':
      return claudeRef(v, def, st.optional.has(v));
    case 'dollar':
      return envRef(v);
    case 'env-colon':
      return envRef(v, 'env-colon');
    case 'opencode':
      // `{env:VAR}` is "" when unset, which is what an empty `${VAR:-}` default means anyway.
      if (def)
        st.notes.add(
          `OpenCode has no default syntax: ${v} is empty when unset (default "${def}" dropped)`,
        );
      return `{env:${v}}`;
  }
}

/**
 * `s` with each non-runtime token resolved for a JSON harness: a value, a literal fallback, or
 * the harness's environment reference. DROP when `at.canDrop` and an optional secret without a
 * value was left out.
 */
function rewriteJson(
  s: string,
  at: { where: string; canDrop: boolean },
  style: RefStyle,
  st: RenderState,
): string | typeof DROP {
  let dropped = false;
  const out = replacePlaceholders(s, ({ name: v, default: def }) => {
    if (isRuntimeVar(v)) return undefined;
    const fallback = st.valueOf(v) ?? st.literalFallback(v, def, at.where, at.canDrop);
    if (fallback === DROP) {
      dropped = true;
      return '';
    }
    if (fallback !== undefined) return fallback;
    st.missing(v);
    return harnessRef(style, v, def, st);
  });
  return dropped ? DROP : out;
}

/** A stdio server's rendered fields. */
interface StdioParts {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function stdioEntry(
  t: JsonTarget,
  p: StdioParts,
  cwd: string | undefined,
): Record<string, unknown> {
  switch (t.target) {
    case 'cursor':
      return withoutUndefined({ ...p });
    case 'gemini':
      return withoutUndefined({ ...p, cwd });
    case 'opencode':
      return withoutUndefined({
        type: 'local',
        command: [p.command, ...(p.args ?? [])],
        cwd,
        environment: p.env,
        enabled: true,
      });
    case 'copilot':
      if (t.scope === 'global') return withoutUndefined({ type: 'local', ...p, tools: ['*'] });
  }
  return withoutUndefined({ type: 'stdio', ...p });
}

/** An HTTP/SSE server's rendered fields; `headerAuth` when a header carries the credentials. */
interface HttpParts {
  url: string;
  headers?: Record<string, string>;
  transport: 'http' | 'sse';
  headerAuth: boolean;
}

function httpEntry(t: JsonTarget, p: HttpParts): Record<string, unknown> {
  const { url, headers, transport: type } = p;
  switch (t.target) {
    case 'cursor':
      return withoutUndefined({ url, headers });
    case 'gemini':
      return withoutUndefined({ url, type, headers });
    case 'opencode': {
      // OpenCode starts an OAuth flow for remote servers unless told not to (R7 §7).
      const oauth = p.headerAuth ? { oauth: false } : {};
      return withoutUndefined({ type: 'remote', url, headers, ...oauth, enabled: true });
    }
    case 'copilot':
      if (t.scope === 'global') return withoutUndefined({ type, url, headers, tools: ['*'] });
  }
  return withoutUndefined({ type, url, headers });
}

/** True when the server authenticates through a header (Authorization or a header secret). */
function usesHeaderAuth(cfg: McpServerConfig, headers: Record<string, string>): boolean {
  return (
    Object.keys(headers).some((h) => /^authorization$/i.test(h)) ||
    (cfg.secrets ?? []).some((s) => s.in === 'header')
  );
}

function renderJsonEntry(
  cfg: McpServerConfig,
  t: JsonTarget,
  st: RenderState,
): Record<string, unknown> {
  const style = refStyleOf(t);
  const scalar = (s: string, where: string): string =>
    rewriteJson(s, { where, canDrop: false }, style, st) as string;
  const mapValues = (
    r: Record<string, string>,
    what: 'env' | 'header',
  ): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      const next = rewriteJson(v, { where: `${what} ${k}`, canDrop: true }, style, st);
      if (next !== DROP) out[k] = next;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const { env, headers } = withSecretPlaceholders(cfg);
  const keepsCwd = cfg.transport === 'stdio' && (t.target === 'gemini' || t.target === 'opencode');
  if (cfg.cwd && !keepsCwd)
    st.notes.add(`cwd (${cfg.cwd}) is not supported in ${t.target} MCP config; dropped`);

  if (cfg.transport === 'stdio') {
    const parts = {
      command: scalar(requireField(cfg, 'command'), 'command'),
      args: cfg.args?.length ? cfg.args.map((a) => scalar(a, 'args')) : undefined,
      env: mapValues(env, 'env'),
    };
    return stdioEntry(t, parts, keepsCwd ? cfg.cwd : undefined);
  }
  const rendered = mapValues(headers, 'header');
  if (!rendered) st.notes.add(OAUTH_NOTE);
  return httpEntry(t, {
    url: scalar(requireField(cfg, 'url'), 'url'),
    headers: rendered,
    transport: cfg.transport,
    headerAuth: rendered !== undefined && usesHeaderAuth(cfg, headers),
  });
}

/** Codex expands nothing in command/args/url: substitute known values (literal), else keep the token (with a note). */
function codexLiteral(s: string, field: string, st: RenderState): string {
  return replacePlaceholders(s, ({ name: v, default: def, raw }) => {
    if (isRuntimeVar(v)) return undefined;
    const fallback = st.valueOf(v) ?? st.literalFallback(v, def, field, false);
    if (typeof fallback === 'string') return fallback;
    st.envRefs.add(v);
    st.notes.add(
      `Codex does not expand environment variables in ${field}: ${plainRefs(raw)} is passed literally (to substitute it: palm install mcp ${st.name} --secrets literal)`,
    );
    return undefined;
  });
}

/**
 * `raw` with every token resolved without the environment (values or literal defaults); DROP
 * when an optional secret without a value was left out; undefined when a token needs the
 * environment. Values without tokens come back unchanged.
 */
function codexSubstituted(
  raw: string,
  where: string,
  st: RenderState,
): string | typeof DROP | undefined {
  let dropped = false;
  let unresolved = false;
  const out = replacePlaceholders(raw, ({ name: v, default: def }) => {
    if (isRuntimeVar(v)) return undefined;
    const fallback = st.valueOf(v) ?? st.literalFallback(v, def, where, true);
    if (fallback === DROP) dropped = true;
    else if (fallback !== undefined) return fallback;
    else unresolved = true;
    return undefined;
  });
  if (dropped) return DROP;
  return unresolved ? undefined : out;
}

function codexStdio(
  cfg: McpServerConfig,
  env: Record<string, string>,
  st: RenderState,
): Record<string, unknown> {
  const literalEnv: Record<string, string> = {};
  const envVars: string[] = [];
  for (const [k, raw] of Object.entries(env)) {
    const sub = codexSubstituted(raw, `env ${k}`, st);
    if (sub === DROP) continue;
    if (sub !== undefined) {
      literalEnv[k] = sub;
      continue;
    }
    st.noteUnresolved(tokensOf(raw));
    envVars.push(k);
    st.envRefs.add(k);
    if (exactVar(raw) !== k)
      st.notes.add(`Codex forwards ${k} from your environment: export ${k}="${plainRefs(raw)}"`);
  }
  return withoutUndefined({
    command: codexLiteral(requireField(cfg, 'command'), 'command', st),
    args: cfg.args?.length ? cfg.args.map((a) => codexLiteral(a, 'args', st)) : undefined,
    cwd: cfg.cwd,
    env_vars: envVars.length ? envVars : undefined,
    env: Object.keys(literalEnv).length ? literalEnv : undefined,
  });
}

/** The variable Codex reads the whole header `h` from (noted when the value is more than one token). */
function codexEnvHeader(h: string, raw: string, st: RenderState): string {
  const exact = exactVar(raw);
  const v = exact ?? (tokensOf(raw)[0] as string);
  st.envRefs.add(v);
  if (!exact) {
    st.notes.add(
      `Codex sends the value of ${v} as the whole "${h}" header: export ${v}="${plainRefs(raw)}" with the secret filled in (the full header value, not just the secret)`,
    );
  }
  return v;
}

function codexHttp(
  cfg: McpServerConfig,
  headers: Record<string, string>,
  st: RenderState,
): Record<string, unknown> {
  const httpHeaders: Record<string, string> = {};
  const envHeaders: Record<string, string> = {};
  let bearer: string | undefined;
  for (const [h, raw] of Object.entries(headers)) {
    const sub = codexSubstituted(raw, `header ${h}`, st);
    if (sub === DROP) continue;
    if (sub !== undefined) {
      httpHeaders[h] = sub;
      continue;
    }
    st.noteUnresolved(tokensOf(raw));
    const bearerName = bearerVar(raw);
    if (/^authorization$/i.test(h) && bearerName && bearer === undefined) {
      bearer = bearerName;
      st.envRefs.add(bearer);
    } else envHeaders[h] = codexEnvHeader(h, raw, st);
  }
  if (Object.keys(headers).length === 0) st.notes.add(OAUTH_NOTE);
  return withoutUndefined({
    url: codexLiteral(requireField(cfg, 'url'), 'url', st),
    bearer_token_env_var: bearer,
    http_headers: Object.keys(httpHeaders).length ? httpHeaders : undefined,
    env_http_headers: Object.keys(envHeaders).length ? envHeaders : undefined,
  });
}

function renderCodexTable(
  cfg: McpServerConfig,
  st: RenderState,
): Record<string, unknown> | undefined {
  if (cfg.transport === 'sse') {
    st.notes.add(`Codex does not support SSE MCP servers; "${cfg.name}" skipped for codex`);
    return undefined;
  }
  const { env, headers } = withSecretPlaceholders(cfg);
  return cfg.transport === 'stdio' ? codexStdio(cfg, env, st) : codexHttp(cfg, headers, st);
}

/** Secret values (policy `literal`) and the scope (it selects the Copilot format). */
export interface RenderMcpOptions {
  values?: Record<string, string>;
  /** project (default): VS Code `.vscode/mcp.json`; global: Copilot CLI. Only matters for copilot. */
  scope?: Scope;
}

/** Full render with notes and the env vars to export. */
export function renderMcp(
  cfg: McpServerConfig,
  target: TargetId,
  policy: SecretPolicy,
  opts: RenderMcpOptions = {},
): RenderedMcp {
  const st = new RenderState(cfg.name, policy, opts.values ?? {}, optionalSecretNames(cfg));
  const entry =
    target === 'codex'
      ? renderCodexTable(cfg, st)
      : renderJsonEntry(cfg, { target, scope: opts.scope ?? 'project' }, st);
  return { entry, notes: [...st.notes], envRefs: [...st.envRefs] };
}
