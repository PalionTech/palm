/**
 * From palm.yaml entries and name matches to jobs: each entry of a source becomes a job for
 * its entity, and a plugin entry becomes the plugin's bookkeeping job plus one job per member
 * its `only`/`exclude` select (members carry `via: plugin:<name>`).
 */
import { PalmError } from '../core/errors.js';
import type {
  Entity,
  EntityRef,
  InstallFailure,
  Kind,
  LockEntry,
  ManifestEntry,
  ManifestEntryObject,
  SecretPolicy,
  SourceIndex,
} from '../core/types.js';
import { lockId, Via } from '../domain/entity-key.js';
import { parseEntityRef, sameName } from '../domain/entity-ref.js';
import { memberSelected } from '../domain/manifest.js';
import type { SourceRef } from '../domain/source.js';
import { closestWord } from '../lib/text.js';
import type { Job } from './jobs.js';
import { failure, palmCommand } from './report.js';
import type { Resolved } from './resolve.js';
import { membersOf } from './resolve.js';
import type { ScopeState } from './scope.js';
import { MANIFEST_SOURCE } from './sources.js';
import { activeTargets, narrowedTargets } from './targets.js';

/** The palm.yaml form of an entry: its name alone when it carries no options. */
function manifestEntryOf(entry: ManifestEntryObject): ManifestEntry {
  const { name, ...rest } = entry;
  const options = Object.entries(rest).filter(([, v]) => v !== undefined);
  return options.length ? { name, ...Object.fromEntries(options) } : name;
}

function findEntity(index: SourceIndex, kind: Kind, name: string): Entity | undefined {
  return index.entities.find((e) => e.kind === kind && sameName(e.name, name));
}

interface Build {
  state: ScopeState;
  ref: SourceRef;
  resolved: Resolved;
  explicit: boolean;
}

function jobFor(b: Build, entity: Entity, entry: ManifestEntryObject, via?: string): Job {
  const targets = activeTargets(b.state, entry);
  const job: Job = {
    entity,
    source: b.ref,
    checkout: b.resolved.checkout,
    targets,
    explicit: b.explicit,
  };
  if (via) job.via = via;
  const narrowed = narrowedTargets(b.state, targets);
  if (narrowed) job.narrowed = narrowed;
  if (entry.at) job.at = entry.at;
  if (entry.secrets === 'literal') job.policy = 'literal';
  return job;
}

/** The member `text` (`kind:name` or a name) of `only:`/`exclude:` names, if the plugin declares one. */
function declaredMember(members: readonly EntityRef[], text: string): EntityRef | undefined {
  const ref = parseEntityRef(text);
  return members.find((m) => sameName(m.name, ref.name) && (!ref.kind || ref.kind === m.kind));
}

/** The declared member closest to `text` (`skill:systematic-debugging` for a typo), as typed: with its kind when `text` has one. */
function nearestMember(members: readonly EntityRef[], text: string): string | undefined {
  const ref = parseEntityRef(text);
  const names = members.filter((m) => !ref.kind || m.kind === ref.kind).map((m) => m.name);
  const near = closestWord(ref.name, names, 3);
  return near && ref.kind ? `${ref.kind}:${near}` : near;
}

/**
 * M1: every `only:`/`exclude:` item names a member the plugin declares; a typo is E_PARSE
 * naming the nearest member, before anything is rendered or removed.
 */
function assertMembers(b: Build, plugin: Entity, entry: ManifestEntryObject): void {
  const members = plugin.def.kind === 'plugin' ? plugin.def.members : [];
  const file = b.state.paths.scope === 'global' ? '~/.palm/palm.yaml' : 'palm.yaml';
  for (const key of ['only', 'exclude'] as const)
    for (const text of entry[key] ?? []) {
      if (declaredMember(members, text)) continue;
      const near = nearestMember(members, text);
      throw new PalmError(
        'E_PARSE',
        `${file}: ${key}: ${text} names no member of plugin ${plugin.name} in source ${b.ref.name}${near ? `; did you mean ${near}?` : ''}`,
        `fix ${key}: of plugin ${plugin.name} in ${file}, then run: ${palmCommand('install', [], b.state.paths.scope)}`,
      );
    }
}

