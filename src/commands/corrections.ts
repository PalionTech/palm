/**
 * O3, O7, L20: the names of an install corrected by the error that stopped it. A name the
 * source lacks becomes the name it nearly is; a name that means two kinds gets its kind (the
 * kind already installed from that source first, else the first the message lists), for every
 * such name the message lists at once. The other names stay as typed. Pure.
 */
import type { PalmError } from '../core/errors.js';
import { type EntityRefSpec, KINDS, type Kind } from '../core/types.js';
import { formatName } from './hints.js';

/** `"grill-mee" is not in source kit; did you mean grill-me?`, once per name. */
const NOT_IN_SOURCE = /"([^"]+)" is not in source [^;]*; did you mean ([^?\s]+)\?/g;

/** `skill:golang` in a message that lists the kinds a name means. */
const FORM = new RegExp(`\\b(${KINDS.join('|')}):([^\\s,;)"]+)`, 'g');

/** Wrong name → the name it nearly is, from an E_NOT_FOUND message. */
function nearNames(e: PalmError): Map<string, string> {
  const near = new Map<string, string>();
  if (e.code !== 'E_NOT_FOUND') return near;
  for (const m of e.message.matchAll(NOT_IN_SOURCE)) near.set(m[1] ?? '', m[2] ?? '');
  return near;
}

/** Name (any case) → the kinds an E_AMBIGUOUS message lists for it, in its order. */
function kindsListed(e: PalmError): Map<string, Kind[]> {
  const kinds = new Map<string, Kind[]>();
  if (e.code !== 'E_AMBIGUOUS') return kinds;
  for (const m of e.message.matchAll(FORM)) {
    const name = (m[2] ?? '').toLowerCase();
    const seen = kinds.get(name) ?? [];
    if (!seen.includes(m[1] as Kind)) kinds.set(name, [...seen, m[1] as Kind]);
  }
  return kinds;
}

/**
 * The typed names with the error's corrections applied, or undefined when it corrects none.
 * `installed` gives the kinds a name is installed as from the source of the run.
 */
export function correctedNames(
  e: PalmError,
  names: readonly EntityRefSpec[],
  installed: (name: string) => readonly Kind[],
): string[] | undefined {
  const near = nearNames(e);
  const listed = kindsListed(e);
  let changed = false;
  const out = names.map((n) => {
    const shown = formatName(n);
    const fixed = near.get(shown) ?? near.get(n.name);
    const kinds = n.kind ? [] : (listed.get(n.name.toLowerCase()) ?? []);
    if (fixed === undefined && kinds.length < 2) return shown;
    changed = true;
    if (fixed !== undefined) return fixed;
    const kind = kinds.find((k) => installed(n.name).includes(k)) ?? kinds[0];
    return `${kind}:${n.name}`;
  });
  return changed ? out : undefined;
}
