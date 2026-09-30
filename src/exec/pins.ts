/**
 * B11: a command that fetches its program at run time (`npx -y pkg@latest`, `uvx pkg`, `bunx
 * pkg`, `pnpm dlx pkg`) without an exact version runs whatever the registry serves that day:
 * the consent pins the command line, not the package. The review says so beside the unit.
 */
import type { ExecUnit } from '../core/types.js';

/** `npx`, `bunx`, `pnpx`, `uvx`, and the two-word forms `pnpm dlx`, `yarn dlx`, `npm exec`. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx']);
const TWO_WORD = new Set(['pnpm dlx', 'yarn dlx', 'npm exec']);
const PACKAGE_FLAGS = new Set(['-p', '--package', '--from']);
const EXACT = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The runner at `i` of `words` (`npx`, `pnpm dlx`) and how many words it takes. */
function runnerAt(words: readonly string[], i: number): [string, number] | undefined {
  const w = words[i]?.replace(/^.*\//, '') ?? '';
  if (RUNNERS.has(w)) return [w, 1];
  const two = `${w} ${words[i + 1] ?? ''}`;
  return TWO_WORD.has(two) ? [two, 2] : undefined;
}

/** The package the runner fetches: a `--package`/`--from` value, else its first operand. */
function packageAfter(words: readonly string[], from: number): string | undefined {
  for (let i = from; i < words.length; i++) {
    const w = words[i] ?? '';
    const [flag, inline] = w.split(/=(.*)/s, 2);
    if (flag && PACKAGE_FLAGS.has(flag)) return inline ?? words[i + 1];
    if (!w.startsWith('-')) return w;
  }
  return undefined;
}

/** `pkg@1.2.3` / `@scope/pkg@1.2.3` / `pkg==1.2.3` → name and version (undefined when none). */
function splitSpec(spec: string): { name: string; version?: string } {
  const py = /^([^=<>~!]+)==(.+)$/.exec(spec);
  if (py?.[1] && py[2]) return { name: py[1], version: py[2] };
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { name: spec };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/** The review line for one command, or undefined when it pins what it runs. */
export function unpinnedLine(command: string): string | undefined {
  const words = command.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const runner = runnerAt(words, i);
    if (!runner) continue;
    const spec = packageAfter(words, i + runner[1]);
    if (!spec) return undefined;
    const { name, version } = splitSpec(spec.replace(/^["']|["']$/g, ''));
    if (version && EXACT.test(version)) return undefined;
    return `unpinned: ${runner[0]} resolves ${name}@${version ?? 'latest'} at run time; pin an exact version to review what runs`;
  }
  return undefined;
}

/** The unpinned lines of a unit's commands, once each. */
export function unpinnedLines(unit: ExecUnit): string[] {
  const lines = unit.commands.flatMap((c) => unpinnedLine(c.canonical) ?? []);
  return [...new Set(lines)];
}
