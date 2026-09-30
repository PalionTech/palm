/**
 * Index notes a person installing from a source must see (rulings N1, R1', R10', S5): the near
 * misses (`2 agent-shaped files not indexed: people/*.md`), a SKILL.md under an ignored name, a
 * layout glob that matches nothing, the `apm.yml` dependencies palm does not follow, and links
 * leaving the source. The listing and the install print these lines; every other scan warning
 * stays behind the one count line (ruling L15). A layout suggestion reads as `layout:` for a
 * source palm.yaml declares, and as `--layout` flags on the install line for one it does not.
 */

/** Where the notes are printed: a declared source, or the install line of an undeclared one. */
export interface NoteView {
  /** palm.yaml declares the source, so a suggestion names its `layout:`. */
  declared: boolean;
  /** `palm install <source as typed> <args…>` (-g, `--as` and `#ref` kept), for an undeclared source. */
  install?: (args: readonly string[]) => string;
}

export interface IndexNotes {
  /** Lines to print as they are, one note each. */
  shown: string[];
  /** Every other scan warning: the count line and `describe source` cover them. */
  rest: string[];
}

const NEAR_MISS = /^(\d+ (?:agent|hook|MCP)-shaped files? not indexed: .*); add layout: (\{.*\})$/;
const SKIPPED_SKILL = /^(skipped \S+) \(ignored name "([^"]+)"; add layout: (\{.*\})\)$/;
const ZERO_MATCH = /^layout \w+: ".*" matches nothing in the source$/;
const DEPENDENCIES = /^apm\.ya?ml: \d+ (?:MCP server )?dependenc(?:y is|ies are) not installed/;
const LINKS_LEAVING = /^not copied \((?:a link|links) leaving the source\): /;

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** A word as it is typed in a shell: quoted when it holds a glob or a space. */
export function shellWord(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** `{ skills: [packages/*], agents: [people/*.md] }` as `--layout skills=packages/*` arguments. */
export function layoutFlagsOf(layout: string): string[] {
  const args: string[] = [];
  for (const m of layout.matchAll(/(\w+): \[([^\]]*)\]/g)) {
    const globs = (m[2] ?? '').split(', ').filter((g) => g !== '');
    if (globs.length) args.push('--layout', `${m[1]}=${globs.join(',')}`);
  }
  return args;
}

/** The line that applies a suggested layout: `layout:` in palm.yaml, or the install line with flags. */
function suggestion(layout: string, view: NoteView): string {
  if (view.declared) return `add layout: ${layout}`;
  const args = layoutFlagsOf(layout);
  if (view.install) return `to index them: ${view.install(args)}`;
  const flags = args.map((a) => (a === '--layout' ? a : shellWord(a))).join(' ');
  return `to index them, add ${flags}`;
}

/** Near-miss lines share one suggested layout: the lines, then that suggestion once. */
function nearMisses(lines: readonly string[], view: NoteView): string[] {
  const out: string[] = [];
  let layout: string | undefined;
  for (const line of lines) {
    const m = NEAR_MISS.exec(line);
    if (!m) continue;
    out.push(m[1] as string);
    layout = m[2];
  }
  return layout === undefined ? out : [...out, suggestion(layout, view)];
}

function skippedSkill(line: string, view: NoteView): string | undefined {
  const m = SKIPPED_SKILL.exec(line);
  if (!m) return undefined;
  return `${m[1]} (ignored name "${m[2]}"); ${suggestion(m[3] as string, view)}`;
}

/** True for a warning the listing and the install print in full. */
function isShownNote(line: string): boolean {
  return [NEAR_MISS, SKIPPED_SKILL, ZERO_MATCH, DEPENDENCIES, LINKS_LEAVING].some((re) =>
    re.test(line),
  );
}

/**
 * The scan warnings split into the notes printed in full (in scan order, layout suggestions
 * rewritten for the view) and the rest.
 */
export function indexNotes(warnings: readonly string[], view: NoteView): IndexNotes {
  const shown: string[] = [];
  const rest: string[] = [];
  for (const w of warnings) {
    if (!isShownNote(w)) rest.push(w);
    else if (!NEAR_MISS.test(w)) shown.push(skippedSkill(w, view) ?? w);
  }
  const misses = nearMisses(warnings, view);
  return { shown: [...misses, ...shown], rest };
}
