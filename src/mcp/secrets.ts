/**
 * Secret detection and resolution for MCP server configs (DESIGN.md §7). The `${VAR}` grammar
 * and the runtime-variable list live in `lib/placeholders`. Secret values are never logged.
 */
import { PalmError } from '../core/errors.js';
import type { McpServerConfig, PalmContext, SecretPolicy, SecretRef } from '../core/types.js';
import { findPlaceholders, isRuntimeVar, type Placeholder } from '../lib/placeholders.js';

function addRef(list: SecretRef[], ref: SecretRef): void {
  const existing = list.find((s) => s.name === ref.name);
  if (!existing) {
    list.push(ref);
    return;
  }
  existing.required = existing.required || ref.required;
  existing.description ??= ref.description;
  if (existing.in === 'env' && ref.in === 'header') {
    existing.in = 'header';
    if (ref.header) existing.header = ref.header;
    if (ref.format) existing.format = ref.format;
  }
}

/** Adds `make(p)` for every placeholder `p` in `value` that is not a runtime variable. */
function scan(value: string, make: (p: Placeholder) => SecretRef, out: SecretRef[]): void {
  for (const p of findPlaceholders(value)) if (!isRuntimeVar(p.name)) addRef(out, make(p));
}

/** An env secret, required unless its placeholder has a `:-default`. */
function envSecret(p: Placeholder): SecretRef {
  return { name: p.name, in: 'env', required: p.default === undefined };
}

/**
 * `${VAR}`-style placeholders in env values, header values, the URL and args → SecretRefs.
 * A placeholder with a `:-default` is optional. For a header whose value is more than the
 * placeholder (e.g. `Bearer ${TOKEN}`), `format` records the template (`Bearer {value}`).
 * Runtime variables (`isRuntimeVar`) are skipped.
 */
export function detectSecrets(cfg: McpServerConfig): SecretRef[] {
  const out: SecretRef[] = [];
  for (const value of Object.values(cfg.env ?? {})) {
    if (typeof value === 'string') scan(value, envSecret, out);
  }
  for (const [header, value] of Object.entries(cfg.headers ?? {})) {
    if (typeof value !== 'string') continue;
    const single = findPlaceholders(value).length === 1;
    scan(
      value,
      (p) => {
        const required = p.default === undefined;
        const ref: SecretRef = { name: p.name, in: 'header', header, required };
        if (single && value !== p.raw) ref.format = value.replace(p.raw, '{value}');
        return ref;
      },
      out,
    );
  }
  if (typeof cfg.url === 'string') scan(cfg.url, envSecret, out);
  for (const arg of cfg.args ?? []) {
    if (typeof arg === 'string') scan(arg, envSecret, out);
  }
  return out;
}

/** Names of the optional secrets of `cfg` (declared `required: false`, or `${VAR:-default}`). */
export function optionalSecretNames(cfg: McpServerConfig): Set<string> {
  return new Set(
    allSecrets(cfg)
      .filter((s) => !s.required)
      .map((s) => s.name),
  );
}

/**
 * cfg.secrets ∪ detectSecrets(cfg), by name. Declared entries are authoritative (a declared optional
 * secret stays optional even though its `${VAR}` has no default); detection only adds new names.
 */
export function allSecrets(cfg: McpServerConfig): SecretRef[] {
  const out: SecretRef[] = [];
  for (const s of cfg.secrets ?? []) addRef(out, { ...s });
  for (const s of detectSecrets(cfg)) {
    if (!out.some((d) => d.name === s.name)) out.push(s);
  }
  return out;
}

function isSet(v: string | undefined): v is string {
  return v !== undefined && v !== '';
}

/**
 * Decide how each secret of `cfg` is supplied.
 *
 * - `env-ref`: nothing is read or prompted; `envRefs` lists the secrets not currently exported
 *   (the engine tells the user to export them).
 * - `literal`: values come from `ctx.env`, else a masked prompt (interactive). Optional secrets may
 *   be skipped with an empty answer. Missing required secrets without a TTY → E_NON_INTERACTIVE.
 *   `envRefs` lists the names left unresolved.
 */
export async function resolveSecrets(
  ctx: PalmContext,
  cfg: McpServerConfig,
  policy: SecretPolicy,
): Promise<{ values: Record<string, string>; envRefs: string[] }> {
  const secrets = allSecrets(cfg);
  const values: Record<string, string> = {};
  const envRefs: string[] = [];

  if (policy === 'env-ref') {
    for (const s of secrets) {
      if (isSet(ctx.env[s.name])) ctx.log.debug(`${cfg.name}: ${s.name} is set in the environment`);
      else envRefs.push(s.name);
    }
    return { values, envRefs };
  }

  const missingRequired: SecretRef[] = [];
  for (const s of secrets) {
    const fromEnv = ctx.env[s.name];
    if (isSet(fromEnv)) {
      values[s.name] = fromEnv;
      ctx.log.debug(`${cfg.name}: using ${s.name} from the environment`);
      continue;
    }
    if (!ctx.ui.isInteractive) {
      if (s.required) missingRequired.push(s);
      else envRefs.push(s.name);
      continue;
    }
    const label = s.description ? `${s.name} (${s.description})` : s.name;
    const answer = (await ctx.ui.secret(label)).trim();
    if (answer) {
      values[s.name] = answer;
      continue;
    }
    if (s.required) {
      throw new PalmError(
        'E_USAGE',
        `A value for ${s.name} is required by MCP server ${cfg.name}`,
        `export ${s.name}=... or use --secrets env-ref`,
      );
    }
    ctx.log.debug(`${cfg.name}: skipped optional ${s.name}`);
    envRefs.push(s.name);
  }

  if (missingRequired.length) {
    const names = missingRequired.map((s) => s.name);
    throw new PalmError(
      'E_NON_INTERACTIVE',
      `MCP server ${cfg.name} needs ${names.join(', ')}, which ${names.length === 1 ? 'is' : 'are'} not set and cannot be prompted for without a terminal`,
      `${names.map((n) => `export ${n}=...`).join('; ')} or use --secrets env-ref`,
    );
  }
  return { values, envRefs };
}
