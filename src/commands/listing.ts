/**
 * `palm install <source>` without names (PLAN.md §4.9, Nora's second command): what the source
 * offers, programs marked, and the pasteable next line. Nothing is saved.
 *
 *   obra/superpowers  v4.0.3 (a1b2c3d)   15 skills, 1 hook
 *     skill  brainstorming             Explore requirements before writing code
 *     hook   session-start             claude: SessionStart -> hooks/run-hook.cmd   (a program; asks before installing)
 *   Nothing written. Install some:
 *       palm install obra/superpowers brainstorming test-driven-development
 *       palm install obra/superpowers --all
 */
import { type Entity, KINDS, type SourceCheckout } from '../core/types.js';
import type { SourceListing } from '../create/engine.js';
import { isRecord } from '../lib/object.js';
import { padVisible, shortHash, truncate } from '../ui/format.js';
import type { Output } from '../ui/output.js';
import { PLUGIN_ROOT_TOKENS, pluralize } from './ports.js';

const PROGRAM = '(a program; asks before installing)';
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'node', 'python', 'python3', 'deno', 'bun']);

/** The entities a person installs: every kind but plugins, grouped by kind in KINDS order. */
function listable(entities: readonly Entity[]): Entity[] {
  return KINDS.filter((k) => k !== 'plugin').flatMap((k) => entities.filter((e) => e.kind === k));
}

function versionOf(c: SourceCheckout): string {
  if (c.sha) return `${c.ref ?? ''} (${shortHash(c.sha)})`.trim();
  return c.tree ? `working tree (${shortHash(c.tree)})` : 'working tree';
}

function countsOf(entities: Entity[]): string {
  const counts = KINDS.map((k) => [k, entities.filter((e) => e.kind === k).length] as const);
  const shown = counts.filter(([, n]) => n > 0).map(([k, n]) => `${n} ${pluralize(k, n)}`);
  return shown.length ? shown.join(', ') : 'nothing palm can install';
}

const unquote = (w: string) => w.replace(/^["']|["']$/g, '');

/** The program a hook command runs: `hooks/run-hook.cmd` for `"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd"`. */
function programOf(command: string): string {
  const words = command.split(/\s+/).map(unquote).filter(Boolean);
  const word = INTERPRETERS.has(words[0] ?? '') && words[1] ? words[1] : (words[0] ?? '');
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

/** Two names to try: the first entities that are not programs. */
function suggestedNames(entities: Entity[], executable: (e: Entity) => boolean): string[] {
  return entities
    .filter((e) => !executable(e))
    .slice(0, 2)
    .map((e) => e.name);
}

export function printListing(
  out: Output,
  listed: SourceListing,
  executable: (e: Entity) => boolean,
): void {
  const entities = listable(listed.index.entities);
  const name = listed.source.name;
  out.out(`${name}  ${versionOf(listed.checkout)}   ${countsOf(entities)}`);
  const kw = Math.max(0, ...entities.map((e) => e.kind.length));
  const nw = Math.max(0, ...entities.map((e) => e.name.length));
  for (const e of entities) {
    const summary = entitySummary(e, executable(e));
    const line = `  ${padVisible(e.kind, kw)}  ${padVisible(e.name, nw)}   ${summary}`;
    out.out(line.trimEnd());
  }
  if (!entities.length) return;
  out.out('Nothing written. Install some:');
  const names = suggestedNames(entities, executable);
  if (names.length) out.out(`    palm install ${name} ${names.join(' ')}`);
  out.out(`    palm install ${name} --all`);
}

/** The listing as data (`--json`). */
export function listingJson(listed: SourceListing, executable: (e: Entity) => boolean) {
  return {
    source: listed.source.name,
    declared: listed.declared,
    ref: listed.checkout.ref,
    sha: listed.checkout.sha,
    tree: listed.checkout.tree,
    entities: listable(listed.index.entities).map((e) => ({
      kind: e.kind,
      name: e.name,
      description: e.description,
      version: e.version,
      executable: executable(e),
    })),
    warnings: listed.index.warnings,
  };
}
