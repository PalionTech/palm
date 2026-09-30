/**
 * Matching `[kind:]name` requests within one source's index (DESIGN §6 step 3). A name that
 * means two kinds is ambiguous, a plugin and a skill or hook of the same name included (O4): on
 * a terminal palm asks which kind, else one E_AMBIGUOUS error names every ambiguous name with
 * one corrected command (O3, M10). Every question is settled before anything is written (V7').
 */
import { PalmError } from '../core/errors.js';
import type {
  Entity,
  EntityRef,
  EntityRefSpec,
  PalmContext,
  PickOption,
  Scope,
  SourceIndex,
} from '../core/types.js';
import { entityId } from '../domain/entity-key.js';
import { formatEntityRef, sameName } from '../domain/entity-ref.js';
import { type NearMissHit, nearMissFor } from '../index/near-miss-lookup.js';
import { closestWord, shellWord } from '../lib/text.js';
import { palmCommand } from './report.js';
import { membersOf } from './resolve.js';

export interface NameMatch {
  /** The requests as typed (a which-kind answer gives them their kind). */
  names: EntityRefSpec[];
  entities: Entity[];
  plugins: Array<{ plugin: Entity; members: Entity[] }>;
  missing: EntityRefSpec[];
  ambiguous: EntityRefSpec[];
}

function everything(index: SourceIndex): Pick<NameMatch, 'entities' | 'plugins'> {
  const plugins = index.entities
    .filter((e) => e.kind === 'plugin')
    .map((plugin) => ({ plugin, members: membersOf(index, plugin) }));
  const inPlugin = new Set(plugins.flatMap((p) => p.members.map(entityId)));
  const entities = index.entities.filter(
    (e) => e.kind !== 'plugin' && !e.plugin && !inPlugin.has(entityId(e)),
  );
  return { entities, plugins };
}

/** The entities `spec` names, a plugin first (installing it installs its members too). */
function candidates(index: SourceIndex, spec: EntityRefSpec): Entity[] {
  const hits = index.entities.filter(
    (e) => sameName(e.name, spec.name) && (!spec.kind || e.kind === spec.kind),
  );
  return [...hits.filter((e) => e.kind === 'plugin'), ...hits.filter((e) => e.kind !== 'plugin')];
}

function dedupe(entities: Entity[]): Entity[] {
  const seen = new Set<string>();
  return entities.filter((e) => !seen.has(entityId(e)) && seen.add(entityId(e)));
}

/**
 * `[kind:]name` requests against one source's index: case-insensitive; a name that means two
 * kinds is ambiguous (a plugin and a member of the same name too, O4); a plugin expands to its
 * members. `all` takes every plugin and every entity outside a plugin.
 */
export function matchNames(index: SourceIndex, names: EntityRefSpec[], all: boolean): NameMatch {
  const out: NameMatch = { names, entities: [], plugins: [], missing: [], ambiguous: [] };
  if (all) Object.assign(out, everything(index));
  for (const spec of names) {
    const cands = candidates(index, spec);
    const kinds = new Set(cands.map((e) => e.kind));
    const [first] = cands;
    if (!first) out.missing.push(spec);
    else if (kinds.size > 1) out.ambiguous.push(spec);
    else if (first.kind === 'plugin')
      out.plugins.push({ plugin: first, members: membersOf(index, first) });
    else out.entities.push(first);
  }
  out.entities = dedupe(out.entities);
  out.plugins = out.plugins.filter(
    (p, i) => out.plugins.findIndex((q) => sameName(q.plugin.name, p.plugin.name)) === i,
  );
  return out;
}

/** The index name closest to `spec` (edit distance up to 3, or a substring), if any. */
export function closestName(index: SourceIndex, spec: EntityRefSpec): string | undefined {
  const names = index.entities.filter((e) => !spec.kind || e.kind === spec.kind).map((e) => e.name);
  return closestWord(spec.name, names, 3);
}

function shownSpec(spec: EntityRefSpec): string {
  return spec.kind ? `${spec.kind}:${spec.name}` : spec.name;
}

/** Where the names were matched: the source as typed (or its key) and whether palm.yaml declares it. */
export interface MatchSource {
  source: string;
  declared: boolean;
}

/**
 * N1: a name the source lacks that a near-miss file holds (`people/reviewer.md looks like an
 * agent but is not indexed`), with the layout that indexes it: `layout:` in palm.yaml for a
 * declared source, `--layout` flags on the install line for a new one.
 */
