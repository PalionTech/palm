/**
 * `palm install <source> [--grep text]` without names (PLAN.md §4.9, Nora's second command): what
 * the source offers (or what matches), programs marked, and the pasteable next line: the source
 * as the person can paste it (its key once declared, else what they typed) with the names in
 * `kind:name` form where the source offers a name in two kinds. Nothing is saved.
 *
 *   obra/superpowers  v4.0.3 (a1b2c3d)   15 skills, 1 hook
 *     skill  brainstorming             Explore requirements before writing code
 *     hook   session-start             claude: SessionStart -> hooks/run-hook.cmd   (a program; asks before installing)
 *   Nothing written. Install some:
 *       palm install obra/superpowers brainstorming test-driven-development
 *       palm install obra/superpowers --all
 */

import { pluralize } from '../core/kinds.js';
import { type Entity, KINDS, type SourceCheckout } from '../core/types.js';
import type { SourceListing } from '../create/engine.js';
import { PLUGIN_ROOT_TOKENS } from '../domain/ignore.js';
import { isRecord } from '../lib/object.js';
import { padVisible, shortHash, truncate } from '../ui/format.js';
import type { Output } from '../ui/output.js';

const PROGRAM = '(a program; asks before installing)';
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'node', 'python', 'python3', 'deno', 'bun']);
/** Package runners: the package they run names the program (`npx prettier`). */
const RUNNERS = new Set(['npx', 'uvx', 'bunx', 'pnpx']);

/** The entities a person installs: every kind but plugins, grouped by kind in KINDS order. */
function listable(entities: readonly Entity[]): Entity[] {
  return KINDS.filter((k) => k !== 'plugin').flatMap((k) => entities.filter((e) => e.kind === k));
}

/** M5, T15: the plugins of a listing, each a selector over its members. */
function pluginsOf(entities: readonly Entity[]): Entity[] {
  return entities.filter((e) => e.kind === 'plugin');
}

