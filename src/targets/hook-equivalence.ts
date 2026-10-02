/**
 * An equivalent hook already on disk (ruling O11): a hook entry in a shared hooks file that has
 * the matcher and the commands palm would add, once the project-dir idiom is set aside
 * (`"$CLAUDE_PROJECT_DIR/tools/x"`, `"$CLAUDE_PROJECT_DIR"/tools/x`, `./tools/x` and `tools/x`
 * run the same file from the project root). The Applier adopts such an entry instead of adding a
 * second copy beside it, and says so.
 */
import { PROJECT_DIR_TOKENS } from '../domain/ignore.js';
import { isRecord } from '../lib/object.js';

/** The project root as a hook command names it: a harness variable or the git top level. */
const ROOT = `(?:${PROJECT_DIR_TOKENS.source}|\\$\\(git rev-parse --show-toplevel[^)]*\\))`;
const QUOTED_ROOT = new RegExp(`"(${ROOT})"`, 'g');
const QUOTED_ROOT_PATH = new RegExp(`"(${ROOT}/[^"\\s]*)"`, 'g');
const ROOT_SLASH = new RegExp(`${ROOT}/`, 'g');
const DOT_SLASH = /(^|\s)\.\//g;
const QUOTED_WORD = /"([^"\s$`\\]+)"/g;

/** `command` with the project root left out and plain words unquoted: `"$CLAUDE_PROJECT_DIR/x" -v` → `x -v`. */
export function projectRelativeCommand(command: string): string {
  return command
    .replace(QUOTED_ROOT, '$1')
    .replace(QUOTED_ROOT_PATH, '$1')
    .replace(ROOT_SLASH, '')
    .replace(DOT_SLASH, '$1')
    .replace(QUOTED_WORD, '$1')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The command lines of a hook entry: a `{ matcher, hooks: [...] }` group or a flat entry. */
function commandsOf(item: Record<string, unknown>): string[] | undefined {
  const handlers = Array.isArray(item.hooks) ? item.hooks : [item];
  const out: string[] = [];
  for (const h of handlers) {
    if (!isRecord(h)) return undefined;
    const line = typeof h.command === 'string' ? h.command : h.bash;
    if (typeof line !== 'string' || (h.type !== undefined && h.type !== 'command'))
      return undefined;
    out.push(projectRelativeCommand(line));
  }
  return out.length ? out.sort() : undefined;
}

/** What makes two hook entries the same hook: the matcher and the commands, idiom set aside. */
function identityOf(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  const commands = commandsOf(item);
  if (!commands) return undefined;
  const matcher = typeof item.matcher === 'string' ? item.matcher : '';
  return JSON.stringify({ matcher, commands });
}

/** Index of the entry of `arr` equivalent to the hook entry `value`; -1 when none is. */
export function equivalentHookIndex(arr: readonly unknown[], value: unknown): number {
  const id = identityOf(value);
  return id === undefined ? -1 : arr.findIndex((item) => identityOf(item) === id);
}
