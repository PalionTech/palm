import { PalmError } from '../core/errors.js';
import type { DepRef as DepRefData, DepSpec } from '../core/types.js';

/** The one dependency grammar (DESIGN.md §3). */
export const DEP_GRAMMAR = 'Expected <name>[@<origin>][#<ref>]';

/** Case-insensitive name comparison (entity names and origin aliases). */
export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * A dependency reference `<name>[@<origin>][#<ref>]`.
 *
 * `@` separates an origin only when no `/` follows it, so MCP registry names
 * (`io.github.acme/weather`) and scoped names (`@scope/pkg`) pass through as names.
 * Structurally a `DepRef` from core/types (absent parts are not own properties).
 */
export class DepRef implements DepRefData {
  readonly name: string;
  declare readonly origin?: string;
  declare readonly ref?: string;

  private constructor(name: string, origin?: string, ref?: string) {
    this.name = name;
    if (origin) (this as { origin?: string }).origin = origin;
    if (ref) (this as { ref?: string }).ref = ref;
  }

  /** Parses `<name>[@<origin>][#<ref>]`; empty origin/ref parts are dropped. */
  static parse(text: string): DepRef {
    let rest = text.trim();
    let ref: string | undefined;
    const hash = rest.lastIndexOf('#');
    if (hash >= 0) {
      ref = rest.slice(hash + 1).trim();
      rest = rest.slice(0, hash);
    }
    let origin: string | undefined;
    const at = rest.lastIndexOf('@');
    if (at > 0 && !rest.slice(at + 1).includes('/')) {
      origin = rest.slice(at + 1).trim();
      rest = rest.slice(0, at);
    }
    const name = rest.trim();
    if (!name)
      throw new PalmError('E_USAGE', `Invalid dependency "${text}": missing name`, DEP_GRAMMAR);
    return new DepRef(name, origin, ref);
  }

  /** A manifest entry: a dependency string or a `{ name, origin?, ref? }` object. */
  static from(spec: DepSpec): DepRef {
    if (spec instanceof DepRef) return spec;
    if (typeof spec === 'string') return DepRef.parse(spec);
    if (!spec || typeof spec !== 'object' || typeof spec.name !== 'string' || !spec.name) {
      throw new PalmError(
        'E_PARSE',
        `Invalid dependency entry: ${JSON.stringify(spec)}`,
        DEP_GRAMMAR,
      );
    }
    return new DepRef(spec.name, spec.origin, spec.ref);
  }

  /** Builds a reference from parts (no parsing: `name` is taken verbatim). */
  static of(name: string, origin?: string, ref?: string): DepRef {
    return DepRef.from({ name, origin, ref });
  }

  withOrigin(origin: string | undefined): DepRef {
    return new DepRef(this.name, origin, this.ref);
  }

  withRef(ref: string | undefined): DepRef {
    return new DepRef(this.name, this.origin, ref);
  }

  /** Same name (case-insensitive) and, when this ref names an origin, the same origin. */
  matches(e: { name: string; origin?: string }): boolean {
    if (!sameName(this.name, e.name)) return false;
    return !this.origin || (e.origin !== undefined && sameName(this.origin, e.origin));
  }

  /** Plain `{ name, origin?, ref? }` data (no undefined keys). */
  toJSON(): DepRefData {
    const out: DepRefData = { name: this.name };
    if (this.origin) out.origin = this.origin;
    if (this.ref) out.ref = this.ref;
    return out;
  }

  toString(): string {
    return `${this.name}${this.origin ? `@${this.origin}` : ''}${this.ref ? `#${this.ref}` : ''}`;
  }
}
