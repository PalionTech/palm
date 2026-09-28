/**
 * MCP Registry `server.json` → canonical McpServerConfig.
 *
 * Schema: https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
 * (verified against registry.modelcontextprotocol.io and api.mcp.github.com, 2026-09).
 */
import { PalmError } from '../core/errors.js';
import type { McpServerConfig, SecretRef } from '../core/types.js';
import { isRecord } from '../lib/object.js';
import { envRef } from '../lib/placeholders.js';

// ---------------------------------------------------------------------------
// Local types for the subset of server.json palm reads (not in core/types.ts).
// ---------------------------------------------------------------------------

export interface ServerJsonInput {
  description?: string;
  default?: string;
  format?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  placeholder?: string;
  /** Fixed value; `{ident}` segments refer to `variables`. */
  value?: string;
  variables?: Record<string, ServerJsonInput>;
}

export interface ServerJsonKeyValueInput extends ServerJsonInput {
  name: string;
}

export interface ServerJsonArgument extends ServerJsonInput {
  type: 'positional' | 'named';
  /** Named arguments: the flag including its leading dashes (`--port`, `-e`). */
  name?: string;
  /** Positional arguments: label for a user-supplied value. */
  valueHint?: string;
  isRepeated?: boolean;
}

export interface ServerJsonTransport {
  type: string;
  url?: string;
  headers?: ServerJsonKeyValueInput[];
  variables?: Record<string, ServerJsonInput>;
}

export interface ServerJsonPackage {
  registryType: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  registryBaseUrl?: string;
  transport?: ServerJsonTransport;
  runtimeArguments?: ServerJsonArgument[];
  packageArguments?: ServerJsonArgument[];
  environmentVariables?: ServerJsonKeyValueInput[];
}

export interface ServerJson {
  name: string;
  description?: string;
  title?: string;
  version?: string;
  packages?: ServerJsonPackage[];
  remotes?: ServerJsonTransport[];
  repository?: { url?: string; source?: string; subfolder?: string };
  websiteUrl?: string;
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

/** Last path segment of a registry name (`io.github.brave/brave-search-mcp-server` → `brave-search-mcp-server`). */
export function registryShortName(name: string): string {
  const last = name.split('/').filter(Boolean).pop() ?? name;
  return last.replace(/[^A-Za-z0-9._-]+/g, '-');
}

const GENERIC_SHORT_NAMES = new Set([
  'mcp',
  'mcp-server',
  'mcp_server',
  'mcpserver',
  'server',
  'remote',
  'mcp-remote',
  'api',
]);

/**
 * Config key palm writes for a registry server: the short name, unless it is generic
 * (`com.notion/mcp`, `io.github.netdata/mcp-server`), in which case the namespace's last
 * label is used (`notion`, `netdata`).
 */
export function registryConfigName(name: string): string {
  const short = registryShortName(name);
  const slash = name.lastIndexOf('/');
  if (slash <= 0 || !GENERIC_SHORT_NAMES.has(short.toLowerCase())) return short;
  const label = name.slice(0, slash).split(/[./]/).filter(Boolean).pop();
  return label ? label.replace(/[^A-Za-z0-9._-]+/g, '-') : short;
}

/** `camelCase-or.dotted name` → `CAMEL_CASE_OR_DOTTED_NAME`. */
export function upperSnake(s: string): string {
  const out = s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return /^[0-9]/.test(out) ? `MCP_${out}` : out;
}

const ENV_STYLE = /^[A-Z][A-Z0-9_]*$/;

// ---------------------------------------------------------------------------
// Legacy (pre-2025-09, snake_case) shape normalization
// ---------------------------------------------------------------------------

const LEGACY_KEYS = [
  'version_detail',
  'registry_name',
  'runtime_hint',
  'transport_type',
  'environment_variables',
  'package_arguments',
  'runtime_arguments',
  'is_secret',
  'is_required',
];

function looksLegacy(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(looksLegacy);
  if (!isRecord(v)) return false;
  return Object.entries(v).some(
    ([k, child]) =>
      LEGACY_KEYS.includes(k) || (!k.startsWith('_') && !k.startsWith('x-') && looksLegacy(child)),
  );
}

function camel(k: string): string {
  return k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** Deep snake_case → camelCase on keys; map keys under `variables` and `_meta`-ish keys are preserved. */
function camelizeKeys(v: unknown, preserveKeys = false): unknown {
  if (Array.isArray(v)) return v.map((x) => camelizeKeys(x));
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, child] of Object.entries(v)) {
    const keep =
      preserveKeys ||
      k.startsWith('_') ||
      k.startsWith('$') ||
      k.startsWith('x-') ||
      k.includes('/');
    const key = keep ? k : camel(k);
    out[key] = camelizeKeys(child, key === 'variables');
  }
  return out;
}

