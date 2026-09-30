/**
 * Shared pieces of `palm check`: the context every check reads (the scope, the lock entries
 * rendered again from the cache, whether the scope is in a git repository) and the builder of
 * one check's result.
 */
import type { CheckProblem, CheckRun, LockEntry } from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import type { Run } from './jobs.js';
import type { RenderOutput } from './render.js';
import { renderLocked } from './verify.js';

export interface CheckContext {
  run: Run;
  /** The scope is inside a git repository (project scope only). */
  git: boolean;
  /** Each lock entry rendered again as locked; undefined when palm cannot render it. */
  renders: Map<string, RenderOutput | undefined>;
  /** Local sources whose tree differs from the lock (their entries are reported there, not twice). */
  driftedSources: Set<string>;
}

export interface Found {
  fail: CheckProblem[];
  warn: CheckProblem[];
}

export const found = (): Found => ({ fail: [], warn: [] });

export interface Labels {
  ok: string;
  bad: (n: number) => string;
}

/** Problems once each: a file two targets share (a closure script) is one problem, not two. */
function unique(list: readonly CheckProblem[]): CheckProblem[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const e = p.entity;
    const key = [e?.kind, e?.name, e?.source, p.file, p.message].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One check's result: `fail` when any failing problem, else `warn` when any warning, else `ok`. */
export function checkRun(id: string, labels: Labels, f: Found): CheckRun {
  const problems = unique([...f.fail, ...f.warn]);
  let status: CheckRun['status'] = 'ok';
  if (f.fail.length) status = 'fail';
  else if (f.warn.length) status = 'warn';
  return { id, label: problems.length ? labels.bad(problems.length) : labels.ok, status, problems };
}

/** A check that needs git, listed as skipped outside a repository. */
export function skipped(id: string, what: string): CheckRun {
  return { id, label: `${what}: skipped (not a git repository)`, status: 'ok', problems: [] };
}

export function entityOf(e: LockEntry): CheckProblem['entity'] {
  return { kind: e.kind, name: e.name, source: e.source };
}

/** `n thing` / `n things`. */
export function count(n: number, word: string, plural = `${word}s`): string {
  return `${n} ${n === 1 ? word : plural}`;
}

/** Renders every installed entry once, for the checks that compare the disk with the render. */
export async function renderAll(run: Run): Promise<Map<string, RenderOutput | undefined>> {
  const out = new Map<string, RenderOutput | undefined>();
  for (const e of run.state.lock.entries) {
    if (e.declined || e.kind === 'plugin') continue;
    out.set(lockId(e), await renderLocked(run, e).catch(() => undefined));
  }
  return out;
}
