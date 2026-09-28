/** `palm config get|set`: palm's global settings in config.yaml. */
import pc from 'picocolors';
import type { PalmConfig } from '../core/types.js';
import type { App } from './app.js';
import type { Invocation } from './grammar.js';
import {
  type GlobalOptions,
  makeContext,
  parseSecretPolicy,
  parseTargetList,
  usage,
} from './shared.js';

export const CONFIG_KEYS = [
  'targets',
  'mcpRegistryUrl',
  'secrets.project',
  'secrets.global',
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

function assertKey(key: string): ConfigKey {
  if ((CONFIG_KEYS as readonly string[]).includes(key)) return key as ConfigKey;
  throw usage(
    `unknown config key "${key}"`,
    `see every key: palm config get   (keys: ${CONFIG_KEYS.join(', ')})`,
  );
}

export function getConfigValue(cfg: PalmConfig, key: ConfigKey): string | undefined {
  switch (key) {
    case 'targets':
      return cfg.targets?.length ? cfg.targets.join(',') : undefined;
    case 'mcpRegistryUrl':
      return cfg.mcpRegistryUrl;
    case 'secrets.project':
      return cfg.secrets?.project;
    case 'secrets.global':
      return cfg.secrets?.global;
  }
}

/** Return a copy of `cfg` with `key` set; an empty value (or "none" for targets) unsets it. */
export function setConfigValue(cfg: PalmConfig, key: ConfigKey, raw: string): PalmConfig {
  const value = raw.trim();
  const next: PalmConfig = { ...cfg };
  switch (key) {
    case 'targets':
      if (value === '' || value === 'none') delete next.targets;
      else next.targets = parseTargetList(value);
      break;
    case 'mcpRegistryUrl':
      if (value === '') delete next.mcpRegistryUrl;
      else {
        try {
          new URL(value);
        } catch {
          throw usage(`not a URL: ${value}`);
        }
        next.mcpRegistryUrl = value.replace(/\/+$/, '');
      }
      break;
    case 'secrets.project':
    case 'secrets.global': {
      const which = key === 'secrets.project' ? 'project' : 'global';
      const secrets = { ...(cfg.secrets ?? {}) };
      if (value === '') delete secrets[which];
      else secrets[which] = parseSecretPolicy(value);
      if (Object.keys(secrets).length) next.secrets = secrets;
      else delete next.secrets;
      break;
    }
  }
  return next;
}

async function configGet(inv: Invocation, app: App): Promise<void> {
  const g = inv.opts as GlobalOptions;
  const ctx = await makeContext(app, g);
  const { loadConfig } = await import('../core/config.js');
  const cfg = await loadConfig(ctx.paths);
  const out = app.out;
  const [key] = inv.names;
  if (key !== undefined) {
    const k = assertKey(key);
    const v = getConfigValue(cfg, k);
    if (out.jsonMode) out.json({ [k]: v ?? null });
    else if (v !== undefined) out.out(v);
    return;
  }
  const all = Object.fromEntries(CONFIG_KEYS.map((k) => [k, getConfigValue(cfg, k) ?? null]));
  if (out.jsonMode) return out.json(all);
  for (const [k, v] of Object.entries(all)) out.out(`${k.padEnd(16)}${v ?? pc.dim('(unset)')}`);
}

async function configSet(inv: Invocation, app: App): Promise<void> {
  const g = inv.opts as GlobalOptions;
  const [key = '', value = ''] = inv.names;
  const k = assertKey(key);
  const ctx = await makeContext(app, g);
  const { loadConfig, saveConfig } = await import('../core/config.js');
  const next = setConfigValue(await loadConfig(ctx.paths), k, value);
  const shown = getConfigValue(next, k);
  if (app.out.jsonMode) app.out.json({ [k]: shown ?? null, dryRun: ctx.flags.dryRun });
  if (ctx.flags.dryRun) return app.out.hint(`dry run: would set ${k} = ${shown ?? '(unset)'}`);
  await saveConfig(ctx.paths, next);
  app.out.updated(shown === undefined ? `unset ${k}` : `${k} = ${shown}`);
}

/** `palm config get [key]` and `palm config set <key> <value>`. */
export async function run(inv: Invocation, app: App): Promise<void> {
  if (inv.command === 'config set') return configSet(inv, app);
  return configGet(inv, app);
}
