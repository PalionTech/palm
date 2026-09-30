/**
 * The provisional lock of `palm migrate` (DESIGN §6 "Migrate"): the files and fragments palm 0.1
 * wrote, as lock entries, so the first 0.2 install may replace them. Only what still holds what
 * 0.1 recorded is adopted (a file with its recorded hash, a fragment with its recorded value);
 * anything the person changed stays theirs. Fragments are keyed the 0.2 way (`at` is the 0.1
 * pointer, `key` the object key, table name, block id or hook identity), so a re-rendered server
 * or hook replaces its 0.1 fragment in place and never takes the rest of the file with it.
 *
 * Under -g a 0.1 lock holds absolute paths. Paths written under another home directory (a
 * dotfiles lock from an old machine) are moved onto this machine's harness homes before they
 * become tokens.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { hashPath } from '../core/hash.js';
import type { LegacyLockEntry, LockEntry, LockMerged } from '../core/types.js';
import { fragmentId, fragmentKey, Lock } from '../domain/lock.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { parseJson } from '../lib/json.js';
import { parsePointer } from '../lib/json-pointer.js';
import { deepEqual, isRecord } from '../lib/object.js';
import { replacePlaceholders } from '../lib/placeholders.js';
import { kindOf, type LegacyItem, type Migration } from './migrate-legacy.js';

/** The provisional lock and, per adopted file (absolute path), the hash 0.1 recorded for it. */
export interface Provisional {
  lock: Lock;
  hashes: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Paths of a 0.1 lock on this machine
// ---------------------------------------------------------------------------

type HomeDir = (paths: ScopePaths) => string;

/** A harness home's first path segments below a home directory, and where it is on this machine. */
const HOME_LAYOUT: ReadonlyArray<[string[], HomeDir]> = [
  [['.config', 'opencode'], (p) => p.token('opencode')],
  [['.claude'], (p) => p.token('claude')],
  [['.claude.json'], (p) => join(p.home, '.claude.json')],
  [['.agents'], (p) => p.token('agents')],
  [['.codex'], (p) => p.token('codex')],
  [['.copilot'], (p) => p.token('copilot')],
  [['.cursor'], (p) => p.token('cursor')],
  [['.gemini'], (p) => p.token('gemini')],
  [['.palm'], (p) => p.palmHome],
];

function layoutAt(segments: string[], i: number): [number, HomeDir] | undefined {
  for (const [head, dir] of HOME_LAYOUT)
    if (head.every((h, j) => segments[i + j] === h)) return [head.length, dir];
  return undefined;
}

/**
 * Where an absolute 0.1 global path is on this machine: itself inside the scope, else, when it
 * was written under another home directory, the same place below this machine's harness home
 * (`/Users/old/.claude/skills/x` → `~/.claude/skills/x`), found by the first harness-home segment.
 */
export function onThisMachine(paths: ScopePaths, abs: string): string {
  if (paths.contains(abs)) return abs;
  const segments = abs.split(sep);
  for (let i = 1; i < segments.length; i++) {
    const hit = layoutAt(segments, i);
    if (hit) return join(hit[1](paths), ...segments.slice(i + hit[0]));
  }
  return abs;
}

/** The absolute path of a 0.1 lock path: project-relative, or absolute under -g. */
function absOf(paths: ScopePaths, p: string): string {
  if (paths.scope === 'project' || !isAbsolute(p)) return paths.abs(p);
  return onThisMachine(paths, p);
}

/** The lock form of `abs`, or undefined when it lies outside the scope. */
function lockFormOf(paths: ScopePaths, abs: string): string | undefined {
  try {
    return paths.lockForm(abs);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Files and fragments 0.1 wrote that still hold what it recorded
// ---------------------------------------------------------------------------

interface Adopted {
  lockPath: string;
  abs: string;
  hash: string;
}

async function untouched(
  paths: ScopePaths,
  file: string | { path: string; hash: string },
): Promise<Adopted | undefined> {
  if (typeof file === 'string') return undefined;
  const abs = absOf(paths, file.path);
  const hash = await hashPath(abs).catch(() => undefined);
  const lockPath = hash === file.hash ? lockFormOf(paths, abs) : undefined;
  return lockPath ? { lockPath, abs, hash: file.hash } : undefined;
}

/**
 * A recorded string matches the one on disk when equal, or when the recorded one has `${VAR}`
 * placeholders and the disk has any text in their place (0.1 recorded secrets redacted).
 */
function stringMatches(actual: string, recorded: string): boolean {
  if (actual === recorded) return true;
  const parts = replacePlaceholders(recorded, () => '\u0000').split('\u0000');
  if (parts.length === 1) return false;
  const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('[\\s\\S]*')}$`).test(actual);
}

function matchesRecorded(actual: unknown, recorded: unknown): boolean {
  if (typeof actual === 'string' && typeof recorded === 'string')
    return stringMatches(actual, recorded);
  if (Array.isArray(recorded))
    return (
      Array.isArray(actual) &&
      actual.length === recorded.length &&
      recorded.every((x, i) => matchesRecorded(actual[i], x))
    );
  if (isRecord(actual) && isRecord(recorded)) {
    const keys = Object.keys(recorded).filter((k) => recorded[k] !== undefined);
    const own = Object.keys(actual).filter((k) => actual[k] !== undefined);
    return own.length === keys.length && keys.every((k) => matchesRecorded(actual[k], recorded[k]));
  }
  return deepEqual(actual, recorded);
}

function valueAt(doc: unknown, segments: string[]): unknown {
  let cur = doc;
  for (const s of segments)
    cur = isRecord(cur) || Array.isArray(cur) ? (cur as Record<string, unknown>)[s] : undefined;
  return cur;
}

/** 0.1 fragments are items of arrays under `/hooks/<event>` and `/instructions`, else object keys. */
function isItem(pointer: string): boolean {
  return /^\/hooks\/[^/]+$/.test(pointer) || pointer === '/instructions';
}

async function holds(abs: string, m: { pointer: string; value: unknown }): Promise<boolean> {
  const text = await readFile(abs, 'utf8').catch(() => undefined);
  if (text === undefined) return false;
  if (m.pointer.startsWith('block:'))
    return typeof m.value === 'string' && text.includes(m.value.trim());
  try {
    const doc = abs.endsWith('.toml') ? parseToml(text) : parseJson(text, { tolerant: true });
    const at = valueAt(doc, parsePointer(m.pointer));
    return isItem(m.pointer) && Array.isArray(at)
      ? at.some((x) => matchesRecorded(x, m.value))
      : matchesRecorded(at, m.value);
  } catch {
    return false;
  }
}

async function mergedOf(paths: ScopePaths, item: LegacyItem): Promise<LockMerged[]> {
  const out: LockMerged[] = [];
  for (const [n, m] of (item.entry.merged ?? []).entries()) {
    const abs = absOf(paths, m.file);
    const file = lockFormOf(paths, abs);
    if (!file || !(await holds(abs, m))) continue;
    out.push({
      file,
      at: m.pointer,
      key: fragmentKey(m.pointer, m.value),
      id: fragmentId({ kind: item.kind, name: item.entry.name }, n),
    });
  }
  return out;
}

async function provisional(
  paths: ScopePaths,
  item: LegacyItem,
  hashes: Map<string, string>,
): Promise<LockEntry> {
  const e: LegacyLockEntry = item.entry;
  const files: string[] = [];
  for (const f of e.files ?? []) {
    const kept = await untouched(paths, f);
    if (!kept) continue;
    files.push(kept.lockPath);
    hashes.set(kept.abs, kept.hash);
  }
  const entry: LockEntry = {
    kind: item.kind,
    name: e.name,
    source: item.source,
    path: e.path,
    content: e.contentHash ?? '',
    render: {},
    files: [...new Set(files)].sort(),
  };
  const merged = await mergedOf(paths, item);
  if (merged.length) entry.merged = merged;
  if (item.via) entry.via = item.via;
  if (item.kind === 'plugin' && e.deps?.length)
    entry.deps = e.deps.map((d) => ({ kind: kindOf(d.kind), name: d.name }));
  return entry;
}

/**
 * The migration's sources and the 0.1 entries as a version 3 lock. Its entries have no render
 * hash: the first install renders them and replaces what 0.1 wrote (DESIGN §6 "Migrate").
 */
export async function provisionalLock(paths: ScopePaths, m: Migration): Promise<Provisional> {
  const lock = new Lock();
  const hashes = new Map<string, string>();
  for (const s of m.sources) {
    const ls = { ...s.lock };
    const path = s.source.path ? lockFormOf(paths, s.source.path) : undefined;
    if (path) ls.path = path;
    lock.setSource(s.source.name, ls);
  }
  for (const item of m.legacy) lock.upsert(await provisional(paths, item, hashes));
  return { lock, hashes };
}
