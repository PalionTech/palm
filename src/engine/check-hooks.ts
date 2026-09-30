/**
 * The hook arrays palm merges into (`/hooks/<Event>` of `.claude/settings.json`,
 * `.cursor/hooks.json`, …), read as the harness reads them (D3, V6): every command there is
 * either explained by an installed entry's render, or foreign. A foreign command in the array
 * where one of palm's own commands went missing (same matcher) is palm's entry changed on disk
 * (a tampered command is `changed`, never re-added beside it); any other is a hand-added hook
 * that `check` names as a warning. Nothing is written.
 */
import { readFile } from 'node:fs/promises';
import type { LockEntry } from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import { parseJson } from '../lib/json.js';
import { parsePointer } from '../lib/json-pointer.js';
import { isRecord } from '../lib/object.js';
import type { CheckContext } from './check-kit.js';

/** One command on disk that no lock entry explains. */
export interface HookFinding {
  /** Lock form of the harness file. */
  file: string;
  event: string;
  command: string;
  /** The entry whose command went missing where this one sits (a changed entry), if any. */
  owner?: LockEntry;
}

const HOOK_AT = /^\/hooks\/[^/]+$/;
/** One analysis per check run: `exec-trusted` and `foreign-hooks` share it. */
const MEMO = new WeakMap<CheckContext, Promise<HookFinding[]>>();
const COMMAND_KEYS = ['command', 'bash', 'powershell'];

/** Every command string of a hook item, at any depth (`command`, `bash`, `powershell`). */
function commandsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(commandsIn);
  if (!isRecord(value)) return [];
  const own = COMMAND_KEYS.map((k) => value[k]).filter((v): v is string => typeof v === 'string');
  return [
    ...own,
    ...Object.values(value).flatMap((v) => (isRecord(v) || Array.isArray(v) ? commandsIn(v) : [])),
  ];
}

function matcherOf(value: unknown): string {
  return isRecord(value) && typeof value.matcher === 'string' ? value.matcher : '';
}

/** The array at `at` in the JSON file, as the harness reads it; undefined when absent. */
async function itemsAt(abs: string, at: string): Promise<unknown[] | undefined> {
  const text = await readFile(abs, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  let node: unknown;
  try {
    node = parseJson(text, { tolerant: true });
  } catch {
    return undefined;
  }
  for (const segment of parsePointer(at)) node = isRecord(node) ? node[segment] : undefined;
  return Array.isArray(node) ? node : undefined;
}

interface PalmItem {
  entry: LockEntry;
  value: unknown;
}

interface HookArray {
  file: string;
  at: string;
  palm: PalmItem[];
}

/** Hook arrays an entry merged into that palm could not render again (offline): not judged. */
function unrendered(c: CheckContext): Set<string> {
  const out = new Set<string>();
  for (const e of c.run.state.lock.entries)
    if (!c.renders.get(lockId(e))) for (const m of e.merged ?? []) out.add(`${m.file}#${m.at}`);
  return out;
}

/**
 * The hook arrays the lock says palm merged into (`file#at`), each with palm's items as the
 * entries' recomputed renders have them (only fragments the lock records as written). An array
 * an entry merged into that palm could not render is left out: nothing there can be judged.
 */
function arrays(c: CheckContext): Map<string, HookArray> {
  const { entries } = c.run.state.lock;
  const blind = unrendered(c);
  const merged = entries
    .flatMap((e) => e.merged ?? [])
    .filter((m) => HOOK_AT.test(m.at) && m.file.endsWith('.json'))
    .filter((m) => !blind.has(`${m.file}#${m.at}`));
  const recorded = new Set(merged.map((m) => `${m.file}#${m.at}#${m.key}`));
  const out = new Map<string, HookArray>();
  for (const m of merged)
    if (!out.has(`${m.file}#${m.at}`)) out.set(`${m.file}#${m.at}`, { ...m, palm: [] });
  for (const e of entries) {
    const fragments = Object.values(c.renders.get(lockId(e))?.renders ?? {}).flatMap(
      (r) => r?.fragments ?? [],
    );
    for (const f of fragments.filter((x) => recorded.has(`${x.file}#${x.at}#${x.key}`)))
      out.get(`${f.file}#${f.at}`)?.palm.push({ entry: e, value: f.value });
  }
  return out;
}

/** Commands palm's lock explains even without a render (the lock's recorded commands). */
function lockCommands(c: CheckContext): Set<string> {
  return new Set(
    c.run.state.lock.entries.flatMap((e) => (e.exec?.commands ?? []).map((x) => x.command)),
  );
}

function findingsIn(arr: HookArray, disk: unknown[], explained: Set<string>): HookFinding[] {
  const onDisk = new Set(disk.flatMap(commandsIn));
  const gone = arr.palm.filter((p) => commandsIn(p.value).some((cmd) => !onDisk.has(cmd)));
  const event = arr.at.slice('/hooks/'.length);
  const out: HookFinding[] = [];
  for (const item of disk)
    for (const command of commandsIn(item)) {
      if (explained.has(command)) continue;
      const owner = gone.find((p) => matcherOf(p.value) === matcherOf(item))?.entry;
      out.push(
        owner ? { file: arr.file, event, command, owner } : { file: arr.file, event, command },
      );
    }
  return out;
}

/**
 * Every command in a hook array palm merges into that no installed entry explains: foreign,
 * or (`owner` set) standing where that entry's own command went missing.
 */
export function hookFindings(c: CheckContext): Promise<HookFinding[]> {
  const known = MEMO.get(c);
  if (known) return known;
  const next = findAll(c);
  MEMO.set(c, next);
  return next;
}

async function findAll(c: CheckContext): Promise<HookFinding[]> {
  const found = arrays(c);
  const explained = lockCommands(c);
  for (const arr of found.values())
    for (const p of arr.palm) for (const cmd of commandsIn(p.value)) explained.add(cmd);
  const out: HookFinding[] = [];
  for (const arr of found.values()) {
    const disk = await itemsAt(c.run.state.paths.abs(arr.file), arr.at);
    if (disk) out.push(...findingsIn(arr, disk, explained));
  }
  return out;
}