const RUNTIME_HINT_TO_TYPE: Record<string, string> = {
  npx: 'npm',
  uvx: 'pypi',
  docker: 'oci',
  dnx: 'nuget',
};

function normalizeLegacy(raw: Record<string, unknown>): Record<string, unknown> {
  const s = camelizeKeys(raw) as Record<string, unknown>;
  const vd = s['versionDetail'];
  if (s['version'] === undefined && isRecord(vd) && typeof vd['version'] === 'string')
    s['version'] = vd['version'];
  if (Array.isArray(s['packages'])) {
    s['packages'] = s['packages'].map((p: unknown) => {
      if (!isRecord(p)) return p;
      const pkg = { ...p };
      if (pkg['identifier'] === undefined && typeof pkg['name'] === 'string')
        pkg['identifier'] = pkg['name'];
      if (!pkg['registryType'] && typeof pkg['registryName'] === 'string' && pkg['registryName']) {
        pkg['registryType'] = pkg['registryName'];
      }
      if (!pkg['registryType'] && typeof pkg['runtimeHint'] === 'string') {
        pkg['registryType'] = RUNTIME_HINT_TO_TYPE[pkg['runtimeHint']];
      }
      if (pkg['version'] === '') delete pkg['version'];
      if (!pkg['transport']) pkg['transport'] = { type: 'stdio' };
      return pkg;
    });
  }
  if (Array.isArray(s['remotes'])) {
    s['remotes'] = s['remotes'].map((r: unknown) => {
      if (!isRecord(r)) return r;
      const rem = { ...r };
      if (rem['type'] === undefined && typeof rem['transportType'] === 'string')
        rem['type'] = rem['transportType'];
      return rem;
    });
  }
  return s;
}

/**
 * Accepts a server.json document, a registry list/get item (`{server, _meta}`), or a legacy
 * snake_case item (GitHub `/v0`), and returns a modern server.json shape.
 */