/** `15 skills, 1 hook`: what a plugin selects. */
function membersSummary(plugin: Entity): string {
  const members = plugin.def.kind === 'plugin' ? plugin.def.members : [];
  const counts = KINDS.map((k) => [k, members.filter((m) => m.kind === k).length] as const);
  return counts
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${pluralize(k, n)}`)
    .join(', ');
}

function versionOf(c: SourceCheckout): string {
  if (c.sha) return `${c.ref ?? ''} (${shortHash(c.sha)})`.trim();
  return c.tree ? `working tree (${shortHash(c.tree)})` : 'working tree';
}

/** `1 plugin, 15 skills, 1 hook`: plugins first (M5), then the kinds in KINDS order. */
function countsOf(entities: Entity[]): string {
  const order = ['plugin' as const, ...KINDS.filter((k) => k !== 'plugin')];
  const counts = order.map((k) => [k, entities.filter((e) => e.kind === k).length] as const);
  const shown = counts.filter(([, n]) => n > 0).map(([k, n]) => `${n} ${pluralize(k, n)}`);
  return shown.length ? shown.join(', ') : 'nothing palm can install';
}

const unquote = (w: string) => w.replace(/^["']|["']$/g, '');

/** The program a hook command runs: `hooks/run-hook.cmd` for `"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd"`. */
function programOf(command: string): string {
  const words = command.split(/\s+/).map(unquote).filter(Boolean);
  const [first = '', second] = words;
  if (RUNNERS.has(first) && second)
    return `${first} ${words.find((w, i) => i > 0 && !w.startsWith('-')) ?? second}`;
  const word = INTERPRETERS.has(first) && second ? second : first;
  return word.replace(PLUGIN_ROOT_TOKENS, '').replace(/^\/+/, '');
}

/** Every (event, command) of a hooks file, in the Claude, Cursor and Copilot shapes. */
function hookCommands(raw: unknown): Array<{ event: string; command: string }> {
  const root = isRecord(raw) && isRecord(raw.hooks) ? raw.hooks : raw;
  if (!isRecord(root)) return [];
  const found: Array<{ event: string; command: string }> = [];
  for (const [event, groups] of Object.entries(root)) {
    const list = Array.isArray(groups) ? groups : [];
    const hooks = list.flatMap((g) => (isRecord(g) && Array.isArray(g.hooks) ? g.hooks : [g]));
    for (const h of hooks) {
      const command = isRecord(h) ? (h.command ?? h.bash) : undefined;
      if (typeof command === 'string') found.push({ event, command });
    }
  }
  return found;
}

function hookSummary(e: Entity): string {
  if (e.def.kind !== 'hook') return '';
  const commands = hookCommands(e.def.hooks.raw);
  const [first] = commands;
  if (!first) return `${e.def.hooks.dialect}: text sent to the model`;
  const more = commands.length > 1 ? ` (+${commands.length - 1} more)` : '';
  return `${e.def.hooks.dialect}: ${first.event} -> ${programOf(first.command)}${more}`;
}

function mcpSummary(e: Entity): string {
  if (e.def.kind !== 'mcp') return '';
  const m = e.def.mcp;
  if (m.url) return `${m.transport}: ${m.url}`;
  return `stdio: ${[m.command, ...(m.args ?? [])].filter(Boolean).join(' ')}`;
}

/** The last column: a description, or what a hook or server runs. */
function entitySummary(e: Entity, executable: boolean): string {
  const body = hookSummary(e) || mcpSummary(e) || truncate(e.description, 70);
  return executable ? `${body}   ${PROGRAM}` : body;
}

/** How a listing names its source and filters: the paste line, and `--grep` (L12). */
export interface ListingView {
  /** `palm install <source as the person can paste it> <names…>` (K9, D9, -g). */
  line(names: readonly string[]): string;
  grep?: string;
  /** N11: the name the header shows (`--as acme`), when not the source's own. */
  title?: string;
}

/** L12: entities whose name or description holds the text (any case). */
function matching(entities: Entity[], grep: string | undefined): Entity[] {
  if (!grep) return entities;
  const q = grep.toLowerCase();
  return entities.filter((e) => `${e.name} ${e.description ?? ''}`.toLowerCase().includes(q));
}

/** `kind:name` when the source offers the name in more than one kind (R7, O4: a plugin too). */
function pasteName(e: Entity, all: readonly Entity[]): string {
  const clash = all.some((o) => o !== e && o.name === e.name && o.kind !== e.kind);
  return clash ? `${e.kind}:${e.name}` : e.name;
}

/** Two names to try: the first entities shown that are not programs. */
function suggestedNames(
  shown: Entity[],
  executable: (e: Entity) => boolean,
  all: readonly Entity[],
): string[] {
  return shown
    .filter((e) => !executable(e))
    .slice(0, 2)
    .map((e) => pasteName(e, all));
}

/** The row's last column; a name the source offers in two kinds says so (O4, T15). */
function rowSummary(e: Entity, executable: (e: Entity) => boolean, all: readonly Entity[]): string {
  const body = e.kind === 'plugin' ? membersSummary(e) : entitySummary(e, executable(e));
  const other = all.find((o) => o !== e && o.name === e.name && o.kind !== e.kind);
  return other ? `${body}   (also ${other.kind} ${other.name}: name it ${e.kind}:${e.name})` : body;
}

function printRows(
  out: Output,
  entities: Entity[],
  executable: (e: Entity) => boolean,
  all: readonly Entity[],
): void {
  const kw = Math.max(0, ...entities.map((e) => e.kind.length));
  const nw = Math.max(0, ...entities.map((e) => e.name.length));
  for (const e of entities) {
    const summary = rowSummary(e, executable, all);
    const line = `  ${padVisible(e.kind, kw)}  ${padVisible(e.name, nw)}   ${summary}`;
    out.out(line.trimEnd());
  }
}

export function printListing(
  out: Output,
  listed: SourceListing,
  executable: (e: Entity) => boolean,
  view: ListingView,
): void {
  const all = listable(listed.index.entities);
  const plugins = pluginsOf(listed.index.entities);
  const every = [...plugins, ...all];
  const entities = matching(all, view.grep);
  const counts = view.grep
    ? `${countsOf(entities)} of ${all.length} match "${view.grep}"`
    : countsOf(every);
  const title = view.title ?? listed.source.name;
  out.out(`${title}  ${versionOf(listed.checkout)}   ${counts}`);
  printRows(out, [...matching(plugins, view.grep), ...entities], executable, every);
  if (!entities.length) {
    if (view.grep) out.hint(`list everything it offers: ${view.line([])}`);
    return;
  }
  out.out('Nothing written. Install some:');
  const names = suggestedNames(entities, executable, every);
  if (names.length) out.out(`    ${view.line(names)}`);
  if (!view.grep) out.out(`    ${view.line(['--all'])}`);
}

/** The listing as data (`--json`), filtered by `--grep`. */
export function listingJson(
  listed: SourceListing,
  executable: (e: Entity) => boolean,
  view: Pick<ListingView, 'grep'> = {},
) {
  return {
    source: listed.source.name,
    declared: listed.declared,
    ref: listed.checkout.ref,
    sha: listed.checkout.sha,
    tree: listed.checkout.tree,
    entities: matching(listable(listed.index.entities), view.grep).map((e) => ({
      kind: e.kind,
      name: e.name,
      description: e.description,
      version: e.version,
      executable: executable(e),
    })),
    warnings: listed.index.warnings,
  };
}
