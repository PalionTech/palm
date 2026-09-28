/**
 * YAML text and files. Writing an existing file patches its Document (yaml's AST), so
 * comments, key order and untouched nodes survive; new files are written in block style.
 */
import {
  Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import { readTextIfExists, writeFileAtomic } from './fs.js';
import { deepEqual, isRecord } from './object.js';

/** Output options for every YAML palm writes: block style, no line folding. */
const TO_STRING = { lineWidth: 0, minContentWidth: 0, flowCollectionPadding: false } as const;

/**
 * Parses one YAML document; undefined for an empty (or `null`) document. Throws an Error
 * naming `source` (a file name) on invalid YAML.
 */
export function parseYaml<T = unknown>(text: string, source?: string): T | undefined {
  const doc = parseDocument(text);
  const err = doc.errors[0];
  if (err) throw new Error(`invalid YAML${source ? ` in ${source}` : ''}: ${err.message}`);
  return (doc.toJS() ?? undefined) as T | undefined;
}

/** `value` as YAML text (block style, no folding, trailing newline). */
export function stringifyYaml(value: unknown): string {
  return stringify(value, TO_STRING);
}

/** A single YAML scalar for `value`, quoted only when YAML requires it (no trailing newline). */
export function yamlScalar(value: string): string {
  return stringify(value, TO_STRING).replace(/\n+$/, '');
}

/** Reads and parses a YAML file; undefined when it is missing or empty. See `parseYaml`. */
export async function readYamlFile<T = unknown>(file: string): Promise<T | undefined> {
  const text = await readTextIfExists(file);
  return text === undefined ? undefined : parseYaml<T>(text, file);
}

export interface WriteYamlOptions {
  /** YAML text to patch; default: the file's current content. `false` writes a fresh document. */
  preserveFrom?: string | false;
  /** Top-level keys whose lists are written in flow style (`[a, b]`) in a fresh document. */
  flowKeys?: readonly string[];
  /** Comment (one or more lines, without `#`) placed above a fresh document. */
  comment?: string;
  /** Permission bits for the file (see `writeFileAtomic`). */
  mode?: number;
}

function keyString(key: unknown): string {
  return isScalar(key) ? String(key.value) : String(key);
}

function nodeJS(node: unknown): unknown {
  return isNode(node) ? node.toJSON() : node;
}

/** Reuses equal items (any position) and edits nested collections in place (same position). */
function updateSeq(doc: Document, node: YAMLSeq, value: unknown[]): YAMLSeq {
  const old = node.items;
  const used = new Set<number>();
  const matched = value.map((v) => {
    const i = old.findIndex((n, j) => !used.has(j) && deepEqual(nodeJS(n), v));
    if (i >= 0) used.add(i);
    return i;
  });
  node.items = value.map((v, i) => {
    const m = matched[i] as number;
    if (m >= 0) return old[m];
    if (i < old.length && !used.has(i) && (isMap(old[i]) || isSeq(old[i]))) {
      used.add(i);
      return updateNode(doc, old[i], v);
    }
    return doc.createNode(v);
  });
  return node;
}

/**
 * Drops removed keys and patches kept ones; a new key goes where `value` orders it among the
 * existing ones (before the first later key the node has, else at the end).
 */
function updateMap(doc: Document, node: YAMLMap, value: Record<string, unknown>): YAMLMap {
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  const indexOf = (k: string) => node.items.findIndex((p) => keyString(p.key) === k);
  node.items = node.items.filter((p) => keys.includes(keyString(p.key)));
  keys.forEach((k, i) => {
    const pair = node.items[indexOf(k)];
    if (pair) {
      pair.value = updateNode(doc, pair.value, value[k]);
      return;
    }
    const before = keys
      .slice(i + 1)
      .map(indexOf)
      .find((j) => j >= 0);
    const created = doc.createPair(k, value[k]);
    if (before === undefined) node.items.push(created);
    else node.items.splice(before, 0, created);
  });
  return node;
}

/** Top-level `flowKeys` sequences the patch created are written in flow style (`[a, b]`). */
function flowNewKeys(doc: Document, existing: ReadonlySet<string>, flowKeys: readonly string[]) {
  const root = doc.contents;
  if (!isMap(root)) return;
  for (const p of root.items) {
    const key = keyString(p.key);
    if (!existing.has(key) && flowKeys.includes(key) && isSeq(p.value)) p.value.flow = true;
  }
}

/** `node` updated in place to represent `value`, keeping unchanged nodes and their comments. */
function updateNode(doc: Document, node: unknown, value: unknown): unknown {
  if (isNode(node) && deepEqual(nodeJS(node), value)) return node;
  if (isSeq(node) && Array.isArray(value)) return updateSeq(doc, node, value);
  if (isMap(node) && isRecord(value)) return updateMap(doc, node, value);
  return doc.createNode(value);
}

/** `base` patched to hold `value`; undefined when `base` is blank or not valid YAML. */
function patchYaml(base: string, value: unknown, flowKeys: readonly string[]): string | undefined {
  if (base.trim() === '') return undefined;
  const doc = parseDocument(base);
  if (doc.errors.length > 0) return undefined;
  const root = doc.contents;
  const existing = new Set(isMap(root) ? root.items.map((p) => keyString(p.key)) : []);
  doc.contents = updateNode(doc, doc.contents, value) as typeof doc.contents;
  flowNewKeys(doc, existing, flowKeys);
  return doc.toString(TO_STRING);
}

function freshYaml(value: unknown, opts: WriteYamlOptions): string {
  const doc = new Document(value);
  const root = doc.contents;
  if (isMap(root)) {
    for (const p of root.items) {
      if (opts.flowKeys?.includes(keyString(p.key)) && isSeq(p.value)) p.value.flow = true;
    }
  }
  if (opts.comment !== undefined && root) {
    root.commentBefore = opts.comment
      .split('\n')
      .map((l) => ` ${l}`)
      .join('\n');
  }
  return doc.toString(TO_STRING);
}

/**
 * Writes `value` as YAML with `writeFileAtomic`. Existing content (or `preserveFrom`) that
 * parses is patched so its comments, key order and unchanged nodes survive; otherwise a fresh
 * document is written.
 */
export async function writeYamlFile(
  file: string,
  value: unknown,
  opts: WriteYamlOptions = {},
): Promise<void> {
  const base = opts.preserveFrom ?? (await readTextIfExists(file)) ?? '';
  const text =
    (base !== false && patchYaml(base, value, opts.flowKeys ?? [])) || freshYaml(value, opts);
  await writeFileAtomic(file, text, opts.mode === undefined ? {} : { mode: opts.mode });
}
