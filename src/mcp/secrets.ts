/**
 * Secret detection and resolution for MCP server configs (DESIGN.md §7).
 * Secret values are never logged.
 */
import { PalmError } from '../core/errors.js';
import type { McpServerConfig, PalmContext, SecretPolicy, SecretRef } from '../core/types.js';

/** `${VAR}`, `${env:VAR}`, `${VAR:-default}`, `${env:VAR:-default}`. */
const TOKEN = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Variables a harness or the OS provides at run time. They are never user secrets: the
 * scanner does not report them, `resolveSecrets` never prompts for them, and the MCP
 * renderer leaves their tokens untouched. The single list for the whole code base.
 */
export const RUNTIME_VARS: ReadonlySet<string> = new Set([
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PROJECT_DIR',
  'CURSOR_PLUGIN_ROOT',
  'PLUGIN_ROOT',
  'workspaceFolder',
  'workspaceFolderBasename',
  'workspaceRoot',
  'userHome',
  'pathSeparator',
  'HOME',
  'USER',
  'PWD',
  'PATH',
  'TMPDIR',
]);

export function isRuntimeVar(name: string): boolean {
  return RUNTIME_VARS.has(name);
}

/** Env values that are obviously "fill me in" placeholders (`""`, `<your key>`, `your-token-here`). */
export function isPlaceholderValue(value: string): boolean {
  return value === '' || /^<.*>$/.test(value) || /^your[-_ ]/i.test(value);
}

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

function scan(
  value: string,
  make: (name: string, required: boolean, token: string) => SecretRef,
  out: SecretRef[],
): void {
  for (const m of value.matchAll(TOKEN)) {
    const name = m[1] as string;
    if (isRuntimeVar(name)) continue;
    addRef(out, make(name, m[2] === undefined, m[0]));
  }
}

/**
 * `${VAR}`-style placeholders in env values, header values, the URL and args → SecretRefs.
 * A placeholder with a `:-default` is optional. For a header whose value is more than the
 * placeholder (e.g. `Bearer ${TOKEN}`), `format` records the template (`Bearer {value}`).
 * Runtime variables (`RUNTIME_VARS`) are skipped.
 */
export function detectSecrets(cfg: McpServerConfig): SecretRef[] {
  const out: SecretRef[] = [];
  for (const value of Object.values(cfg.env ?? {})) {
    if (typeof value !== 'string') continue;
    scan(value, (name, required) => ({ name, in: 'env', required }), out);
  }
  for (const [header, value] of Object.entries(cfg.headers ?? {})) {
    if (typeof value !== 'string') continue;
    const tokens = [...value.matchAll(TOKEN)];
    scan(
      value,
      (name, required, token) => {
        const ref: SecretRef = { name, in: 'header', header, required };
        if (tokens.length === 1 && value !== token) ref.format = value.replace(token, '{value}');
        return ref;
      },
      out,
    );
  }
  if (typeof cfg.url === 'string')
    scan(cfg.url, (name, required) => ({ name, in: 'env', required }), out);
  for (const arg of cfg.args ?? []) {
    if (typeof arg === 'string')
      scan(arg, (name, required) => ({ name, in: 'env', required }), out);
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
