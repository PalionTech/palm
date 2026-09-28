import { PalmError } from '../core/errors.js';
import type { OriginSpec } from '../core/types.js';
import { assertAliasFormat, Origin } from './origin.js';

/** `user`: config.yaml (`palm install origin`); `project`: the project's palm.yaml (`--project`). */
export type OriginLayer = 'user' | 'project';

/** A project origin that reuses a user alias for a different repository or directory. */
export interface OriginConflict {
  alias: string;
  user: Origin;
  project: Origin;
}

function aliasKey(alias: string): string {
  return alias.toLowerCase();
}

/** `list` with the origin of the same alias replaced in place, or `next` appended. */
function upsert(list: readonly Origin[], next: Origin): Origin[] {
  const key = aliasKey(next.alias);
  const i = list.findIndex((o) => aliasKey(o.alias) === key);
  return i >= 0 ? list.with(i, next) : [...list, next];
}

/**
 * The origins of one context: the user's (config.yaml) and the project's (palm.yaml). Aliases
 * are case-insensitive. On an alias clash the project origin wins and keeps the user origin's
 * position (today's precedence; `conflicts()` lists the clashes that change the source).
 * Immutable: `add`/`without`/`withProject` return a new set.
 */
export class OriginSet {
  private readonly user: readonly Origin[];
  private readonly project: readonly Origin[];
  private readonly merged: ReadonlyMap<string, Origin>;

  private constructor(user: readonly Origin[], project: readonly Origin[]) {
    this.user = user;
    this.project = project;
    const merged = new Map<string, Origin>();
    for (const o of [...user, ...project]) merged.set(aliasKey(o.alias), o);
    this.merged = merged;
  }

  /** A set of user origins (no project layer). */
  static of(user: Iterable<OriginSpec | Origin> = []): OriginSet {
    return new OriginSet([...user].map(Origin.of), []);
  }

  /** This set's user origins with `project` as the project layer (replacing any previous one). */
  withProject(project: Iterable<OriginSpec | Origin>): OriginSet {
    return new OriginSet(this.user, [...project].map(Origin.of));
  }

  get size(): number {
    return this.merged.size;
  }

  /** Every effective origin: user order, project-only aliases appended. */
  all(): Origin[] {
    return [...this.merged.values()];
  }

  specs(): OriginSpec[] {
    return this.all().map((o) => o.spec);
  }

  userSpecs(): OriginSpec[] {
    return this.user.map((o) => o.spec);
  }

  projectSpecs(): OriginSpec[] {
    return this.project.map((o) => o.spec);
  }

  /** Effective aliases, in set order. */
  aliases(): string[] {
    return this.all().map((o) => o.alias);
  }

  byAlias(alias: string): Origin | undefined {
    return this.merged.get(aliasKey(alias));
  }

  /**
   * The one origin `query` names (Origin.matchRank): an alias wins over everything else, and a
   * query naming an origin exactly (root included) wins over one naming only its repository.
   * Throws E_NOT_FOUND (listing the aliases) or E_AMBIGUOUS.
   */
  resolveQuery(query: string): Origin {
    const ranked = this.all()
      .map((o) => ({ o, rank: o.matchRank(query) }))
      .filter((r) => r.rank > 0);
    const top = Math.max(0, ...ranked.map((r) => r.rank));
    const best = ranked.filter((r) => r.rank === top).map((r) => r.o);
    const [first] = best;
    if (first && best.length === 1) return first;
    if (!first) throw this.notFound(query);
    throw new PalmError(
      'E_AMBIGUOUS',
      `"${query}" matches ${best.length} origins: ${best.map((o) => `${o.alias} (${o.describe()})`).join(', ')}`,
      `Use the alias instead, e.g. -o ${first.alias}.`,
    );
  }

  /** Project origins whose alias a user origin already uses for another repository or directory. */
  conflicts(): OriginConflict[] {
    const users = new Map(this.user.map((o) => [aliasKey(o.alias), o] as const));
    const out: OriginConflict[] = [];
    for (const project of this.project) {
      const user = users.get(aliasKey(project.alias));
      if (user && !user.sameSource(project)) out.push({ alias: project.alias, user, project });
    }
    return out;
  }

  /**
   * Adds (or, for the same origin id, replaces) `spec` in `layer`. Throws E_USAGE for an invalid
   * alias and E_CONFLICT when another origin already uses it.
   */
  add(spec: OriginSpec, layer: OriginLayer = 'user'): OriginSet {
    assertAliasFormat(spec.alias, 'E_USAGE');
    const next = new Origin(spec);
    const clash = this.byAlias(spec.alias);
    if (clash && clash.id !== next.id) {
      throw new PalmError(
        'E_CONFLICT',
        `Origin alias "${spec.alias}" is already used by ${clash.describe()}`,
        'Pick another alias with --alias <name>, or remove the existing one with `palm uninstall origin <alias>`.',
      );
    }
    return layer === 'user'
      ? new OriginSet(upsert(this.user, next), this.project)
      : new OriginSet(this.user, upsert(this.project, next));
  }

  /** This set without `alias` in either layer (unchanged when nothing uses it). */
  without(alias: string): OriginSet {
    const key = aliasKey(alias);
    const keep = (o: Origin): boolean => aliasKey(o.alias) !== key;
    return new OriginSet(this.user.filter(keep), this.project.filter(keep));
  }

  private notFound(query: string): PalmError {
    const aliases = this.aliases().sort();
    return new PalmError(
      'E_NOT_FOUND',
      `No origin matches "${query}"`,
      aliases.length
        ? `Registered origins: ${aliases.join(', ')}. Use an alias, owner/repo[/root], the URL or the local path.`
        : 'No origins are registered; add one with `palm install origin owner/repo`.',
    );
  }
}
