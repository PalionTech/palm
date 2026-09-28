import type { Command } from 'commander';
import pc from 'picocolors';
import type { PalmConfig } from '../core/types.js';
import {
  type GlobalOptions,
  makeContext,
  parseSecretPolicy,
  parseTargetList,
  printJson,
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
  throw usage(`unknown config key "${key}"`, `keys: ${CONFIG_KEYS.join(', ')}`);
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

export function registerConfig(program: Command): void {
  const config = program
    .command('config')
    .summary('read or change global settings')
    .description(`Read or change palm's global config (${CONFIG_KEYS.join(', ')}).`);

  config
    .command('get')
    .description('Print one config value, or all of them.')
    .argument('[key]', CONFIG_KEYS.join(' | '))
    .action(async (key: string | undefined, _opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = await makeContext(g);
      const { loadConfig } = await import('../core/config.js');
      const cfg = await loadConfig(ctx.paths);
      if (key !== undefined) {
        const k = assertKey(key);
        const v = getConfigValue(cfg, k);
        if (g.json) return printJson({ [k]: v ?? null });
        if (v !== undefined) console.log(v);
        return;
      }
      const all = Object.fromEntries(CONFIG_KEYS.map((k) => [k, getConfigValue(cfg, k) ?? null]));
      if (g.json) return printJson(all);
      for (const [k, v] of Object.entries(all))
        console.log(`${k.padEnd(16)}${v ?? pc.dim('(unset)')}`);
    });

  config
    .command('set')
    .description('Set a config value (an empty value unsets it).')
    .argument('<key>', CONFIG_KEYS.join(' | '))
    .argument('<value>', 'targets: comma list; secrets.*: env-ref | literal; mcpRegistryUrl: URL')
    .action(async (key: string, value: string, _opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const k = assertKey(key);
      const ctx = await makeContext(g);
      const { loadConfig, saveConfig } = await import('../core/config.js');
      const next = setConfigValue(await loadConfig(ctx.paths), k, value);
      const shown = getConfigValue(next, k);
      if (ctx.flags.dryRun) {
        console.log(`would set ${k} = ${shown ?? '(unset)'}`);
        return;
      }
      await saveConfig(ctx.paths, next);
      ctx.log.success(shown === undefined ? `unset ${k}` : `${k} = ${shown}`);
    });
}
