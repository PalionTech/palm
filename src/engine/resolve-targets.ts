import { saveConfig } from '../core/config.js';
import { messageOf, PalmError } from '../core/errors.js';
import { loadManifest, saveManifest } from '../core/manifest.js';
import { manifestPath, scopeRoot } from '../core/paths.js';
import { type PalmContext, type Scope, TARGET_IDS, type TargetId } from '../core/types.js';
import { type EngineDeps, resolveEngineDeps } from './deps.js';

function validate(ids: readonly string[], where: string): TargetId[] {
  const out: TargetId[] = [];
  for (const raw of ids) {
    const id = raw.trim().toLowerCase();
    if (!(TARGET_IDS as readonly string[]).includes(id)) {
      throw new PalmError(
        'E_USAGE',
        `Unknown target "${raw}" in ${where}`,
        `Valid targets: ${TARGET_IDS.join(', ')}`,
      );
    }
    if (!out.includes(id as TargetId)) out.push(id as TargetId);
  }
  return out;
}

/** Persist targets: `targets:` in palm.yaml (project) or config.yaml (global), when they differ. */
async function saveTargets(ctx: PalmContext, scope: Scope, targets: TargetId[]): Promise<void> {
  if (ctx.flags.dryRun) return;
  const same = (a: readonly string[] | undefined): boolean =>
    !!a && a.length === targets.length && a.every((t, i) => t === targets[i]);
  if (scope === 'project') {
    const file = manifestPath(ctx.paths, 'project');
    const m = await loadManifest(file);
    if (same(m.targets)) return;
    await saveManifest(file, { ...m, targets });
    ctx.log.debug(`saved targets ${targets.join(', ')} to ${file}`);
  } else {
    if (same(ctx.config.targets)) return;
    ctx.config.targets = targets;
    await saveConfig(ctx.paths, ctx.config);
    ctx.log.debug('saved targets to config.yaml');
  }
}

/**
 * Targets for an operation: --target flag > manifest `targets` (project) >
 * config default > detection > interactive multiselect. With `save`, an explicit
 * flag or an interactive pick is persisted (palm.yaml for project scope,
 * config.yaml for global) when it differs from what is stored.
 */
export async function resolveTargets(
  ctx: PalmContext,
  opts: { scope: Scope; flag?: TargetId[]; save?: boolean },
  depsIn?: Partial<EngineDeps>,
): Promise<TargetId[]> {
  if (opts.flag?.length) {
    const targets = validate(opts.flag, '--target');
    if (opts.save) await saveTargets(ctx, opts.scope, targets);
    return targets;
  }

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
        ctx.log.debug(`target ${id} detection failed: ${messageOf(e)}`);
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
  if (!picked.length)
    throw new PalmError('E_TARGET', 'No target selected', '--target claude,codex');
  const targets = validate(picked, 'selection');
  if (opts.save) await saveTargets(ctx, opts.scope, targets);
  return targets;
}
