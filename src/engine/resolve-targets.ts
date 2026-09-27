import { saveConfig } from '../core/config.js';
import { PalmError } from '../core/errors.js';
import { loadManifest, saveManifest } from '../core/manifest.js';
import { manifestPath, scopeRoot } from '../core/paths.js';
import { TARGET_IDS, type PalmContext, type Scope, type TargetId } from '../core/types.js';
import { resolveEngineDeps, type EngineDeps } from './deps.js';

function validate(ids: readonly string[], where: string): TargetId[] {
  const out: TargetId[] = [];
  for (const raw of ids) {
    const id = raw.trim().toLowerCase();
    if (!(TARGET_IDS as readonly string[]).includes(id)) {
      throw new PalmError('E_USAGE', `Unknown target "${raw}" in ${where}`, `Valid targets: ${TARGET_IDS.join(', ')}`);
    }
    if (!out.includes(id as TargetId)) out.push(id as TargetId);
  }
  return out;
}

/**
 * Targets for an operation: --target flag > manifest `targets` (project) >
 * config default > detection > interactive multiselect (saved when `save`).
 */
export async function resolveTargets(
  ctx: PalmContext,
  opts: { scope: Scope; flag?: TargetId[]; save?: boolean },
  depsIn?: Partial<EngineDeps>,
): Promise<TargetId[]> {
  if (opts.flag?.length) return validate(opts.flag, '--target');

  if (opts.scope === 'project') {
    const m = await loadManifest(manifestPath(ctx.paths, 'project'));
    if (m.targets?.length) return validate(m.targets, 'palm.yaml');
  }
  if (ctx.config.targets?.length) return validate(ctx.config.targets, 'config.yaml');

  const deps = await resolveEngineDeps(depsIn, { targets: true });
  const root = scopeRoot(ctx.paths, opts.scope);
  const detected = await Promise.all(
    TARGET_IDS.map(async (id) => {
      try {
        return (await deps.getTarget(id).detect(opts.scope, root, ctx.env)) ? id : undefined;
      } catch (e) {
        ctx.log.debug(`target ${id} detection failed: ${(e as Error).message}`);
        return undefined;
      }
    }),
  );
  const found = detected.filter((x): x is TargetId => !!x);
  if (found.length) {
    ctx.log.debug(`detected targets: ${found.join(', ')}`);
    return found;
  }

  if (!ctx.ui.isInteractive) {
    throw new PalmError(
      'E_TARGET',
      `No coding harness detected ${opts.scope === 'global' ? 'in your home directory' : 'in this project'}`,
      '--target claude,codex (or set `targets:` in palm.yaml / `palm config set targets claude,codex`)',
    );
  }
  const picked = await ctx.ui.pickMany(
    'Which harnesses should palm install into?',
    TARGET_IDS.map((id) => {
      const t = deps.getTarget(id);
      let hint: string | undefined;
      try {
        hint = t.configDir(opts.scope, root, ctx.env);
      } catch {
        hint = undefined;
      }
      return { value: id, label: t.displayName, ...(hint ? { hint } : {}) };
    }),
    [],
  );
  if (!picked.length) throw new PalmError('E_TARGET', 'No target selected', '--target claude,codex');
  const targets = validate(picked, 'selection');
  if (opts.save && !ctx.flags.dryRun) {
    if (opts.scope === 'project') {
      const file = manifestPath(ctx.paths, 'project');
      const m = await loadManifest(file);
      await saveManifest(file, { ...m, targets });
    } else {
      ctx.config.targets = targets;
      await saveConfig(ctx.paths, ctx.config);
    }
  }
  return targets;
}
