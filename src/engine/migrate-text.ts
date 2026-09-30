/**
 * The migrated palm.yaml as text, with the person's 0.1 comments kept (DESIGN §6 "Migrate"): the
 * comment at the top stays at the top and the ones on `targets:` stay on `targets:`; a comment on
 * an origin or an entry goes above the source that now holds it (or the `mcp:` server it became);
 * a comment on a dropped section goes above `sources:` (`mcp:` for the servers); whatever has no
 * place left ends the file under `# from palm 0.1:`.
 */
import {
  type Document,
  isMap,
  isScalar,
  isSeq,
  type Node,
  type Pair,
  parseDocument,
  type YAMLMap,
} from 'yaml';
import { isRecord } from '../lib/object.js';
import type { Migration } from './migrate-legacy.js';

/** The same output options as every YAML palm writes (lib/yaml.ts). */
const TO_STRING = { lineWidth: 0, minContentWidth: 0, flowCollectionPadding: false } as const;

type Commented = Node & { commentBefore?: string | null; comment?: string | null };

/** Where comments go in the new document: above `section` or above its key `key`. */
interface Place {
  section: 'sources' | 'mcp';
  key?: string;
}

/** The comments of the 0.1 file, sorted by where they go (in document order). */
interface Carried {
  /** Above the document (followed by a blank line), and above its first key. */
  head: string[];
  first: string[];
  targets: string[];
  /** After the last key (the 0.1 file's own closing comment). */
  end: string[];
  placed: Map<string, { place: Place; texts: string[] }>;
  rest: string[];
}

function push(list: string[], text: string | null | undefined): void {
  const t = text?.trimEnd();
  if (t) list.push(t);
}

function place(c: Carried, where: Place | undefined, text: string | null | undefined): void {
  if (!where) {
    push(c.rest, text);
    return;
  }
  const id = `${where.section}\u0000${where.key ?? ''}`;
  const slot = c.placed.get(id) ?? { place: where, texts: [] };
  push(slot.texts, text);
  c.placed.set(id, slot);
}

/** Every comment inside `node` (its own, its pairs', its items'), in document order. */
function commentsIn(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as Commented;
  const out: string[] = [];
  push(out, n.commentBefore);
  if (isMap(n)) for (const p of n.items) out.push(...commentsIn(p.key), ...commentsIn(p.value));
  if (isSeq(n)) for (const item of n.items) out.push(...commentsIn(item));
  push(out, n.comment);
  return out;
}

/** The migration's source key for each 0.1 alias and source name (lower case). */
function aliasKeys(m: Migration): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of m.sources) {
    out.set(s.source.name.toLowerCase(), s.source.name);
    if (s.source.alias) out.set(s.source.alias.toLowerCase(), s.source.name);
  }
  return out;
}

/** The alias an origin item (`alias:`) or an entry (`name@alias#ref`, `origin:`) names. */
function aliasOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const head = value.split('#')[0] ?? '';
    const at = head.lastIndexOf('@');
    return at > 0 ? head.slice(at + 1) : undefined;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.alias === 'string') return value.alias;
  return typeof value.origin === 'string' ? value.origin : undefined;
}

/** Where a 0.1 list item's comments go: its source, else (an inline server) its `mcp:` key. */
function itemPlace(section: string, item: unknown, keys: Map<string, string>): Place | undefined {
  const value = isScalar(item) || isMap(item) ? item.toJSON() : undefined;
  const alias = aliasOf(value);
  const key = alias ? keys.get(alias.toLowerCase()) : undefined;
  if (key) return { section: 'sources', key };
  if (section === 'mcp' && isRecord(value) && typeof value.name === 'string')
    return { section: 'mcp', key: value.name };
  return undefined;
}

/** A dropped section (`origins:`, `skills:`, `mcp:` …): its comments follow its items. */
function carrySection(c: Carried, pair: Pair, keys: Map<string, string>): void {
  const name = isScalar(pair.key) ? String(pair.key.value) : '';
  const own: Place = { section: name === 'mcp' ? 'mcp' : 'sources' };
  place(c, own, (pair.key as Commented | null)?.commentBefore);
  const value = pair.value as Commented | null;
  if (!isSeq(value)) {
    for (const t of commentsIn(value)) place(c, own, t);
    return;
  }
  const [first] = value.items;
  place(c, first ? (itemPlace(name, first, keys) ?? own) : own, value.commentBefore);
  for (const item of value.items)
    for (const t of commentsIn(item)) place(c, itemPlace(name, item, keys), t);
  place(c, own, value.comment);
}

/** Every comment of the 0.1 document, sorted by where it goes. */
function carried(old: Document, m: Migration): Carried {
  const c: Carried = { head: [], first: [], targets: [], end: [], placed: new Map(), rest: [] };
  push(c.head, old.commentBefore);
  const keys = aliasKeys(m);
  const pairs = isMap(old.contents) ? old.contents.items : [];
  for (const [i, pair] of pairs.entries()) {
    const key = pair.key as Commented | null;
    if (i === 0) {
      push(c.first, key?.commentBefore);
      if (key) key.commentBefore = null;
    }
    if (isScalar(pair.key) && pair.key.value === 'targets') {
      push(c.targets, key?.commentBefore);
      c.targets.push(...commentsIn(pair.value));
    } else carrySection(c, pair, keys);
  }
  push(c.end, old.comment);
  return c;
}

function pairOf(map: unknown, key: string): Pair | undefined {
  if (!isMap(map)) return undefined;
  return (map as YAMLMap).items.find((p) => isScalar(p.key) && String(p.key.value) === key);
}

/** Appends `texts` to a comment slot of `node`; false when there is no node. */
function attach(node: unknown, slot: 'commentBefore' | 'comment', texts: string[]): boolean {
  if (!texts.length) return true;
  if (!node || typeof node !== 'object') return false;
  const n = node as Commented;
  n[slot] = [n[slot], ...texts].filter(Boolean).join('\n');
  return true;
}

function placeAll(doc: Document, c: Carried): void {
  attach(doc, 'commentBefore', c.head);
  const first = isMap(doc.contents) ? (doc.contents as YAMLMap).items[0] : undefined;
  if (!attach(first?.key, 'commentBefore', c.first)) attach(doc, 'commentBefore', c.first);
  if (!attach(pairOf(doc.contents, 'targets')?.value, 'comment', c.targets))
    c.rest.push(...c.targets);
  for (const { place: p, texts } of c.placed.values()) {
    const top = pairOf(doc.contents, p.section);
    const pair = (p.key ? pairOf(top?.value, p.key) : undefined) ?? top;
    if (!attach(pair?.key, 'commentBefore', texts)) c.rest.push(...texts);
  }
}

/**
 * `fresh` (the migrated palm.yaml as palm writes it) with the comments of `oldText` (the 0.1
 * palm.yaml) carried over; `fresh` itself when the old file has none or does not parse.
 */
export function withLegacyComments(
  fresh: string,
  oldText: string | undefined,
  m: Migration,
): string {
  if (!oldText?.includes('#')) return fresh;
  const old = parseDocument(oldText);
  if (old.errors.length) return fresh;
  const c = carried(old, m);
  const doc = parseDocument(fresh);
  placeAll(doc, c);
  attach(doc, 'comment', c.end);
  if (c.rest.length) attach(doc, 'comment', [' from palm 0.1:', ...c.rest]);
  return doc.toString(TO_STRING);
}
