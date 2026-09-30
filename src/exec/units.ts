/**
 * Exec units (DESIGN.md section 7): one per hook entry and per stdio MCP server, with the hash
 * that consent pins. The hash covers the canonical commands (placeholders intact), their events
 * and matchers, the environment keys, the cwd and the closure tree, so a new target, a palm
 * upgrade or a commit bump that changes none of those never asks again.
 */
import { commitDate } from '../core/git.js';
import { sha256 } from '../core/hash.js';
import type {
  ClosureFile,
  Entity,
  ExecUnit,
  Kind,
  Rendered,
  SourceCheckout,
  TargetId,
} from '../core/types.js';
import { TARGET_IDS } from '../core/types.js';
import { canonicalJson } from '../lib/json.js';

type Command = ExecUnit['commands'][number];
type Renders = Partial<Record<TargetId, Rendered>>;

const HOOK_COMMAND_KEYS = ['command', 'bash', 'powershell'];

/** The `--allow-exec` key: `hook:gh-cli@trailofbits/skills`. */
export function unitKey(entity: { kind: Kind; name: string; source: string }): string {
  return `${entity.kind}:${entity.name}@${entity.source}`;
}

/** True for a hook object that runs a program (`type: command`, or no type, with a command). */
function runsProgram(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(runsProgram);
  if (node === null || typeof node !== 'object') return false;
  const rec = node as Record<string, unknown>;
  const hasCommand = HOOK_COMMAND_KEYS.some((k) => typeof rec[k] === 'string');
  if (hasCommand && (rec.type === undefined || rec.type === 'command')) return true;
  return Object.values(rec).some(runsProgram);
}

/** A hook set with at least one command hook, or a stdio MCP server. Prompt hooks never count. */
export function isExecutable(entity: Entity): boolean {
  if (entity.def.kind === 'hook') return runsProgram(entity.def.hooks.raw);
  return (
    entity.def.kind === 'mcp' && entity.def.mcp.transport === 'stdio' && !!entity.def.mcp.command
  );
}

/** Code-point order (not locale order), so hashes are the same on every machine. */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function byPath(a: ClosureFile, b: ClosureFile): number {
  return compare(a.path, b.path);
}

/** The permission bits that survive a git checkout: executable or not. */
function execBit(mode: number): string {
  return (mode & 0o111) !== 0 ? '755' : '644';
}

/**
 * The closure's Merkle hash: sha256 over the sorted (relative path, executable bit, content
 * hash) of its files. Only the executable bit counts, because git keeps nothing else, so the
 * hash is the same on every clone whatever its umask.
 */
export function closureTree(files: readonly ClosureFile[]): string {
  const rows = [...files].sort(byPath).map((f) => [f.path, execBit(f.mode), f.hash]);
  return sha256(canonicalJson(rows));
}

function byIdThenCanonical(a: Command, b: Command): number {
  return compare(a.id, b.id) || compare(a.canonical, b.canonical);
}

/**
 * The exec hash (DESIGN.md section 7): sha256 of the canonical JSON of, in this order, the
 * canonical commands in id order, their events, their matchers, the sorted environment keys,
 * the cwd and the closure tree. The order commands arrive in does not matter (they are sorted
 * by id; hooks under one event and matcher run in parallel); argument order inside a command,
 * every script byte and executable bit, every env key and the cwd do.
 */
export function execHash(input: {
  commands: ExecUnit['commands'];
  env?: string[];
  cwd?: string;
  closureTree: string;
}): string {
  const commands = [...input.commands].sort(byIdThenCanonical);
  return sha256(
    canonicalJson([
      commands.map((c) => c.canonical),
      commands.map((c) => c.event ?? null),
      commands.map((c) => c.matcher ?? null),
      [...new Set(input.env ?? [])].sort(),
      input.cwd ?? null,
      input.closureTree,
    ]),
  );
}

/** Every command the renders run, first seen first (TARGET_IDS order), one per (id, canonical). */
function commandsOf(renders: Renders): Command[] {
  const seen = new Map<string, Command>();
  for (const target of TARGET_IDS) {
    for (const line of renders[target]?.exec ?? []) {
      const key = `${line.id}\0${line.canonical}`;
      if (seen.has(key)) continue;
      const command: Command = { id: line.id, canonical: line.canonical };
      if (line.event !== undefined) command.event = line.event;
      if (line.matcher !== undefined) command.matcher = line.matcher;
      seen.set(key, command);
    }
  }
  return [...seen.values()];
}