export function normalizeServerJson(raw: unknown): ServerJson {
  let s: unknown = raw;
  if (isRecord(s) && isRecord(s['server']) && typeof s['name'] !== 'string') s = s['server'];
  if (!isRecord(s)) throw new PalmError('E_PARSE', 'Invalid server.json: expected an object');
  if (looksLegacy(s)) s = normalizeLegacy(s);
  const obj = s as Record<string, unknown>;
  if (typeof obj['name'] !== 'string' || obj['name'] === '') {
    throw new PalmError('E_PARSE', 'Invalid server.json: missing "name"');
  }
  return obj as unknown as ServerJson;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

class SecretCollector {
  readonly list: SecretRef[] = [];
  add(ref: SecretRef): void {
    const existing = this.list.find((s) => s.name === ref.name);
    if (!existing) {
      this.list.push(ref);
      return;
    }
    existing.required = existing.required || ref.required;
    existing.description ??= ref.description;
  }
}

interface Conv {
  short: string;
  /** Upper-snake prefix derived from the short name. */
  prefix: string;
  secrets: SecretCollector;
}

/** Env var name for a template variable: env-style names are kept, others are namespaced. */
function variableEnvName(c: Conv, ident: string): string {
  return ENV_STYLE.test(ident) ? ident : `${c.prefix}_${upperSnake(ident)}`;
}

const TEMPLATE_VAR = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const HAS_TEMPLATE_VAR = /\{[A-Za-z_][A-Za-z0-9_]*\}/;

interface TemplateOpts {
  /** Replace `{ident}` even when `variables` does not declare it (headers, URLs). */
  undeclared: boolean;
  in: 'env' | 'header';
  header?: string;
  /** Forces the env var name when the whole template is a single `{ident}` (docker `-e KEY={x}`). */
  wholeName?: string;
}

/**
 * Substitute `{ident}` template segments. Variables with a fixed `value` (or a non-secret
 * `default`) are inlined; everything else becomes a `${VAR}` placeholder plus a SecretRef.
 */
function substitute(
  c: Conv,
  template: string,
  parent: ServerJsonInput,
  opts: TemplateOpts,
): string {
  const vars = parent.variables ?? {};
  const idents = [...template.matchAll(TEMPLATE_VAR)].map((m) => m[1] as string);
  const single = idents.length === 1 && template.trim() === `{${idents[0]}}`;
  return template.replace(TEMPLATE_VAR, (match, ident: string) => {
    const v = vars[ident];
    if (!v && !opts.undeclared) return match;
    const secret = Boolean(v?.isSecret || parent.isSecret);
    if (v?.value !== undefined) return v.value;
    if (v?.default !== undefined && !secret) return v.default;
    const name = single && opts.wholeName ? opts.wholeName : variableEnvName(c, ident);
    const ref: SecretRef = {
      name,
      in: opts.in,
      required: Boolean(v?.isRequired || parent.isRequired),
    };
    const description = v?.description ?? parent.description;
    if (description) ref.description = description;
    if (opts.in === 'header' && opts.header) {
      ref.header = opts.header;
      if (idents.length === 1 && !single) ref.format = template.replace(match, '{value}');
    }
    c.secrets.add(ref);
    return envRef(name);
  });
}

/** Header or env var entry → rendered value, or undefined to omit (optional, nothing to fill in). */
function keyValue(
  c: Conv,
  kv: ServerJsonKeyValueInput,
  where: 'env' | 'header',
): string | undefined {
  const opts: TemplateOpts = { undeclared: where === 'header', in: where };
  if (where === 'header') opts.header = kv.name;
  else opts.wholeName = kv.name;
  if (kv.value !== undefined) return substitute(c, kv.value, kv, opts);
  if (kv.default !== undefined && !kv.isSecret) return kv.default;
  if (!kv.isSecret && !kv.isRequired) return undefined;
  const name = where === 'env' ? kv.name : `${c.prefix}_${upperSnake(kv.name)}`;
  const ref: SecretRef = { name, in: where, required: Boolean(kv.isRequired) };
  if (where === 'header') ref.header = kv.name;
  if (kv.description) ref.description = kv.description;
  c.secrets.add(ref);
  return envRef(name);
}

interface RenderedArgs {
  args: string[];
  /** docker `-e KEY=<template>` runtime args turned into env pass-through. */
  env: Record<string, string>;
}

function renderArgs(
  c: Conv,
  list: ServerJsonArgument[] | undefined,
  dockerEnv: boolean,
): RenderedArgs {
  const out: RenderedArgs = { args: [], env: {} };
  for (const arg of list ?? []) {
    const flag =
      arg.type === 'named' && arg.name
        ? arg.name.startsWith('-')
          ? arg.name
          : `--${arg.name}`
        : undefined;

    // docker -e KEY=<template with variables> → `-e KEY` + env[KEY], so secrets travel via env.
    if (dockerEnv && flag && (flag === '-e' || flag === '--env') && arg.value !== undefined) {
      const eq = arg.value.indexOf('=');
      const tpl = eq > 0 ? arg.value.slice(eq + 1) : '';
      if (eq > 0 && arg.variables && HAS_TEMPLATE_VAR.test(tpl)) {
        const key = arg.value.slice(0, eq);
        out.env[key] = substitute(c, tpl, arg, { undeclared: false, in: 'env', wholeName: key });
        out.args.push(flag, key);
        continue;
      }
    }

    let value: string | undefined;
    if (arg.value !== undefined)
      value = substitute(c, arg.value, arg, { undeclared: false, in: 'env' });
    else if (arg.default !== undefined) value = arg.default;
    else if (arg.isRequired) {
      const label = arg.valueHint ?? arg.name?.replace(/^-+/, '') ?? 'arg';
      const name = `${c.prefix}_${upperSnake(label)}`;
      const ref: SecretRef = { name, in: 'env', required: true };
      if (arg.description) ref.description = arg.description;
      c.secrets.add(ref);
      value = envRef(name);
    }

    if (arg.type === 'named') {
      if (!flag) continue;
      if (value === undefined) {
        // A declared flag with no value: only meaningful for required boolean switches.
        if (arg.isRequired && arg.format === 'boolean') out.args.push(flag);
        continue;
      }
      out.args.push(flag, value);
    } else if (value !== undefined) {
      out.args.push(value);
    }
  }
  return out;
}

const PACKAGE_RANK: Record<string, number> = { npm: 0, pypi: 1, oci: 2, nuget: 3 };

/** stdio packages first, then npm > pypi > oci > nuget > others > mcpb. */
function pickPackage(packages: ServerJsonPackage[]): ServerJsonPackage {
  const local = (p: ServerJsonPackage): number =>
    (p.transport?.type ?? 'stdio') === 'stdio' ? 0 : 1;
  const type = (p: ServerJsonPackage): number =>
    PACKAGE_RANK[p.registryType] ?? (p.registryType === 'mcpb' ? 99 : 50);
  const sorted = [...packages].sort((a, b) => local(a) - local(b) || type(a) - type(b));
  return sorted[0] as ServerJsonPackage;
}

function hasFlag(args: ServerJsonArgument[] | undefined, ...names: string[]): boolean {
  return (args ?? []).some(
    (a) => a.type === 'named' && a.name !== undefined && names.includes(a.name),
  );
}

function ociImage(pkg: ServerJsonPackage): string {
  const id = pkg.identifier;
  const lastSeg = id.split('/').pop() ?? id;
  const tagged = id.includes('@sha256:') || lastSeg.includes(':');
  return tagged || !pkg.version ? id : `${id}:${pkg.version}`;
}

function fromPackage(c: Conv, sj: ServerJson, pkg: ServerJsonPackage): McpServerConfig {
  const transport = pkg.transport?.type ?? 'stdio';
  if (pkg.registryType === 'mcpb') {
    throw new PalmError(
      'E_USAGE',
      `MCP server ${sj.name} is only published as an MCP bundle (.mcpb), which palm cannot install`,
      `Install the bundle in a client that supports .mcpb, or add it manually with: palm install mcp ${c.short} -- <command> [args...]`,
    );
  }
  if (transport !== 'stdio') {
    const where = pkg.transport?.url ? ` at ${pkg.transport.url}` : '';
    throw new PalmError(
      'E_USAGE',
      `MCP server ${sj.name} runs as a local ${transport} server${where}; palm cannot start it for you`,
      `Start it yourself (${pkg.registryType} ${pkg.identifier}), then: palm install mcp ${c.short} --url <url>`,
    );
  }

  const env: Record<string, string> = {};
  const envNames: string[] = [];
  for (const ev of pkg.environmentVariables ?? []) {
    if (!ev?.name) continue;
    const v = keyValue(c, ev, 'env');
    if (v === undefined) continue;
    env[ev.name] = v;
    envNames.push(ev.name);
  }

  const isOci = pkg.registryType === 'oci';
  const runtime = renderArgs(c, pkg.runtimeArguments, isOci);
  const packageArgs = renderArgs(c, pkg.packageArguments, false).args;
  Object.assign(env, runtime.env);

  let command: string;
  let args: string[];
  const id = pkg.identifier;
  switch (pkg.registryType) {
    case 'npm': {
      command = 'npx';
      const yes = runtime.args.includes('-y') || runtime.args.includes('--yes') ? [] : ['-y'];
      const spec = hasFlag(pkg.runtimeArguments, '--package', '-p')
        ? []
        : [pkg.version ? `${id}@${pkg.version}` : id];
      args = [...yes, ...runtime.args, ...spec, ...packageArgs];
      break;
    }
    case 'pypi': {
      command = 'uvx';
      const spec = hasFlag(pkg.runtimeArguments, '--from')
        ? []
        : [pkg.version ? `${id}==${pkg.version}` : id];
      args = [...runtime.args, ...spec, ...packageArgs];
      break;
    }
    case 'oci': {
      command = 'docker';
      const envFlags = envNames.flatMap((n) => ['-e', n]);
      args = ['run', '-i', '--rm', ...envFlags, ...runtime.args, ociImage(pkg), ...packageArgs];
      break;
    }
    case 'nuget': {
      command = 'dnx';
      args = [...runtime.args, pkg.version ? `${id}@${pkg.version}` : id, '--yes'];
      if (packageArgs.length) args.push('--', ...packageArgs);
      break;
    }
    default: {
      if (!pkg.runtimeHint) {
        throw new PalmError(
          'E_USAGE',
          `MCP server ${sj.name} uses unsupported package registry "${pkg.registryType}"`,
          `Add it manually with: palm install mcp ${c.short} -- <command> [args...]`,
        );
      }
      command = pkg.runtimeHint;
      args = [...runtime.args, id, ...packageArgs];
    }
  }

  const cfg: McpServerConfig = { name: c.short, transport: 'stdio', command, args };
  if (Object.keys(env).length) cfg.env = env;
  return cfg;
}

function fromRemote(c: Conv, remote: ServerJsonTransport): McpServerConfig {
  const transport: McpServerConfig['transport'] = remote.type === 'sse' ? 'sse' : 'http';
  const url = substitute(
    c,
    remote.url ?? '',
    { variables: remote.variables ?? {} },
    { undeclared: false, in: 'env' },
  );
  const cfg: McpServerConfig = { name: c.short, transport, url };
  const headers: Record<string, string> = {};
  for (const h of remote.headers ?? []) {
    if (!h?.name) continue; // GitHub's legacy /v0 drops header names; nothing we can write.
    const v = keyValue(c, h, 'header');
    if (v !== undefined) headers[h.name] = v;
  }
  if (Object.keys(headers).length) cfg.headers = headers;
  return cfg;
}

/**
 * Convert a registry server.json (or a `{server, _meta}` registry item) to palm's canonical config.
 *
 * Preference: the first streamable-http remote (else the first remote), otherwise the best local
 * package (stdio first; npm > pypi > oci > nuget). `cfg.name` is `registryConfigName()` (the
 * short name, or the namespace label when that is generic); the full registry name is kept in
 * `source.ref`.
 */
export function serverJsonToConfig(serverJson: unknown): McpServerConfig {
  const sj = normalizeServerJson(serverJson);
  const short = registryConfigName(sj.name);
  const c: Conv = { short, prefix: upperSnake(short) || 'MCP', secrets: new SecretCollector() };

  const remotes = (sj.remotes ?? []).filter((r) => r && typeof r.url === 'string' && r.url !== '');
  const packages = (sj.packages ?? []).filter(
    (p) => p && typeof p.identifier === 'string' && p.registryType,
  );

  let cfg: McpServerConfig;
  if (remotes.length) {
    const remote =
      remotes.find((r) => r.type === 'streamable-http') ?? (remotes[0] as ServerJsonTransport);
    cfg = fromRemote(c, remote);
  } else if (packages.length) {
    cfg = fromPackage(c, sj, pickPackage(packages));
  } else {
    throw new PalmError(
      'E_PARSE',
      `MCP server ${sj.name} declares neither remotes nor packages`,
      `Add it manually with: palm install mcp ${short} -- <command> [args...]  or  --url <url>`,
    );
  }

  if (c.secrets.list.length) cfg.secrets = c.secrets.list;
  cfg.source = { type: 'registry', ref: sj.name };
  if (sj.version) cfg.source.version = sj.version;
  return cfg;
}
