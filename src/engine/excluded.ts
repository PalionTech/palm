/**
 * M8: what `palm describe` notes about the plugin members palm.yaml leaves out. A kept skill that
 * says `Use superpowers:subagent-driven-development`, or an agent that preloads an excluded
 * skill, points at text the harness will not find; describe says so. The source is read at its
 * locked commit from the cache; nothing is written.
 */
import type { LockEntry, ManifestEntryObject } from '../core/types.js';
import { Via } from '../domain/entity-key.js';
import { sameName } from '../domain/entity-ref.js';
import { memberSelected } from '../domain/manifest.js';
import { excludedMentions, excludedReferenceNote } from '../index/excluded-refs.js';
import type { Run } from './jobs.js';
import { membersOf, resolveSource } from './resolve.js';
import { lockedSource } from './scope.js';
import { sourceRefOf } from './sources.js';

/** The plugin an entry is or belongs to, with its palm.yaml entry when that narrows it. */
function narrowingPlugin(run: Run, entry: LockEntry) {
  const name = entry.kind === 'plugin' ? entry.name : entry.via && Via.parse(entry.via).name;
  if (!name) return undefined;
  const found = run.state.manifest
    .allEntries()
    .find((e) => e.source === entry.source && e.kind === 'plugin' && sameName(e.entry.name, name));
  const narrowed: ManifestEntryObject | undefined = found?.entry;
  return narrowed?.only?.length || narrowed?.exclude?.length
    ? { name, entry: narrowed }
    : undefined;
}

/** `describe` notes: references from the entry (a plugin: from every kept member) to excluded members. */
export async function excludedNotes(run: Run, entry: LockEntry): Promise<string[]> {
  const plugin = narrowingPlugin(run, entry);
  const ref = plugin && sourceRefOf(run.state, entry.source);
  if (!plugin || !ref) return [];
  const sha = lockedSource(run.state, entry.source)?.sha;
  const { ctx, deps, state } = run;
  const r = await resolveSource({ ctx, deps, state, ref, ...(sha ? { sha } : {}) }).catch(
    () => undefined,
  );
  const own = r?.index.entities.find((e) => e.kind === 'plugin' && sameName(e.name, plugin.name));
  if (!r || !own) return [];
  const members = membersOf(r.index, own);
  const selected = members.filter((m) => memberSelected(plugin.entry, m));
  const kept =
    entry.kind === 'plugin'
      ? selected
      : selected.filter((m) => sameName(m.name, entry.name) && m.kind === entry.kind);
  const excluded = members.filter((m) => !selected.includes(m));
  const refs = await excludedMentions(r.checkout.root, plugin.name, { kept, excluded });
  return refs.map(excludedReferenceNote);
}