function renderedOf(renders: Renders): ExecUnit['rendered'] {
  const out: ExecUnit['rendered'] = {};
  for (const target of TARGET_IDS) {
    const lines = renders[target]?.exec ?? [];
    if (lines.length) out[target] = lines.map(({ id, command, file }) => ({ id, command, file }));
  }
  return out;
}

/** Total size of the closure files that carry one. */
function bytesOf(files: readonly ClosureFile[]): number {
  return files.reduce((sum, f) => sum + f.size, 0);
}

/** The closure files a script of the entity reads rather than runs (ruling E1). */
function readsOf(entity: Entity, files: readonly ClosureFile[]): string[] {
  const { def } = entity;
  let reads: string[] = [];
  if (def.kind === 'hook') reads = def.hooks.closure?.reads ?? [];
  else if (def.kind === 'mcp') reads = def.closure?.reads ?? [];
  const inside = (r: string) => files.some((f) => f.path === r || f.path.startsWith(`${r}/`));
  return reads.filter(inside);
}

/**
 * The exec unit of a hook entry or stdio MCP server, from its renders (every target's `exec`
 * lines) and its closure. An in-place (in-repo) closure lists the files as the working tree
 * holds them and hashes them like a copy (ruling E2): any changed script byte asks again.
 */
export function execUnitOf(
  entity: Entity,
  renders: Renders,
  closure: { root: string; inPlace: boolean; files: ClosureFile[]; abs?: string },
  from?: ExecUnit['from'],
): ExecUnit {
  const ident = { kind: entity.kind, name: entity.name, source: entity.source };
  const commands = commandsOf(renders);
  const files = [...closure.files].sort(byPath);
  const mcp = entity.def.kind === 'mcp' ? entity.def.mcp : undefined;
  const env = mcp ? Object.keys(mcp.env ?? {}).sort() : undefined;
  const unit: ExecUnit = {
    kind: entity.kind === 'mcp' ? 'mcp' : 'hook',
    entity: ident,
    key: unitKey(ident),
    commands,
    closure: { root: closure.root, inPlace: closure.inPlace, files, bytes: bytesOf(files) },
    hash: execHash({ commands, env, cwd: mcp?.cwd, closureTree: closureTree(files) }),
    rendered: renderedOf(renders),
  };
  if (closure.abs !== undefined) unit.closure.abs = closure.abs;
  const reads = readsOf(entity, files);
  if (reads.length) unit.reads = reads;
  if (from) unit.from = from;
  if (env) unit.env = env;
  if (mcp?.cwd !== undefined) unit.cwd = mcp.cwd;
  return unit;
}

/** The first target (TARGET_IDS order) that renders the unit, if any. */
export function firstTarget(unit: ExecUnit): TargetId | undefined {
  return TARGET_IDS.find((t) => (unit.rendered[t]?.length ?? 0) > 0);
}

/**
 * The command line `target` runs for the unit's `i`-th command: its rendered entry with the
 * same id and occurrence (two hooks may share an event and matcher), else the canonical text.
 */
export function commandAt(unit: ExecUnit, target: TargetId | undefined, i: number): string {
  const command = unit.commands[i];
  if (!command) return '';
  const occurrence = unit.commands.slice(0, i).filter((c) => c.id === command.id).length;
  const rendered = (target && unit.rendered[target]) || [];
  return rendered.filter((r) => r.id === command.id)[occurrence]?.command ?? command.canonical;
}

/** True when `ref` is (a prefix of) the commit itself rather than a tag or branch name. */
function isShaRef(ref: string, sha: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref) && sha.toLowerCase().startsWith(ref.toLowerCase());
}

/** `ExecUnit.from` for a git checkout: the sha, the ref it was resolved from and the author date. */
export async function execFrom(checkout: SourceCheckout): Promise<ExecUnit['from']> {
  if (!checkout.sha) return undefined;
  const from: NonNullable<ExecUnit['from']> = { sha: checkout.sha };
  if (checkout.ref && !isShaRef(checkout.ref, checkout.sha)) from.ref = checkout.ref;
  const date = await commitDate(checkout.repoDir, checkout.sha);
  if (date) from.date = date;
  return from;
}
