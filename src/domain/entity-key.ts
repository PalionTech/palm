import { PalmError } from '../core/errors.js';
import type { Kind } from '../core/types.js';

interface Keyed {
  kind: Kind;
  name: string;
}

/**
 * Identity of an entity in a scope: kind + name, names compared case-insensitively.
 * `id` is the Map key; `toString()` is `<kind>:<name>` (the `via` form).
 */
export class EntityKey {
  private constructor(
    readonly kind: Kind,
    readonly name: string,
  ) {}

  static of(e: Keyed): EntityKey {
    return new EntityKey(e.kind, e.name);
  }

  /** Stable map key: `<kind>:<lower-cased name>`. */
  get id(): string {
    return `${this.kind}:${this.name.toLowerCase()}`;
  }

  /** Same kind and name (case-insensitive). */
  is(e: Keyed): boolean {
    return e.kind === this.kind && e.name.toLowerCase() === this.name.toLowerCase();
  }

  toString(): string {
    return `${this.kind}:${this.name}`;
  }
}

/** Map key of an entity without building an EntityKey. */
export function entityId(e: Keyed): string {
  return `${e.kind}:${e.name.toLowerCase()}`;
}

/** Identity of a lock entry: kind + name (case-insensitive) + origin (exact). */
export class LockKey {
  private constructor(
    readonly kind: Kind,
    readonly name: string,
    readonly origin: string,
  ) {}

  static of(e: Keyed & { origin: string }): LockKey {
    return new LockKey(e.kind, e.name, e.origin);
  }

  get entity(): EntityKey {
    return EntityKey.of(this);
  }

  /** Stable map key: `<kind>:<lower-cased name>@<origin>`. */
  get id(): string {
    return `${entityId(this)}@${this.origin}`;
  }

  is(e: Keyed & { origin: string }): boolean {
    return this.entity.is(e) && e.origin === this.origin;
  }

  toString(): string {
    return `${this.kind}:${this.name}@${this.origin}`;
  }
}

/** Map key of a lock entry without building a LockKey. */
export function lockId(e: Keyed & { origin: string }): string {
  return `${entityId(e)}@${e.origin}`;
}

export type ViaKind = 'plugin' | 'agent';

/** Plugins and agents install dependencies (`via`); nothing else does. */
export function isViaKind(kind: Kind): kind is ViaKind {
  return kind === 'plugin' || kind === 'agent';
}

/** Why a dependency was installed: `plugin:<name>` or `agent:<name>` (LockEntry.via). */
export class Via {
  private constructor(
    readonly kind: ViaKind,
    readonly name: string,
  ) {}

  /** Parses `plugin:<name>` / `agent:<name>`; the name may itself contain `:`. */
  static parse(text: string): Via {
    const colon = text.indexOf(':');
    const kind = text.slice(0, colon);
    const name = text.slice(colon + 1);
    if (colon < 0 || !isViaKind(kind as Kind) || !name) {
      throw new PalmError(
        'E_PARSE',
        `Invalid via "${text}"`,
        'Expected plugin:<name> or agent:<name>',
      );
    }
    return new Via(kind as ViaKind, name);
  }

  /** Parses, or undefined for a missing or malformed value. */
  static tryParse(text: string | undefined): Via | undefined {
    if (!text) return undefined;
    try {
      return Via.parse(text);
    } catch {
      return undefined;
    }
  }

  /** The `via` a dependency of `parent` records; `parent` must be a plugin or an agent. */
  static of(parent: Keyed): Via {
    if (!isViaKind(parent.kind)) {
      throw new PalmError(
        'E_INTERNAL',
        `${parent.kind} ${parent.name} cannot install dependencies`,
      );
    }
    return new Via(parent.kind, parent.name);
  }

  /** The parent entity's key. */
  get key(): EntityKey {
    return EntityKey.of(this);
  }

  /** True when `text` names the same parent (names compared case-insensitively). */
  is(text: string | undefined): boolean {
    const other = Via.tryParse(text);
    return !!other && other.key.id === this.key.id;
  }

  toString(): string {
    return `${this.kind}:${this.name}`;
  }
}
