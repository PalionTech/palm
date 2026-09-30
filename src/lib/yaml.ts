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

/** Where a node sits in a document: the keys and indexes from the root. */
export type YamlPath = ReadonlyArray<string | number>;

/** Whether the collection at `path`, holding `value`, is written in flow style (`[a, b]`, `{ a: 1 }`). */
type FlowRule = (path: YamlPath, value: unknown) => boolean;

export interface StringifyYamlOptions {
  /** Collections this accepts are written in flow style. */
  flow?: FlowRule;
  /** Comment (one or more lines, without `#`) placed above the document. */
  comment?: string;
}

/** Decides whether the collection `node` at `path` is written in flow style. */
type FlowTest = (path: YamlPath, node: YAMLMap | YAMLSeq) => boolean;

/** Sets `flow` on every collection below `node` that `test` accepts. */
function markFlow(node: unknown, path: YamlPath, test: FlowTest): void {
  let children: Array<[string | number, unknown]> = [];
  if (isMap(node)) children = node.items.map((p) => [keyString(p.key), p.value]);
  else if (isSeq(node)) children = node.items.map((child, i) => [i, child]);
  for (const [key, child] of children) {
    const at = [...path, key];
    if ((isMap(child) || isSeq(child)) && test(at, child)) child.flow = true;
    markFlow(child, at, test);
  }
}

/**
 * The flow test of a write: top-level `flowKeys` lists and whatever `flow` accepts. With
 * `onlyNew`, only nodes the patch created (no source range) are touched, so a file's own style
 * survives.
 */
function flowTest(opts: WriteYamlOptions, onlyNew: boolean): FlowTest {
  return (p, node) => {
    if (onlyNew && node.range) return false;
    const key = p.length === 1 ? String(p[0]) : undefined;
    if (key !== undefined && isSeq(node) && opts.flowKeys?.includes(key)) return true;
    return !!opts.flow?.(p, node.toJSON());
  };
}

function commentText(comment: string): string {
  return comment
    .split('\n')
    .map((l) => ` ${l}`)
    .join('\n');
}

/**
 * `value` as YAML text (block style, no folding, trailing newline). `opts.flow` picks the
 * collections written in flow style; `opts.comment` goes above the document. The same value and
 * options always give the same text.
 */
export function stringifyYaml(value: unknown, opts: StringifyYamlOptions = {}): string {
  if (!opts.flow && opts.comment === undefined) return stringify(value, TO_STRING);
  const doc = new Document(value);
  const { flow } = opts;
  if (flow) markFlow(doc.contents, [], (p, node) => flow(p, node.toJSON()));
  if (opts.comment !== undefined) {
    if (doc.contents) doc.contents.commentBefore = commentText(opts.comment);
    else doc.commentBefore = commentText(opts.comment);
  }
  return doc.toString(TO_STRING);
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
  /** Top-level keys whose lists are written in flow style (`[a, b]`) when the write creates them. */
  flowKeys?: readonly string[];
  /** Collections this accepts are written in flow style when the write creates them. */
  flow?: FlowRule;
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

/** `node` updated in place to represent `value`, keeping unchanged nodes and their comments. */
function updateNode(doc: Document, node: unknown, value: unknown): unknown {
  if (isNode(node) && deepEqual(nodeJS(node), value)) return node;
  if (isSeq(node) && Array.isArray(value)) return updateSeq(doc, node, value);
  if (isMap(node) && isRecord(value)) return updateMap(doc, node, value);
  return doc.createNode(value);
}

/** `base` patched to hold `value`; undefined when `base` is blank or not valid YAML. */
function patchYaml(base: string, value: unknown, opts: WriteYamlOptions): string | undefined {
  if (base.trim() === '') return undefined;
  const doc = parseDocument(base);
  if (doc.errors.length > 0) return undefined;
  doc.contents = updateNode(doc, doc.contents, value) as typeof doc.contents;
  markFlow(doc.contents, [], flowTest(opts, true));
  return doc.toString(TO_STRING);
}

function freshYaml(value: unknown, opts: WriteYamlOptions): string {
  const doc = new Document(value);
  const root = doc.contents;
  markFlow(root, [], flowTest(opts, false));
  if (opts.comment !== undefined && root) root.commentBefore = commentText(opts.comment);
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
  const text = (base !== false && patchYaml(base, value, opts)) || freshYaml(value, opts);
  await writeFileAtomic(file, text, opts.mode === undefined ? {} : { mode: opts.mode });
}
