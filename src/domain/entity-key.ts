import { PalmError } from '../core/errors.js';
import type { Kind } from '../core/types.js';

interface Keyed {
  kind: Kind;
  name: string;
}

interface Sourced extends Keyed {
  source: string;
}

/**
 * Identity of an entity in a scope: kind + name, names compared case-insensitively.
 * `id` is the Map key; `toString()` is `<kind>:<name>`.
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
    return entityId(this);
  }

  /** Same kind and name (case-insensitive). */
  is(e: Keyed): boolean {
    return e.kind === this.kind && e.name.toLowerCase() === this.name.toLowerCase();
  }

  toString(): string {
    return `${this.kind}:${this.name}`;
  }
}

/** Map key of an entity without building an EntityKey: `<kind>:<lower-cased name>`. */
export function entityId(e: Keyed): string {
  return `${e.kind}:${e.name.toLowerCase()}`;
}

/** Identity of a lock entry: kind + name (case-insensitive) + source name (exact). */
export class LockKey {
  private constructor(
    readonly kind: Kind,
    readonly name: string,
    readonly source: string,
  ) {}

  static of(e: Sourced): LockKey {
    return new LockKey(e.kind, e.name, e.source);
  }

  get entity(): EntityKey {
    return EntityKey.of(this);
  }

  /** Stable map key: `<kind>:<lower-cased name>@<source>`. */
  get id(): string {
    return lockId(this);
  }

  is(e: Sourced): boolean {
    return this.entity.is(e) && e.source === this.source;
  }

  toString(): string {
    return `${this.kind}:${this.name}@${this.source}`;
  }
}

/** Map key of a lock entry without building a LockKey: `<kind>:<lower-cased name>@<source>`. */
export function lockId(e: Sourced): string {
  return `${entityId(e)}@${e.source}`;
}

const VIA_PREFIX = 'plugin:';

/**
 * Why an entry was installed: `plugin:<name>`, the plugin that selected it (LockEntry.via).
 * Plugins are the only selectors; the entry and its plugin share the source.
 */
export class Via {
  private constructor(readonly name: string) {}

  /** Parses `plugin:<name>`; anything else is E_PARSE. */
  static parse(text: string): Via {
    const name = text.startsWith(VIA_PREFIX) ? text.slice(VIA_PREFIX.length) : '';
    if (!name) {
      throw new PalmError(
        'E_PARSE',
        `invalid via "${text}": expected plugin:<name>`,
        'restore palm.lock.yaml from git, then run palm install',
      );
    }
    return new Via(name);
  }

  /** Parses, or undefined for a missing or malformed value. */
  static tryParse(text?: string): Via | undefined {
    if (!text) return undefined;
    try {
      return Via.parse(text);
    } catch {
      return undefined;
    }
  }

  /** The `via` a member of `parent` records. */
  static of(parent: { kind: 'plugin'; name: string }): Via {
    return new Via(parent.name);
  }

  /** The plugin's entity key. */
  get key(): EntityKey {
    return EntityKey.of({ kind: 'plugin', name: this.name });
  }

  /** True when `text` names the same plugin (names compared case-insensitively). */
  is(text?: string): boolean {
    const other = Via.tryParse(text);
    return !!other && other.key.id === this.key.id;
  }

  toString(): string {
    return `${VIA_PREFIX}${this.name}`;
  }
}
