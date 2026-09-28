/**
 * Which `${VAR}` placeholders of an MCP server config are secrets the user supplies (DESIGN.md
 * §7), and which of them are optional. The one implementation for the scanner (src/index/mcp),
 * the renderers (src/targets/mcp-config), the engine and src/mcp/secrets (prompting). The token
 * grammar and the runtime-variable list live in lib/placeholders.
 */
import type { McpServerConfig, SecretRef } from '../core/types.js';
import { findPlaceholders, isRuntimeVar, type Placeholder } from '../lib/placeholders.js';

/** Adds `ref` to `out`, or merges it into the entry of that name (required ORs; a header use wins). */
function addRef(out: SecretRef[], ref: SecretRef): void {
  const existing = out.find((s) => s.name === ref.name);
  if (!existing) {
    out.push(ref);
    return;
  }
  existing.required ||= ref.required;
  if (existing.description === undefined && ref.description !== undefined)
    existing.description = ref.description;
  if (existing.in === 'env' && ref.in === 'header') {
    existing.in = 'header';
    if (ref.header) existing.header = ref.header;
    if (ref.format) existing.format = ref.format;
  }
}

/** Adds `make(p)` for every placeholder `p` in `value` that is not a runtime variable. */
function scan(value: unknown, make: (p: Placeholder) => SecretRef, out: SecretRef[]): void {
  if (typeof value !== 'string') return;
  for (const p of findPlaceholders(value)) if (!isRuntimeVar(p.name)) addRef(out, make(p));
}

/** An env secret, required unless its placeholder has a `:-default`. */
function envSecret(p: Placeholder): SecretRef {
  return { name: p.name, in: 'env', required: p.default === undefined };
}

/**
 * A header secret. When the value holds exactly one placeholder and more than it
 * (`Bearer ${TOKEN}`), `format` records the template (`Bearer {value}`).
 */
function headerSecret(header: string, value: unknown): (p: Placeholder) => SecretRef {
  const text = typeof value === 'string' ? value : '';
  const single = findPlaceholders(text).length === 1;
  return (p) => {
    const ref: SecretRef = {
      name: p.name,
      in: 'header',
      header,
      required: p.default === undefined,
    };
    if (single && text !== p.raw) ref.format = text.replace(p.raw, '{value}');
    return ref;
  };
}

/**
 * `${VAR}`-style placeholders in env values, header values, the URL and args → SecretRefs, one
 * per name in order of appearance. A placeholder with a `:-default` is optional; a name used
 * with and without a default is required. Runtime variables (`isRuntimeVar`) are skipped.
 */
export function detectSecrets(cfg: McpServerConfig): SecretRef[] {
  const out: SecretRef[] = [];
  for (const value of Object.values(cfg.env ?? {})) scan(value, envSecret, out);
  for (const [header, value] of Object.entries(cfg.headers ?? {}))
    scan(value, headerSecret(header, value), out);
  scan(cfg.url, envSecret, out);
  for (const arg of cfg.args ?? []) scan(arg, envSecret, out);
  return out;
}

/**
 * `cfg.secrets` ∪ `detectSecrets(cfg)`, by name. Declared entries are authoritative (a declared
 * optional secret stays optional even though its `${VAR}` has no default); detection only adds
 * new names. `cfg.secrets` is never mutated.
 */
export function allSecrets(cfg: McpServerConfig): SecretRef[] {
  const out: SecretRef[] = [];
  for (const s of cfg.secrets ?? []) addRef(out, { ...s });
  for (const s of detectSecrets(cfg)) if (!out.some((d) => d.name === s.name)) out.push(s);
  return out;
}

/** Names of the optional secrets of `cfg` (declared `required: false`, or only `${VAR:-default}`). */
export function optionalSecretNames(cfg: McpServerConfig): Set<string> {
  return new Set(
    allSecrets(cfg)
      .filter((s) => !s.required)
      .map((s) => s.name),
  );
}

/** Names of the required secrets of `cfg` (every secret `optionalSecretNames` leaves out). */
export function requiredSecretNames(cfg: McpServerConfig): Set<string> {
  return new Set(
    allSecrets(cfg)
      .filter((s) => s.required)
      .map((s) => s.name),
  );
}
