/**
 * The hook definition files a hook's asset closure copies (rulings M8, S15). A hook's own
 * directory is copied whole, so it can hold hooks files palm renders from rather than runs:
 * the set's own file, a twin for another harness (`hooks-cursor.json` beside `hooks.json`), or
 * another hook's definition in a subfolder (`hooks/ghost/hooks.json`, refused or not). palm
 * writes each harness's hooks itself, so the asset directory keeps a definition file only when
 * it sits beside the hook's own file and is in a dialect an active target reads. A file a script
 * reads (`Closure.reads`) is always kept.
 */
import path from 'node:path';
import type { TargetId } from '../core/types.js';
import { parseJson } from '../lib/json.js';
import type { ClosureEntry } from './assets.js';
import { hookDialectsOf, hooksFileDialect } from './convert-hooks.js';

export interface HookClosureScope {
  /** The hook's own definition file (the entity's path), source-relative. */
  entityPath: string;
  /** The targets this install renders for. */
  targets: readonly TargetId[];
  /** Files a closure script reads: always copied. */
  reads?: readonly string[];
}

/** The dialect of a closure file that is a hooks definition; undefined for anything else. */
function dialectOf(f: ClosureEntry): ReturnType<typeof hooksFileDialect> {
  if (!f.rel.toLowerCase().endsWith('.json')) return undefined;
  try {
    return hooksFileDialect(parseJson(f.data.toString('utf8'), { tolerant: true }));
  } catch {
    return undefined;
  }
}

/** `files` without the hooks definition files no active target reads (see the module note). */
export function hookClosureFiles(
  files: readonly ClosureEntry[],
  scope: HookClosureScope,
): ClosureEntry[] {
  const dialects = hookDialectsOf(scope.targets);
  const ownDir = path.posix.dirname(scope.entityPath);
  const reads = new Set(scope.reads ?? []);
  return files.filter((f) => {
    const dialect = reads.has(f.rel) ? undefined : dialectOf(f);
    if (dialect === undefined) return true;
    return path.posix.dirname(f.rel) === ownDir && dialects.has(dialect);
  });
}
