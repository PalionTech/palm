/**
 * The scope's targets: palm.yaml `targets:`, else the harnesses detected in the scope
 * (DESIGN §6 step 4). An entry narrows the scope's set with its own `targets:`.
 */
import { PalmError } from '../core/errors.js';
import {
  type EngineDeps,
  type InstallOptions,
  type ManifestEntryObject,
  type PalmContext,
  TARGET_IDS,
  type TargetId,
} from '../core/types.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { palmCommand } from './report.js';
import type { ScopeState } from './scope.js';

/** Harnesses that appear to be in use at the scope, in TARGET_IDS order. */
export async function detectTargets(
  ctx: PalmContext,
  paths: ScopePaths,
  deps: EngineDeps,
): Promise<TargetId[]> {
  const found: TargetId[] = [];
  for (const id of TARGET_IDS)
    if (await deps.getTarget(id).detect(paths.scope, paths.root, ctx.env)) found.push(id);
  return found;
}

/** `ids` in TARGET_IDS order, without duplicates. */
function orderTargets(ids: Iterable<TargetId>): TargetId[] {
  const set = new Set(ids);
  return TARGET_IDS.filter((t) => set.has(t));
}

/** The scope's target set narrowed by the entry's `targets:`. */
export function activeTargets(state: ScopeState, entry?: ManifestEntryObject): TargetId[] {
  const narrowed = entry?.targets;
  if (!narrowed?.length) return [...state.targets];
  return state.targets.filter((t) => narrowed.includes(t));
}

/** The lock entry's `targets` field: present only when narrowed below the scope's set. */
export function narrowedTargets(state: ScopeState, targets: TargetId[]): TargetId[] | undefined {
  return state.targets.every((t) => targets.includes(t)) ? undefined : orderTargets(targets);
}

/** `--local` (palm.local.yaml) arrives in 0.3. */
export function refuseLocal(opts: InstallOptions): void {
  if (opts.local)
    throw new PalmError(
      'E_USAGE',
      'palm.local.yaml arrives in 0.3',
      'run the command without --local',
    );
}

/** The scope's targets, narrowed by `--targets`; none at all is E_USAGE naming `palm init`. */
export function requestTargets(state: ScopeState, requested?: TargetId[]): TargetId[] | undefined {
  if (!state.targets.length)
    throw new PalmError(
      'E_USAGE',
      'no target: palm.yaml names none and no harness directory was found',
      palmCommand('init', ['--target', 'claude'], state.paths.scope),
    );
  const outside = (requested ?? []).filter((t) => !state.targets.includes(t));
  if (outside.length)
    throw new PalmError(
      'E_USAGE',
      `${outside.join(', ')} is not among the targets in palm.yaml (${state.targets.join(', ')})`,
      'add it to targets: in palm.yaml, then run the command again',
    );
  return requested?.length ? requested : undefined;
}

/** A target the lock rendered entries for that the scope's targets no longer list (B2). */
export interface DroppedTarget {
  target: TargetId;
  /** Lock paths and `file#at#key` fragments that `palm install` will remove for it. */
  files: string[];
  /** How many lock entries were rendered for it. */
  entries: number;
}

function insideAny(lockPath: string, dirs: readonly string[]): boolean {
  return dirs.some((d) => lockPath === d || lockPath.startsWith(`${d}/`));
}

/**
 * B2: the targets palm.yaml dropped (`targets: [claude, codex]` → `[claude]`) with what the next
 * `palm install` removes for each: the lock paths and fragments inside that target's output
 * directories that no remaining target's directories hold. `check` reports them; nothing is
 * written.
 */
export function droppedTargets(
  ctx: PalmContext,
  deps: EngineDeps,
  state: ScopeState,
): DroppedTarget[] {
  const { scope, root } = state.paths;
  const dirsOf = (t: TargetId) => deps.getTarget(t).outputDirs(scope, root, ctx.env);
  const staying = state.targets.flatMap(dirsOf);
  const out: DroppedTarget[] = [];
  for (const target of TARGET_IDS.filter((t) => !state.targets.includes(t))) {
    const entries = state.lock.entries.filter((e) => target in e.render);
    if (!entries.length) continue;
    const own = dirsOf(target);
    const goes = (p: string) => insideAny(p, own) && !insideAny(p, staying);
    const files = entries.flatMap((e) => [
      ...e.files.filter(goes),
      ...(e.merged ?? []).filter((m) => goes(m.file)).map((m) => `${m.file}#${m.at}#${m.key}`),
    ]);
    out.push({ target, files: [...new Set(files)].sort(), entries: entries.length });
  }
  return out;
}
