/**
 * The shape of palm.yaml v3 (DESIGN.md section 3): format detection (0.1 files point at
 * `palm migrate`) and the checks the loader runs, each E_PARSE naming the key.
 */
import path from 'node:path';
import { messageOf, PalmError } from '../core/errors.js';
import { manifestKey } from '../core/kinds.js';
import { KINDS, type Manifest as ManifestData, TARGET_IDS, type TargetId } from '../core/types.js';
import { isSafeName } from '../lib/names.js';
import { isRecord } from '../lib/object.js';
import { closestWord } from '../lib/text.js';
import { isLegacyDepString, parseEntityRef, REF_GRAMMAR } from './entity-ref.js';

/** The per-kind entry lists under a source, in KINDS order. */
export const ENTRY_KEYS: readonly string[] = KINDS.map(manifestKey);

/** The keys an entry object may carry (DESIGN §3); `secrets: literal` records `--secrets literal`. */
const ENTRY_OBJECT_KEYS: readonly string[] = [
  'name',
  'targets',
  'at',
  'only',
  'exclude',
  'render',
  'secrets',
];

/** The keys a source body may carry besides its entry lists. */
const SOURCE_KEYS: readonly string[] = ['url', 'path', 'root', 'ref', 'alias', 'layout'];

/** The keys a hand-declared server under `mcp:` may carry. */
const MCP_KEYS: readonly string[] = [
  'transport',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'targets',
  'secrets',
];

/** 0.1 top-level entry lists (`commands` included). */
const LEGACY_TOP_KEYS = ['skills', 'agents', 'instructions', 'commands', 'hooks', 'plugins'];

/** The name an entry list item gives: the string, or an object's `name`. */
function itemName(item: unknown): string[] {
  if (typeof item === 'string') return [item];
  return isRecord(item) && typeof item.name === 'string' ? [item.name] : [];
}

/** Every entry name written under the sources. */
function entryStrings(sources: Record<string, unknown>): string[] {
  return Object.values(sources).flatMap((body) =>
    isRecord(body)
      ? ENTRY_KEYS.flatMap((key) => (Array.isArray(body[key]) ? body[key].flatMap(itemName) : []))
      : [],
  );
}

/**
 * Which palm.yaml format `raw` is: `empty` (nothing, or an empty mapping), `legacy` (0.1: a
 * top-level `origins:` list, top-level kind lists or an `mcp:` list, or `name@source` / `#ref`
 * entries), else 3.
 */
export function detectManifestFormat(raw: unknown): 3 | 'legacy' | 'empty' {
  if (raw === undefined || raw === null) return 'empty';
  if (!isRecord(raw)) return 3;
  if (Object.keys(raw).length === 0) return 'empty';
  if (raw.origins !== undefined || Array.isArray(raw.mcp)) return 'legacy';
  if (LEGACY_TOP_KEYS.some((k) => raw[k] !== undefined)) return 'legacy';
  const sources = isRecord(raw.sources) ? raw.sources : {};
  return entryStrings(sources).some(isLegacyDepString) ? 'legacy' : 3;
}

function bad(file: string, key: string, why: string, hint?: string): PalmError {
  return new PalmError(
    'E_PARSE',
    `${path.basename(file)}: ${key} ${why}`,
    hint ?? `fix ${key} in ${file}`,
  );
}

/**
 * E_PARSE for the first key of `body` that is not in `known`, with the closest known key as a
 * did-you-mean (`target` → `targets`); palm never guesses what an unknown key meant.
 */
function checkKeys(
  file: string,
  key: string,
  body: Record<string, unknown>,
  known: readonly string[],
) {
  const unknown = Object.keys(body).find((k) => !known.includes(k));
  if (unknown === undefined) return;
  const near = closestWord(unknown, known);
  const guess = near ? ` (did you mean ${near}?)` : '';
  throw bad(
    file,
    key,
    `has an unknown key "${unknown}"${guess}`,
    near
      ? `rename it to ${near} in ${file}`
      : `remove it from ${file} (known: ${known.join(', ')})`,
  );
}

function checkSecretsKey(file: string, key: string, raw: unknown): void {
  if (raw === undefined || raw === 'literal') return;
  throw bad(
    file,
    key,
    `must be literal (got "${String(raw)}")`,
    `remove it, or write secrets: literal`,
  );
}

function checkTargets(file: string, key: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) throw bad(file, key, 'must be a list of targets');
  for (const t of raw) {
    if (!TARGET_IDS.includes(t as TargetId))
      throw bad(
        file,
        key,
        `names an unknown target "${String(t)}" (known: ${TARGET_IDS.join(', ')})`,
      );
  }
}

