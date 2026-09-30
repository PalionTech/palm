/**
 * O19 J13': warnings someone reviewed and acknowledged in palm.yaml's `ignore:` list stop
 * repeating: `hidden-unicode:<source>/<path>` (a zero-width character upstream ships),
 * `foreign-hooks:<file>#<event>` (a hand-written hook), `foreign-servers:<file>#<name>`. A check
 * marks each warning it allows to be acknowledged with its key (`acknowledgeable`); failures
 * never are (a critical character; a foreign program under --strict). Each such warning's fix
 * names the line that acknowledges it.
 */
import { posix } from 'node:path';
import type { CheckProblem, CheckRun, LockEntry } from '../core/types.js';
import type { CheckContext } from './check-kit.js';

const KEYS = new WeakMap<CheckProblem, string>();

/** `p`, acknowledged by the `ignore:` item `key`. */
export function acknowledgeable(p: CheckProblem, key: string): CheckProblem {
  KEYS.set(p, key);
  return p;
}

/** palm.yaml's `ignore:` list (empty until the manifest carries one). */
function acknowledged(c: CheckContext): ReadonlySet<string> {
  const { ignore } = c.run.state.manifest as { ignore?: unknown };
  return new Set(Array.isArray(ignore) ? ignore.filter((i) => typeof i === 'string') : []);
}

/** `<source>/<path in the source>` of a generated file of `e` (`kit/skills/tdd/SKILL.md`). */
export function sourcePathOf(
  e: Pick<LockEntry, 'kind' | 'name' | 'source' | 'path'>,
  file: string,
): string {
  const base = e.path.endsWith('SKILL.md') ? posix.dirname(e.path) : e.path;
  const marker = `/${e.name}/`;
  const at = file.indexOf(marker);
  if (e.kind === 'skill' && at >= 0) return `${e.source}/${base}/${file.slice(at + marker.length)}`;
  return `${e.source}/${base}`;
}

/** `run` without the warnings palm.yaml acknowledges, each other warning's fix naming its key. */
export function withoutAcknowledged(c: CheckContext, run: CheckRun): CheckRun {
  if (run.status !== 'warn') return run;
  const ignored = acknowledged(c);
  const problems = run.problems.flatMap((p) => {
    const key = KEYS.get(p);
    if (key === undefined) return [p];
    if (ignored.has(key)) return [];
    const ack = `or acknowledge it: add ${key} to ignore: in palm.yaml`;
    return [{ ...p, fix: p.fix ? `${p.fix}; ${ack}` : ack }];
  });
  if (problems.length) return { ...run, problems };
  return { ...run, status: 'ok', label: `${run.label} (acknowledged in palm.yaml)`, problems };
}
