/**
 * The entities of one scan: name uniqueness per kind, duplicate warnings, symlinked aliases of one
 * file, claimed paths, plugin membership and the post-processing that depends on all of them.
 */

import type { Entity, EntityRef, Kind } from '../core/types.js';
import { dirOf, displayRel, joinRel } from './util.js';

/** Entities that belong to one plugin, each kind+name once, in the order they were found. */
export class MemberList {
  readonly refs: EntityRef[] = [];

  add(e: Entity | undefined): void {
    if (e && !this.refs.some((m) => m.kind === e.kind && m.name === e.name))
      this.refs.push({ kind: e.kind, name: e.name });
  }

  addAll(list: Entity[]): void {
    for (const e of list) this.add(e);
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const key = (kind: Kind, id: string): string => `${kind}\0${id}`;

export class EntityRegistry {
  entities: Entity[] = [];
  /** Plugin roots registered so far (origin-relative), for the undeclared-member warning. */
  readonly pluginRoots: Array<{ rootRel: string; name: string }> = [];
  private readonly byName = new Map<string, Entity>();
  private readonly byReal = new Map<string, Entity>();
  private readonly claimed = new Set<string>();

  constructor(
    private readonly warnings: string[],
    private readonly realPathOf: (rel: string) => string,
  ) {}

  /** Mark `path` as handled for `kind`, so the convention pass does not index it again. */
  claim(kind: Kind, path: string): void {
    this.claimed.add(key(kind, path));
  }

  isClaimed(kind: Kind, path: string): boolean {
    return this.claimed.has(key(kind, path));
  }

  hasName(kind: Kind, name: string): boolean {
    return this.byName.has(key(kind, name));
  }

  /** The skill already indexed from the same real SKILL.md as `dirRel` (a symlinked alias). */
  skillAt(dirRel: string): Entity | undefined {
    return this.byReal.get(key('skill', this.realPathOf(joinRel(dirRel, 'SKILL.md'))));
  }

  private realKey(e: Entity): string | undefined {
    const rel = e.path === '.' ? '' : e.path;
    switch (e.kind) {
      case 'plugin':
        return undefined;
      case 'skill':
        return key('skill', this.realPathOf(joinRel(rel, 'SKILL.md')));
      case 'mcp':
        return key('mcp', `${this.realPathOf(rel)}\0${e.name}`);
      default:
        return key(e.kind, this.realPathOf(rel));
    }
  }

  /** Register an entity; returns the entity that holds the name (the new one or an earlier one). */
  add(e: Entity): Entity {
    this.claim(e.kind, e.path);
    const rk = this.realKey(e);
    const sameFile = rk ? this.byReal.get(rk) : undefined;
    if (sameFile) return sameFile;
    const nk = key(e.kind, e.name);
    const existing = this.byName.get(nk);
    if (existing) {
      if (existing.path !== e.path) {
        this.warnings.push(
          `duplicate ${e.kind} "${e.name}" at ${e.path} ignored (already indexed from ${existing.path})`,
        );
      }
      return existing;
    }
    this.entities.push(e);
    this.byName.set(nk, e);
    if (rk) this.byReal.set(rk, e);
    return e;
  }

  /** Register a plugin entity and remember its root for `warnUndeclared`. */
  addPlugin(plugin: Entity, rootRel: string): void {
    this.add(plugin);
    this.pluginRoots.push({ rootRel, name: plugin.name });
  }

  /** Layout `include`: keep only the listed names, and only listed plugin members. */
  applyInclude(include: string[] | undefined): void {
    if (!include || include.length === 0) return;
    const keep = new Set(include);
    this.entities = this.entities.filter((e) => keep.has(e.name));
    const present = new Set(this.entities.map((e) => key(e.kind, e.name)));
    for (const e of this.entities) {
      if (e.def.kind === 'plugin')
        e.def.members = e.def.members.filter((m) => present.has(key(m.kind, m.name)));
    }
  }

  /** Entities that sit inside a plugin directory without being declared by it. */
  warnUndeclared(): void {
    const byRoot = new Map<string, string[]>();
    for (const p of this.pluginRoots)
      byRoot.set(p.rootRel, [...(byRoot.get(p.rootRel) ?? []), p.name]);
    const found = new Map<string, Map<Kind, string[]>>();
    for (const e of this.entities) {
      const root = isStandaloneTop(e)
        ? closestRoot(byRoot, e.path === '.' ? '' : e.path)
        : undefined;
      if (root === undefined) continue;
      const kinds = found.get(root) ?? new Map<Kind, string[]>();
      kinds.set(e.kind, [...(kinds.get(e.kind) ?? []), e.name]);
      found.set(root, kinds);
    }
    for (const [root, kinds] of found) this.warnings.push(undeclaredMessage(root, byRoot, kinds));
  }
}

/** Not a plugin, not a plugin member, not a sub-skill. */
function isStandaloneTop(e: Entity): boolean {
  if (e.kind === 'plugin' || e.plugin) return false;
  return !(e.def.kind === 'skill' && e.def.skill.parent);
}

/** The deepest plugin root that contains `rel` (the path itself included). */
function closestRoot(byRoot: Map<string, string[]>, rel: string): string | undefined {
  let d = rel;
  for (;;) {
    if (byRoot.has(d)) return d;
    if (d === '') return undefined;
    d = dirOf(d);
  }
}

function undeclaredMessage(
  root: string,
  byRoot: Map<string, string[]>,
  kinds: Map<Kind, string[]>,
): string {
  const names = byRoot.get(root) ?? [];
  const parts = [...kinds].map(([kind, list]) => {
    const shown = list.slice(0, 20).join(', ') + (list.length > 20 ? ', …' : '');
    return `${plural(list.length, kind)} (${shown})`;
  });
  const one = names.length === 1;
  return (
    `${one ? 'plugin' : 'plugins'} ${names.map((n) => `"${n}"`).join(', ')} at ${displayRel(root)} ` +
    `do${one ? 'es' : ''} not declare ${parts.join(', ')}; indexed standalone`
  );
}