function checkEntry(file: string, key: string, item: unknown, scopeTargets: unknown): void {
  if (typeof item === 'string' && item.trim()) return;
  if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim())
    throw bad(file, key, 'must be a name or a mapping with a name');
  checkKeys(file, key, item, ENTRY_OBJECT_KEYS);
  checkSecretsKey(file, `${key}.secrets`, item.secrets);
  checkTargets(file, `${key}.targets`, item.targets);
  const outside =
    Array.isArray(item.targets) && Array.isArray(scopeTargets)
      ? item.targets.find((t) => !scopeTargets.includes(t))
      : undefined;
  if (outside !== undefined)
    throw bad(
      file,
      `${key}.targets`,
      `names ${String(outside)}, which is not in targets: at the top`,
      `add ${String(outside)} to targets: in ${file}`,
    );
  for (const k of ['only', 'exclude']) checkMembers(file, `${key}.${k}`, item[k]);
}

/** An `only`/`exclude` list: `kind:name` (or name) items. */
function checkMembers(file: string, key: string, list: unknown): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) throw bad(file, key, 'must be a list of kind:name items');
  for (const x of list) {
    if (typeof x !== 'string') throw bad(file, key, 'must be a list of kind:name items');
    try {
      parseEntityRef(x);
    } catch (e) {
      throw bad(file, key, `has "${x}": ${messageOf(e)}`, REF_GRAMMAR);
    }
  }
}

function checkSource(file: string, name: string, body: unknown, scopeTargets: unknown): void {
  const key = `sources."${name}"`;
  if (body === null || body === undefined) return;
  if (!isRecord(body)) throw bad(file, key, 'must be a mapping');
  checkKeys(file, key, body, [...SOURCE_KEYS, ...ENTRY_KEYS]);
  for (const listKey of ENTRY_KEYS) {
    const list = body[listKey];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) throw bad(file, `${key}.${listKey}`, 'must be a list');
    for (const [i, item] of list.entries())
      checkEntry(file, `${key}.${listKey}[${i}]`, item, scopeTargets);
  }
}

/** `ignore:`: a list of `<check>:<what>` keys a check printed (O19 J13'). */
function checkIgnore(file: string, raw: unknown): void {
  if (raw === undefined || raw === null) return;
  const keys = Array.isArray(raw) ? raw : [raw];
  const wrong = keys.find((k) => typeof k !== 'string' || !/^[a-z-]+:\S/.test(k));
  if (Array.isArray(raw) && wrong === undefined) return;
  throw bad(
    file,
    'ignore',
    'must be a list of the keys palm check prints (hidden-unicode:<source>/<path>, foreign-hooks:<file>#<event>, foreign-servers:<file>#<name>)',
  );
}

function checkMcp(file: string, raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (!isRecord(raw)) throw bad(file, 'mcp', 'must be a mapping of server names');
  for (const [name, entry] of Object.entries(raw)) {
    if (!isSafeName(name)) throw bad(file, `mcp."${name}"`, 'is not a valid server name');
    if (!isRecord(entry)) throw bad(file, `mcp."${name}"`, 'must be a mapping');
    checkKeys(file, `mcp."${name}"`, entry, MCP_KEYS);
    checkSecretsKey(file, `mcp."${name}".secrets`, entry.secrets);
    checkTargets(file, `mcp."${name}".targets`, entry.targets);
  }
}

/**
 * `data` checked as palm.yaml v3 (an empty document is `{}`). 0.1 content is E_USAGE with the
 * hint `palm migrate`; a malformed key is E_PARSE naming it.
 */
export function checkedManifest(file: string, data: unknown): ManifestData {
  const format = detectManifestFormat(data);
  if (format === 'empty') return {};
  if (format === 'legacy')
    throw new PalmError('E_USAGE', `${path.basename(file)} is in the 0.1 format`, 'palm migrate');
  if (!isRecord(data)) throw bad(file, 'the document', 'must be a mapping');
  checkTargets(file, 'targets', data.targets);
  if (data.sources !== undefined && data.sources !== null) {
    if (!isRecord(data.sources)) throw bad(file, 'sources', 'must be a mapping of source names');
    for (const [name, body] of Object.entries(data.sources))
      checkSource(file, name, body, data.targets);
  }
  checkMcp(file, data.mcp);
  checkIgnore(file, data.ignore);
  return data as ManifestData;
}
