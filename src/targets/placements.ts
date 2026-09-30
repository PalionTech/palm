/**
 * Where each kind goes for one target at a scope (DESIGN §10 `describe target`): the layout's
 * directories and files in lock form, with the converters naming the files, so the rows say
 * exactly what an install writes. `<name>` stands for the entity's name.
 */
import type { Kind, TargetId } from '../core/types.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { renderAgent } from './convert-agent.js';
import { renderInstruction } from './convert-instruction.js';
import type { TargetLayout } from './layout.js';

/** One kind's place: where it lands, and how (a file per entity, a merge, a block, a gap). */
export interface Placement {
  kind: Exclude<Kind, 'plugin'>;
  where: string;
}

const NAME = '<name>';

/** A lock-form directory with its trailing slash, as tables show directories. */
function dir(lockPath: string): string {
  return lockPath.endsWith('/') ? lockPath : `${lockPath}/`;
}

function skillPlace(paths: ScopePaths, layout: TargetLayout, active: readonly TargetId[]): string {
  return `${dir(paths.lockForm(layout.skillsDir(active)))}${NAME}/`;
}

function agentPlace(paths: ScopePaths, layout: TargetLayout, id: TargetId): string {
  const { fileName } = renderAgent({ name: NAME, description: '', body: '' }, id);
  return `${dir(paths.lockForm(layout.agentsDir))}${fileName}`;
}

function instructionPlace(paths: ScopePaths, layout: TargetLayout, id: TargetId): string {
  const place = layout.instructions;
  if ('skip' in place) return `not installed: ${place.skip.replaceAll('<name>', NAME)}`;
  if ('blockFile' in place) return `a block in ${paths.lockForm(place.blockFile)}`;
  const def = { name: NAME, alwaysApply: true, activation: 'always' as const, body: '' };
  const r = renderInstruction(def, id);
  const file = 'fileName' in r ? r.fileName : `${NAME}.md`;
  return `${dir(paths.lockForm(place.dir))}${file}`;
}

function hookPlace(paths: ScopePaths, layout: TargetLayout): string {
  const place = layout.hooks;
  if ('skip' in place) return `not installed: ${place.skip.replaceAll('<name>', NAME)}`;
  if ('mergeFile' in place) return `merged into ${paths.lockForm(place.mergeFile)}`;
  return `${dir(paths.lockForm(place.dir))}${NAME}.json`;
}

function mcpPlace(paths: ScopePaths, layout: TargetLayout): string {
  const place = layout.mcp;
  if ('toml' in place) return `merged into ${paths.lockForm(place.toml)} ([mcp_servers.${NAME}])`;
  return `merged into ${paths.lockForm(place.json)} (${place.path.join('.')})`;
}

/** Every installable kind's place for the target of `layout` (skills depend on the active set). */
export function placements(
  paths: ScopePaths,
  layout: TargetLayout,
  target: { id: TargetId; active: readonly TargetId[] },
): Placement[] {
  return [
    { kind: 'skill', where: skillPlace(paths, layout, target.active) },
    { kind: 'agent', where: agentPlace(paths, layout, target.id) },
    { kind: 'instruction', where: instructionPlace(paths, layout, target.id) },
    { kind: 'hook', where: hookPlace(paths, layout) },
    { kind: 'mcp', where: mcpPlace(paths, layout) },
  ];
}
