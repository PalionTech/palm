/**
 * Secret resolution for MCP server configs (DESIGN.md §7): environment lookup and masked
 * prompts. Which placeholders are secrets is decided in domain/secrets. Secret values are never
 * logged.
 */
import { PalmError } from '../core/errors.js';
import type { McpServerConfig, PalmContext, SecretPolicy, SecretRef } from '../core/types.js';
import { allSecrets } from '../domain/secrets.js';

export { detectSecrets } from '../domain/secrets.js';

function isSet(v: string | undefined): v is string {
  return v !== undefined && v !== '';
}

/** `env-ref`: nothing is read or prompted; lists the secrets not currently exported. */
function unexported(ctx: PalmContext, cfg: McpServerConfig, secrets: SecretRef[]): string[] {
  const envRefs: string[] = [];
  for (const s of secrets) {
    if (isSet(ctx.env[s.name])) ctx.log.debug(`${cfg.name}: ${s.name} is set in the environment`);
    else envRefs.push(s.name);
  }
  return envRefs;
}

/**
 * `literal`: the value of `s` from the environment, else from a masked prompt (interactive).
 * Undefined when there is none (no terminal, or an optional secret skipped with an empty
 * answer); an empty answer for a required secret → E_USAGE.
 */
async function literalValue(
  ctx: PalmContext,
  cfg: McpServerConfig,
  s: SecretRef,
): Promise<string | undefined> {
  const fromEnv = ctx.env[s.name];
  if (isSet(fromEnv)) {
    ctx.log.debug(`${cfg.name}: using ${s.name} from the environment`);
    return fromEnv;
  }
  if (!ctx.ui.isInteractive) return undefined;
  const label = s.description ? `${s.name} (${s.description})` : s.name;
  const answer = (await ctx.ui.secret(label)).trim();
  if (answer) return answer;
  if (s.required) {
    throw new PalmError(
      'E_USAGE',
      `A value for ${s.name} is required by MCP server ${cfg.name}`,
      `export ${s.name}=... or use --secrets env-ref`,
    );
  }
  ctx.log.debug(`${cfg.name}: skipped optional ${s.name}`);
  return undefined;
}

function missingWithoutTerminal(cfg: McpServerConfig, names: string[]): PalmError {
  return new PalmError(
    'E_NON_INTERACTIVE',
    `MCP server ${cfg.name} needs ${names.join(', ')}, which ${names.length === 1 ? 'is' : 'are'} not set and cannot be prompted for without a terminal`,
    `${names.map((n) => `export ${n}=...`).join('; ')} or use --secrets env-ref`,
  );
}

/**
 * Decide how each secret of `cfg` (`allSecrets`) is supplied.
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
  if (policy === 'env-ref') return { values: {}, envRefs: unexported(ctx, cfg, secrets) };

  const values: Record<string, string> = {};
  const envRefs: string[] = [];
  const missingRequired: string[] = [];
  for (const s of secrets) {
    const value = await literalValue(ctx, cfg, s);
    if (value !== undefined) values[s.name] = value;
    else if (s.required && !ctx.ui.isInteractive) missingRequired.push(s.name);
    else envRefs.push(s.name);
  }
  if (missingRequired.length) throw missingWithoutTerminal(cfg, missingRequired);
  return { values, envRefs };
}