/** The plugin's own job (bookkeeping: its `deps`) and the jobs of the members it selects. */
function pluginJobs(b: Build, plugin: Entity, entry: ManifestEntryObject): Job[] {
  assertMembers(b, plugin, entry);
  const members = membersOf(b.resolved.index, plugin);
  const declared: EntityRef[] = plugin.def.kind === 'plugin' ? plugin.def.members : [];
  const own = { ...jobFor(b, plugin, entry), members: declared };
  const via = Via.of({ kind: 'plugin', name: plugin.name }).toString();
  const listed = (e: Entity) => b.state.manifest.hasEntry(b.ref.name, e.kind, e.name);
  const picked = members.filter((m) => memberSelected(entry, { kind: m.kind, name: m.name }));
  const excluded = members.filter((m) => !picked.includes(m));
  const jobs = picked.map((m) => {
    const job: Job = { ...jobFor(b, m, entry, listed(m) ? undefined : via), explicit: false };
    if (m.kind === 'hook' && excluded.length) job.excluded = excluded;
    return job;
  });
  return [own, ...jobs];
}

/** Keeps the first job per lock key (a direct entry wins over the same entity through a plugin). */
export function dedupeJobs(jobs: Job[]): Job[] {
  const seen = new Map<string, Job>();
  for (const j of jobs) {
    const key = lockId({ kind: j.entity.kind, name: j.entity.name, source: j.source.name });
    const prev = seen.get(key);
    if (!prev || (prev.via && !j.via)) seen.set(key, j);
  }
  return [...seen.values()];
}

/**
 * Jobs for every palm.yaml entry of one resolved source. An entry the source no longer has is
 * a failure (its lock entry stays); `missing` holds their lock ids.
 */
export function manifestJobs(
  state: ScopeState,
  ref: SourceRef,
  resolved: Resolved,
  explicit = false,
): { jobs: Job[]; failures: InstallFailure[]; missing: Set<string> } {
  const b: Build = { state, ref, resolved, explicit };
  const jobs: Job[] = [];
  const failures: InstallFailure[] = [];
  const missing = new Set<string>();
  for (const { source, kind, entry } of state.manifest.allEntries()) {
    if (source !== ref.name) continue;
    const entity = findEntity(resolved.index, kind, entry.name);
    if (!entity) {
      for (const id of missingIds(state, ref, { kind, name: entry.name })) missing.add(id);
      failures.push(missingFailure(state, ref, { kind, name: entry.name }));
    } else if (kind === 'plugin') jobs.push(...pluginJobs(b, entity, entry));
    else jobs.push(jobFor(b, entity, entry));
  }
  return { jobs: dedupeJobs(jobs), failures, missing };
}

/**
 * The lock ids an entry the source no longer indexes keeps: its own, and for a plugin every
 * member installed through it (R3': a layout that hides a plugin removes nothing).
 */
function missingIds(state: ScopeState, ref: SourceRef, e: EntityRef): string[] {
  const own = lockId({ ...e, source: ref.name });
  if (e.kind !== 'plugin') return [own];
  const via = Via.of({ kind: 'plugin', name: e.name }).toString();
  const members = state.lock.entriesOf(ref.name).filter((x) => x.via === via);
  return [own, ...members.map(lockId)];
}

/** An entry the source no longer indexes: kept, reported (its layout named when it has one, R3'). */
function missingFailure(state: ScopeState, ref: SourceRef, e: EntityRef): InstallFailure {
  const subject = { ...e, source: ref.name };
  const hint = palmCommand('remove', [ref.name, e.name], state.paths.scope);
  const file = state.paths.scope === 'global' ? '~/.palm/palm.yaml' : 'palm.yaml';
  const message = ref.source.layout
    ? `${e.kind} ${e.name} is not indexed by the layout of source ${ref.name}; add it to its layout: in ${file}, or remove it`
    : `${e.kind} ${e.name} is no longer in source ${ref.name}`;
  return failure(subject, 'E_NOT_FOUND', { message, hint });
}

