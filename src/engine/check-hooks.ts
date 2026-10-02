/**
 * Every hook event array of the hook files palm parses (`/hooks/<Event>` of
 * `.claude/settings.json`, `.cursor/hooks.json`, …, Sofia S2, V2'), read as the harness reads
 * them (D3, V6): every command there is either explained by an installed entry's render, or
 * foreign. A foreign command in an array palm merged into, where one of palm's own commands went
 * missing (same matcher), is palm's entry changed on disk (a tampered command is `changed`,
 * never re-added beside it); any other is a hand-added hook that `check` names as a warning
 * (a failure under `--strict`), with the script it names when that file is missing (X14).
 * Nothing is written.
 */
import { readFile } from 'node:fs/promises';
import type { LockEntry } from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import { fragmentKey } from '../domain/merged-record.js';
import { parseJson } from '../lib/json.js';
import { formatPointer } from '../lib/json-pointer.js';
import { isRecord } from '../lib/object.js';
import { hookFiles } from './check-harness.js';
import type { CheckContext } from './check-kit.js';
import { missingScript } from './check-scripts.js';

/** One command on disk that no lock entry explains. */
export interface HookFinding {
  /** Lock form of the harness file. */
  file: string;
  event: string;
  command: string;
  /** The entry whose command went missing where this one sits (a changed entry), if any. */
  owner?: LockEntry;
  /** A file the command names that does not exist (lock form), for a foreign command (X14). */
  missing?: string;
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

/** Every event array of the JSON hook file (`/hooks/<Event>`), as the harness reads it. */
async function eventArrays(abs: string): Promise<Array<{ at: string; items: unknown[] }>> {
  const text = await readFile(abs, 'utf8').catch(() => undefined);
  if (text === undefined) return [];
  let doc: unknown;
  try {
    doc = parseJson(text, { tolerant: true });
  } catch {
    return [];
  }
  const hooks = isRecord(doc) ? doc.hooks : undefined;
  if (!isRecord(hooks)) return [];
  return Object.entries(hooks).flatMap(([event, items]) =>
    Array.isArray(items) ? [{ at: formatPointer(['hooks', event]), items }] : [],
  );
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

/**
 * Commands palm explains: the lock's recorded commands (even without a render) and every
 * command line an entry's render runs, for every target.
 */
function lockCommands(c: CheckContext): Set<string> {
  const out = new Set<string>();
  for (const e of c.run.state.lock.entries) {
    for (const x of e.exec?.commands ?? []) out.add(x.command);
    for (const r of Object.values(c.renders.get(lockId(e))?.renders ?? {}))
      for (const x of r?.exec ?? []) out.add(x.command);
  }
  return out;
}

/** What palm explains: command lines, and the `file#at#key` of every item the lock records. */
interface Known {
  commands: Set<string>;
  items: Set<string>;
}

/**
 * E6': an item the lock records by its key is palm's own even when palm now renders another
 * command there (an in-repo source changed; `local-sources` reports that).
 */
function recordedItem(known: Known, arr: HookArray, item: unknown): boolean {
  return known.items.has(`${arr.file}#${arr.at}#${fragmentKey(arr.at, item)}`);
}

function findingsIn(c: CheckContext, arr: HookArray, disk: unknown[], known: Known): HookFinding[] {
  const onDisk = new Set(disk.flatMap(commandsIn));
  const gone = arr.palm.filter((p) => commandsIn(p.value).some((cmd) => !onDisk.has(cmd)));
  const event = arr.at.slice('/hooks/'.length);
  const out: HookFinding[] = [];
  for (const item of disk.filter((i) => !recordedItem(known, arr, i)))
    for (const command of commandsIn(item)) {
      if (known.commands.has(command)) continue;
      const owner = gone.find((p) => matcherOf(p.value) === matcherOf(item))?.entry;
      const finding: HookFinding = { file: arr.file, event, command };
      const missing = owner ? undefined : missingScript(c.run.state.paths, command);
      if (owner) finding.owner = owner;
      if (missing) finding.missing = missing;
      out.push(finding);
    }
  return out;
}

/**
 * Every command in an event array of a hook file palm parses that no installed entry explains:
 * foreign, or (`owner` set) standing where that entry's own command went missing.
 */
export function hookFindings(c: CheckContext): Promise<HookFinding[]> {
  const known = MEMO.get(c);
  if (known) return known;
  const next = findAll(c);
  MEMO.set(c, next);
  return next;
}

async function findAll(c: CheckContext): Promise<HookFinding[]> {
  const palm = arrays(c);
  const blind = unrendered(c);
  const known: Known = {
    commands: lockCommands(c),
    items: new Set(
      c.run.state.lock.entries.flatMap((e) =>
        (e.merged ?? []).map((m) => `${m.file}#${m.at}#${m.key}`),
      ),
    ),
  };
  for (const arr of palm.values())
    for (const p of arr.palm) for (const cmd of commandsIn(p.value)) known.commands.add(cmd);
  const out: HookFinding[] = [];
  for (const file of await hookFiles(c))
    for (const { at, items } of await eventArrays(c.run.state.paths.abs(file))) {
      const key = `${file}#${at}`;
      if (blind.has(key)) continue;
      out.push(...findingsIn(c, palm.get(key) ?? { file, at, palm: [] }, items, known));
    }
  return out;
}
