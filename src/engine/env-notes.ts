/**
 * K17: the variables a server needs, as one line per server. Each target notes what it reads
 * (`needs SLACK_TOKEN in the environment`, Codex adds `Codex forwards SLACK_BOT_TOKEN from your
 * environment: export …`); the entry keeps one merged line:
 *
 *   needs SLACK_TOKEN, SLACK_BOT_TOKEN in the environment; for Codex: export SLACK_BOT_TOKEN="${SLACK_TOKEN}"
 */
const NEEDS = /^needs (.+) in the environment$/;
const FORWARDS = /^Codex forwards \S+ from your environment: (export .+)$/;

function addNew(list: string[], items: readonly string[]): void {
  for (const i of items) if (!list.includes(i)) list.push(i);
}

/** The merged line of the variable notes, or undefined when there were none. */
function envLine(notes: readonly string[]): string | undefined {
  const names: string[] = [];
  const exports: string[] = [];
  for (const n of notes) {
    addNew(names, NEEDS.exec(n)?.[1]?.split(', ') ?? []);
    addNew(
      exports,
      [FORWARDS.exec(n)?.[1]].filter((x): x is string => x !== undefined),
    );
  }
  const codex = exports.length ? `for Codex: ${exports.join('; ')}` : '';
  if (!names.length) return codex || undefined;
  return `needs ${names.join(', ')} in the environment${codex ? `; ${codex}` : ''}`;
}

const isEnvNote = (n: string): boolean => NEEDS.test(n) || FORWARDS.test(n);

/** `notes` with the per-target variable lines merged into one, where the first of them was. */
export function mergeEnvNotes(notes: Iterable<string>): string[] {
  const all = [...notes];
  const at = all.findIndex(isEnvNote);
  const line = envLine(all);
  if (at < 0 || !line) return all;
  const rest = all.filter((n) => !isEnvNote(n));
  return [...rest.slice(0, at), line, ...rest.slice(at)];
}