/** The plugin palm.yaml still declares that the lock says the entity came through, if any. */
function memberOf(b: Omit<Build, 'explicit'>, entity: Entity): string | undefined {
  const via = b.state.lock.find(entity, b.ref.name)?.via;
  const plugin = via ? Via.tryParse(via)?.name : undefined;
  return plugin && b.state.manifest.hasEntry(b.ref.name, 'plugin', plugin) ? via : undefined;
}

/**
 * R13', Q5: the plugin entry of this source whose `exclude:` names `entity` among the plugin's
 * declared members (a member the person declined before), with that item taken out.
 */
function excludedBy(
  b: Omit<Build, 'explicit'>,
  entity: Entity,
): { plugin: string; entry: ManifestEntryObject } | undefined {
  for (const entry of b.state.manifest.entries(b.ref.name, 'plugin')) {
    const plugin = findEntity(b.resolved.index, 'plugin', entry.name);
    const members = plugin?.def.kind === 'plugin' ? plugin.def.members : [];
    const names = (text: string) => declaredMember([entity], text) !== undefined;
    if (!members.some((m) => m.kind === entity.kind && sameName(m.name, entity.name))) continue;
    if (!entry.exclude?.some(names)) continue;
    const exclude = entry.exclude.filter((x) => !names(x));
    return {
      plugin: entry.name,
      entry: { ...entry, exclude: exclude.length ? exclude : undefined },
    };
  }
  return undefined;
}

/**
 * Installing a member the plugin entry excludes takes it out of `exclude:` (R13', Q5): it
 * installs as the plugin's member, and palm.yaml gets no second entry for it.
 */
function unexcludeJob(b: Omit<Build, 'explicit'>, entity: Entity): Job | undefined {
  const found = excludedBy(b, entity);
  if (!found) return undefined;
  const via = Via.of({ kind: 'plugin', name: found.plugin }).toString();
  const record = { kind: 'plugin' as const, entry: manifestEntryOf(found.entry) };
  return { ...jobFor({ ...b, explicit: true }, entity, found.entry, via), record };
}

/**
 * A direct request (install with names): the palm.yaml entry it records, options kept. A member
 * of an installed plugin named on its own (a declined hook asked for again) stays a member.
 */
export function requestJobs(
  b: Omit<Build, 'explicit'>,
  entity: Entity,
  opts: { targets?: ManifestEntryObject['targets']; at?: string; secrets?: SecretPolicy },
): Job[] {
  const via = memberOf(b, entity);
  if (via && !opts.targets && !opts.at)
    return [jobFor({ ...b, explicit: true }, entity, { name: entity.name }, via)];
  const unexcluded = opts.targets || opts.at ? undefined : unexcludeJob(b, entity);
  if (unexcluded) return [unexcluded];
  const current = b.state.manifest
    .entries(b.ref.name, entity.kind)
    .find((e) => sameName(e.name, entity.name));
  const entry: ManifestEntryObject = { ...(current ?? {}), name: current?.name ?? entity.name };
  if (opts.targets?.length) entry.targets = opts.targets;
  if (opts.at) entry.at = opts.at;
  // `--secrets` on the command line is recorded for a server, so a bare install keeps it (Y19).
  if (entity.kind === 'mcp' && opts.secrets === 'literal') entry.secrets = 'literal';
  if (opts.secrets === 'env-ref') delete entry.secrets;
  const record = { kind: entity.kind, entry: manifestEntryOf(entry) };
  const build = { ...b, explicit: true };
  if (entity.kind !== 'plugin') return [{ ...jobFor(build, entity, entry), record }];
  const [own, ...members] = pluginJobs(build, entity, entry);
  return [{ ...(own as Job), record }, ...members];
}

/**
 * The secrets policy palm.yaml records for an installed entry (`secrets: literal`, Y19): on its
 * source entry, or on its `mcp:` server; undefined when none. `check` renders the entry with it.
 */
export function recordedPolicy(state: ScopeState, entry: LockEntry): SecretPolicy | undefined {
  const { manifest } = state;
  const server = entry.source === MANIFEST_SOURCE ? manifest.mcp[entry.name] : undefined;
  const own = manifest.entries(entry.source, entry.kind).find((e) => sameName(e.name, entry.name));
  return server?.secrets ?? own?.secrets;
}
