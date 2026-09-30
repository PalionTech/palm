/**
 * `[kind:]name`: how an entity is named on the command line and in a plugin entry's
 * `only`/`exclude` (DESIGN.md sections 3 and 10). The source is a separate word, never `@`.
 */
import { PalmError } from '../core/errors.js';
import { parseKind } from '../core/kinds.js';
import type { EntityRef, EntityRefSpec } from '../core/types.js';

/** The E_USAGE hint for a malformed reference. */
export const REF_GRAMMAR = 'name an entity as name or kind:name, for example tdd or skill:tdd';

/**
 * Case-insensitive name comparison (entity and source names): `TDD` names the same entity as
 * `tdd`, in requests, palm.yaml and the lock.
 */
export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** True for the 0.1 grammar: `name@source` or a `#ref` suffix (migrate hint). */
export function isLegacyDepString(text: string): boolean {
  const t = text.trim();
  return t.includes('#') || t.slice(1).includes('@');
}

/** E_USAGE for a 0.1 reference, naming the 0.2 form. */
function legacyError(text: string): PalmError {
  const t = text.trim();
  const hash = t.indexOf('#');
  const ref = hash >= 0 ? t.slice(hash + 1) : undefined;
  const body = hash >= 0 ? t.slice(0, hash) : t;
  const at = body.lastIndexOf('@');
  const name = at > 0 ? body.slice(0, at) : body;
  const source = at > 0 ? body.slice(at + 1) : undefined;
  if (ref) {
    return new PalmError(
      'E_USAGE',
      `"${t}" pins a ref on one entity; a ref belongs to its source in palm.yaml`,
      `palm update ${source ?? '<source>'} --to ${ref}`,
    );
  }
  return new PalmError(
    'E_USAGE',
    `"${t}" is the palm 0.1 form; name the source first`,
    `palm install ${source ?? '<source>'} ${name}`,
  );
}

/**
 * `skill:tdd` → `{ kind: 'skill', name: 'tdd' }`; `tdd` → `{ name: 'tdd' }`. Kind words take
 * every form `parseKind` knows (`sk:tdd`, `command:review` gives a skill). An unknown kind word,
 * an empty name, `name@source` or `#ref` is E_USAGE.
 */
export function parseEntityRef(text: string): EntityRefSpec {
  const t = text.trim();
  if (isLegacyDepString(t)) throw legacyError(t);
  const colon = t.indexOf(':');
  const name = (colon >= 0 ? t.slice(colon + 1) : t).trim();
  if (!name) throw new PalmError('E_USAGE', `"${text}" names no entity`, REF_GRAMMAR);
  if (colon < 0) return { name };
  const word = t.slice(0, colon).trim();
  const kind = parseKind(word);
  if (!kind) {
    throw new PalmError(
      'E_USAGE',
      `"${word}" is not a kind (skill, agent, instruction, hook, mcp, plugin)`,
      REF_GRAMMAR,
    );
  }
  return { kind, name };
}

/** `skill:tdd`. */
export function formatEntityRef(ref: EntityRef): string {
  return `${ref.kind}:${ref.name}`;
}
