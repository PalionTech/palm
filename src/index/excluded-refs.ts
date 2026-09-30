/**
 * References from the kept members of a plugin to the members palm.yaml excludes (ruling M8):
 * a kept skill that says `Use superpowers:subagent-driven-development`, an agent that preloads an
 * excluded skill, and a hook whose closure reads an excluded skill's files (the SessionStart hook
 * that injects `skills/using-superpowers/SKILL.md`). `describe` notes the first two; the third is
 * a notice at install, since the excluded text still reaches the model.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Closure, Entity } from '../core/types.js';
import { isCommandSkill } from './entity-registry.js';

/** One reference from a kept member to an excluded one. */
export interface ExcludedReference {
  /** The kept member: `skill writing-plans`, `hook superpowers`. */
  from: string;
  /** The excluded member: `skill subagent-driven-development`. */
  to: string;
  /** How it refers: a `<plugin>:<name>` mention, a preload, or a file its closure reads. */
  how: 'mention' | 'preload' | 'reads';
  /** The mention or the path read. */
  what: string;
}

const label = (e: Entity): string => `${e.kind} ${e.name}`;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The file that holds a member's text: a skill's SKILL.md, else the entity's own file. */
function textFile(e: Entity): string | undefined {
  if (e.kind === 'skill') return isCommandSkill(e) ? e.path : join(e.path, 'SKILL.md');
  return e.kind === 'agent' || e.kind === 'instruction' ? e.path : undefined;
}

function mentions(text: string, plugin: string, excluded: readonly Entity[], from: Entity) {
  const out: ExcludedReference[] = [];
  for (const x of excluded) {
    const token = `${plugin}:${x.name}`;
    if (new RegExp(`(?<![\\w-])${escapeRe(token)}(?![\\w-])`).test(text))
      out.push({ from: label(from), to: label(x), how: 'mention', what: token });
  }
  return out;
}

function preloads(e: Entity, plugin: string, excluded: readonly Entity[]): ExcludedReference[] {
  if (e.def.kind !== 'agent') return [];
  const listed = new Set(e.def.agent.skills ?? []);
  return excluded
    .filter((x) => x.kind === 'skill' && (listed.has(x.name) || listed.has(`${plugin}:${x.name}`)))
    .map((x) => ({ from: label(e), to: label(x), how: 'preload' as const, what: x.name }));
}

/** `<plugin>:<name>` mentions and agent preloads of excluded members in the kept members' text. */
export async function excludedMentions(
  root: string,
  plugin: string,
  members: { kept: readonly Entity[]; excluded: readonly Entity[] },
): Promise<ExcludedReference[]> {
  const out: ExcludedReference[] = [];
  for (const e of members.kept) {
    out.push(...preloads(e, plugin, members.excluded));
    const file = textFile(e);
    const text = file && (await readFile(join(root, file), 'utf8').catch(() => undefined));
    if (text) out.push(...mentions(text, plugin, members.excluded, e));
  }
  return out;
}

const within = (p: string, dir: string): boolean => p === dir || p.startsWith(`${dir}/`);

/**
 * Excluded members whose files a hook's closure copies or reads (`closure` defaults to the one
 * the index resolved; pass the one with `reads` the exec analysis added).
 */
export function hookReadsExcluded(
  hook: Entity,
  excluded: readonly Entity[],
  closure?: Closure,
): ExcludedReference[] {
  const own = hook.def.kind === 'hook' ? hook.def.hooks.closure : undefined;
  const c = closure ?? own;
  if (!c) return [];
  const paths = [...new Set([...(c.reads ?? []), ...c.paths])];
  const out: ExcludedReference[] = [];
  for (const x of excluded)
    for (const p of paths.filter((q) => within(q, x.path) || within(x.path, q)))
      out.push({ from: label(hook), to: label(x), how: 'reads', what: p });
  return out;
}

/** The line `describe` or the install prints for one reference. */
export function excludedReferenceNote(r: ExcludedReference): string {
  if (r.how === 'mention') return `${r.from} mentions ${r.what}, which palm.yaml excludes`;
  if (r.how === 'preload') return `${r.from} preloads ${r.to}, which palm.yaml excludes`;
  return `${r.from} reads ${r.what} of the excluded ${r.to}; its text still reaches the model`;
}