function nearMissError(at: MatchSource, missing: EntityRefSpec, hit: NearMissHit, scope: Scope) {
  const message = `"${shownSpec(missing)}" is not in source ${at.source}: ${hit.message}`;
  if (at.declared)
    return new PalmError(
      'E_NOT_FOUND',
      message,
      `add layout: ${hit.layout} under sources: ${at.source} in palm.yaml, then run: ${palmCommand('install', [at.source, shownSpec(missing)], scope)}`,
    );
  const words = [at.source, shownSpec(missing), ...hit.layoutArgs.map(shellWord)];
  return new PalmError('E_NOT_FOUND', message, palmCommand('install', words, scope));
}

/** E_NOT_FOUND for the first name the source lacks. */
function notFound(at: MatchSource, index: SourceIndex, missing: EntityRefSpec, scope: Scope) {
  const hit = missing.kind === 'skill' ? undefined : nearMissFor(index, missing.name);
  if (hit) return nearMissError(at, missing, hit, scope);
  const { source } = at;
  const near = closestName(index, missing);
  const words = near ? [source, near] : [source];
  const guess = near ? `; did you mean ${near}?` : '; list what it offers:';
  return new PalmError(
    'E_NOT_FOUND',
    `"${shownSpec(missing)}" is not in source ${source}${guess}`,
    palmCommand('install', words, scope),
  );
}

/** The typed names with each ambiguous one given its first kind (a plugin before its members). */
function correctedWords(index: SourceIndex, match: NameMatch): string[] {
  return match.names.map((spec) => {
    const ambiguous = match.ambiguous.some((a) => a === spec);
    const [first] = ambiguous ? candidates(index, spec) : [];
    return first ? formatEntityRef(first) : shownSpec(spec);
  });
}

/**
 * E_AMBIGUOUS naming every name that means two kinds, and one command that installs them with
 * a kind each (O3, O7): the first kind offered, a plugin before its members.
 */
function ambiguityError(
  source: string,
  index: SourceIndex,
  match: NameMatch,
  scope: Scope,
): PalmError | undefined {
  if (!match.ambiguous.length) return undefined;
  const parts = match.ambiguous.map((spec, i) => {
    const forms = candidates(index, spec).map(formatEntityRef);
    const where = i === 0 ? ` in source ${source}` : '';
    return `"${spec.name}" names ${forms.length} kinds${where}: ${forms.join(', ')}`;
  });
  return new PalmError(
    'E_AMBIGUOUS',
    parts.join('; '),
    palmCommand('install', [source, ...correctedWords(index, match)], scope),
  );
}

/** E_NOT_FOUND for names the source lacks; E_AMBIGUOUS for names meaning two kinds. */
export function matchError(
  at: MatchSource,
  index: SourceIndex,
  match: NameMatch,
  scope: Scope,
): PalmError | undefined {
  const [missing] = match.missing;
  if (missing) return notFound(at, index, missing, scope);
  return ambiguityError(at.source, index, match, scope);
}

function kindOption(index: SourceIndex, e: Entity): PickOption<EntityRef> {
  const members = e.kind === 'plugin' ? membersOf(index, e).length : 0;
  const hint = e.kind === 'plugin' ? `a plugin: ${members} members` : e.description;
  return {
    value: { kind: e.kind, name: e.name },
    label: formatEntityRef(e),
    ...(hint ? { hint } : {}),
  };
}

/**
 * M10, O4: on a terminal, one question per name that means two kinds (which kind?); the names
 * come back with their kind and are matched again. Without a terminal the match is returned
 * as it is (the caller's `matchError` names them all).
 */
export async function askKinds(
  ctx: PalmContext,
  index: SourceIndex,
  match: NameMatch,
  all: boolean,
): Promise<NameMatch> {
  if (!match.ambiguous.length || !ctx.ui.isInteractive || match.missing.length) return match;
  const names: EntityRefSpec[] = [];
  for (const spec of match.names) {
    if (!match.ambiguous.includes(spec)) {
      names.push(spec);
      continue;
    }
    const options = candidates(index, spec).map((e) => kindOption(index, e));
    names.push(
      await ctx.ui.pick(`"${spec.name}" names ${options.length} kinds; install which?`, options),
    );
  }
  return matchNames(index, names, all);
}

/** The entities the request resolved to (Q4: a declined member of a named plugin is not named). */
export function requestedRefs(match: NameMatch): EntityRef[] {
  const direct = match.entities.map((e) => ({ kind: e.kind, name: e.name }));
  const plugins = match.plugins.map((p) => ({ kind: p.plugin.kind, name: p.plugin.name }));
  return [...plugins, ...direct];
}
