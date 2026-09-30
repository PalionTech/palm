/**
 * From palm.yaml entries and name matches to jobs: each entry of a source becomes a job for
 * its entity, and a plugin entry becomes the plugin's bookkeeping job plus one job per member
 * its `only`/`exclude` select (members carry `via: plugin:<name>`).
 */
import type {
  Entity,
  EntityRef,
  InstallFailure,
  Kind,
  ManifestEntry,
  ManifestEntryObject,
  SourceIndex,
} from '../core/types.js';
import { lockId, Via } from '../domain/entity-key.js';
import { sameName } from '../domain/entity-ref.js';
import { memberSelected } from '../domain/manifest.js';
import type { SourceRef } from '../domain/source.js';
import type { Job } from './jobs.js';
import { failure, palmCommand } from './report.js';
import type { Resolved } from './resolve.js';
import { membersOf } from './resolve.js';
import type { ScopeState } from './scope.js';
import { activeTargets, narrowedTargets } from './targets.js';

/** The palm.yaml form of an entry: its name alone when it carries no options. */
export function manifestEntryOf(entry: ManifestEntryObject): ManifestEntry {
  const { name, ...rest } = entry;
  const options = Object.entries(rest).filter(([, v]) => v !== undefined);
  return options.length ? { name, ...Object.fromEntries(options) } : name;
}

export function findEntity(index: SourceIndex, kind: Kind, name: string): Entity | undefined {
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
  return job;
}

/** The plugin's own job (bookkeeping: its `deps`) and the jobs of the members it selects. */
export function pluginJobs(b: Build, plugin: Entity, entry: ManifestEntryObject): Job[] {
  const members = membersOf(b.resolved.index, plugin);
  const declared: EntityRef[] = plugin.def.kind === 'plugin' ? plugin.def.members : [];
  const own = { ...jobFor(b, plugin, entry), members: declared };
  const via = Via.of({ kind: 'plugin', name: plugin.name }).toString();
  const listed = (e: Entity) => b.state.manifest.hasEntry(b.ref.name, e.kind, e.name);
  const picked = members.filter((m) => memberSelected(entry, { kind: m.kind, name: m.name }));
  const jobs = picked.map((m) => ({
    ...jobFor(b, m, entry, listed(m) ? undefined : via),
    explicit: false,
  }));
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
      missing.add(lockId({ kind, name: entry.name, source }));
      const subject = { kind, name: entry.name, source };
      const message = `${kind} ${entry.name} is no longer in source ${source}`;
      const hint = palmCommand('remove', [source, entry.name], state.paths.scope);
      failures.push(failure(subject, 'E_NOT_FOUND', { message, hint }));
    } else if (kind === 'plugin') jobs.push(...pluginJobs(b, entity, entry));
    else jobs.push(jobFor(b, entity, entry));
  }
  return { jobs: dedupeJobs(jobs), failures, missing };
}

/** The plugin palm.yaml still declares that the lock says the entity came through, if any. */
function memberOf(b: Omit<Build, 'explicit'>, entity: Entity): string | undefined {
  const via = b.state.lock.find(entity, b.ref.name)?.via;
  const plugin = via ? Via.tryParse(via)?.name : undefined;
  return plugin && b.state.manifest.hasEntry(b.ref.name, 'plugin', plugin) ? via : undefined;
}

/**
 * A direct request (install with names): the palm.yaml entry it records, options kept. A member
 * of an installed plugin named on its own (a declined hook asked for again) stays a member.
 */
export function requestJobs(
  b: Omit<Build, 'explicit'>,
  entity: Entity,
  opts: { targets?: ManifestEntryObject['targets']; at?: string },
): Job[] {
  const via = memberOf(b, entity);
  if (via && !opts.targets && !opts.at)
    return [{ ...jobFor({ ...b, explicit: true }, entity, {}, via) }];
  const current = b.state.manifest
    .entries(b.ref.name, entity.kind)
    .find((e) => sameName(e.name, entity.name));
  const entry: ManifestEntryObject = { ...(current ?? {}), name: current?.name ?? entity.name };
  if (opts.targets?.length) entry.targets = opts.targets;
  if (opts.at) entry.at = opts.at;
  const record = { kind: entity.kind, entry: manifestEntryOf(entry) };
  const build = { ...b, explicit: true };
  if (entity.kind !== 'plugin') return [{ ...jobFor(build, entity, entry), record }];
  const [own, ...members] = pluginJobs(build, entity, entry);
  return [{ ...(own as Job), record }, ...members];
}
