import { saveConfig } from '../core/config.js';
import { messageOf, PalmError } from '../core/errors.js';
import { type PalmContext, type Scope, TARGET_IDS, type TargetId } from '../core/types.js';
import { Manifest } from '../domain/manifest.js';
import { ScopePaths } from '../domain/scope-paths.js';
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

type TargetSource = 'flag' | 'manifest' | 'config' | 'detected' | 'picked';

function sameList(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return !!a && a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Persist resolved targets so the next run (and the next developer) gets the same set:
 * `targets:` in palm.yaml (project) or config.yaml (global). Written when the store has none,
 * whatever decided them (config default, detection, a pick), and when an explicit flag or a
 * pick differs from what is stored. One info line says so. Never under --dry-run.
 */
async function persistTargets(
  ctx: PalmContext,
  scope: Scope,
  found: { targets: TargetId[]; source: TargetSource },
): Promise<void> {
  const { targets, source } = found;
  const explicit = source === 'flag' || source === 'picked';
  if (ctx.flags.dryRun) return;
  if (scope === 'project') {
    const file = ScopePaths.of(ctx, 'project').manifestFile;
    const m = await Manifest.load(file);
    if ((m.targets?.length && !explicit) || sameList(m.targets, targets)) return;
    await m.setTargets(targets).save(file);
    ctx.log.info(`saved targets ${targets.join(', ')} to palm.yaml`);
    return;
  }
  if ((ctx.config.targets?.length && !explicit) || sameList(ctx.config.targets, targets)) return;
  ctx.config.targets = targets;
  await saveConfig(ctx.paths, ctx.config);
  ctx.log.info(`saved targets ${targets.join(', ')} to config.yaml`);
}

async function detectTargets(
  ctx: PalmContext,
  scope: Scope,
  deps: EngineDeps,
): Promise<TargetId[]> {
  const { root } = ScopePaths.of(ctx, scope);
  const detected = await Promise.all(
    TARGET_IDS.map(async (id) => {
      try {
        return (await deps.getTarget(id).detect(scope, root, ctx.env)) ? id : undefined;
      } catch (e) {
        ctx.log.debug(`target ${id} detection failed: ${messageOf(e)}`);
        return undefined;
      }
    }),
  );
  return detected.filter((x): x is TargetId => !!x);
}

async function pickTargets(ctx: PalmContext, scope: Scope, deps: EngineDeps): Promise<TargetId[]> {
  if (!ctx.ui.isInteractive) {
    throw new PalmError(
      'E_TARGET',
      `No coding harness detected ${scope === 'global' ? 'in your home directory' : 'in this project'}`,
      '--target claude,codex (or set `targets:` in palm.yaml / `palm config set targets claude,codex`)',
    );
  }
  const { root } = ScopePaths.of(ctx, scope);
  const picked = await ctx.ui.pickMany(
    'Which harnesses should palm install into?',
    TARGET_IDS.map((id) => {
      const t = deps.getTarget(id);
      let hint: string | undefined;
      try {
        hint = t.configDir(scope, root, ctx.env);
      } catch {
        hint = undefined;
      }
      return { value: id, label: t.displayName, ...(hint ? { hint } : {}) };
    }),
    [],
  );
  if (!picked.length)
    throw new PalmError('E_TARGET', 'No target selected', '--target claude,codex');
  return validate(picked, 'selection');
}

/** Targets and where they came from: flag > palm.yaml > config.yaml > detection > pick. */
async function findTargets(
  ctx: PalmContext,
  opts: { scope: Scope; flag?: TargetId[] },
  depsIn?: Partial<EngineDeps>,
): Promise<{ targets: TargetId[]; source: TargetSource }> {
  if (opts.flag?.length) return { targets: validate(opts.flag, '--target'), source: 'flag' };
  if (opts.scope === 'project') {
    const m = await Manifest.load(ScopePaths.of(ctx, 'project').manifestFile);
    if (m.targets?.length) return { targets: validate(m.targets, 'palm.yaml'), source: 'manifest' };
  }
  if (ctx.config.targets?.length)
    return { targets: validate(ctx.config.targets, 'config.yaml'), source: 'config' };
  const deps = await resolveEngineDeps(depsIn, { targets: true });
  const found = await detectTargets(ctx, opts.scope, deps);
  if (found.length) {
    ctx.log.debug(`detected targets: ${found.join(', ')}`);
    return { targets: found, source: 'detected' };
  }
  return { targets: await pickTargets(ctx, opts.scope, deps), source: 'picked' };
}

/**
 * Targets for an operation: --target flag > manifest `targets` (project) > config default >
 * detection > interactive multiselect. With `save`, the result is persisted so the set does
 * not depend on the machine: palm.yaml (project) or config.yaml (global) get `targets:` when
 * they have none, and an explicit flag or a pick replaces a different stored set.
 */
export async function resolveTargets(
  ctx: PalmContext,
  opts: { scope: Scope; flag?: TargetId[]; save?: boolean },
  depsIn?: Partial<EngineDeps>,
): Promise<TargetId[]> {
  const found = await findTargets(ctx, opts, depsIn);
  if (opts.save) await persistTargets(ctx, opts.scope, found);
  return found.targets;
}
