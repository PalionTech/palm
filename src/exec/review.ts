/**
 * What `v` and `d` show at the consent prompt: every script body of the units, and a unified
 * diff of each unit against its trusted version (also what `update --review` prints).
 */
import { posix } from 'node:path';
import { short } from '../core/hash.js';
import type { ClosureFile, ExecUnit, ScriptReader } from '../core/types.js';
import { unifiedDiff } from './diff.js';
import { formatSize, modeText, visible, visibleBody } from './format.js';

/** Bytes git sniffs for a NUL to call a file binary. */
const BINARY_SNIFF = 8192;

function title(unit: ExecUnit): string {
  const commit = unit.from?.sha ? ` (commit ${unit.from.sha.slice(0, 7)})` : '';
  return `${unit.kind} ${visible(unit.entity.name)} from ${visible(unit.entity.source)}${commit}`;
}

async function readSafely(
  read: ScriptReader,
  unit: ExecUnit,
  file: ClosureFile,
): Promise<string | undefined> {
  return read(unit, file).catch(() => undefined);
}

function bodyText(body: string | undefined): string {
  if (body === undefined) return '(palm could not read this file from the cache)';
  if (body.slice(0, BINARY_SNIFF).includes('\0')) return '(binary file, not shown)';
  return visibleBody(body).replace(/\n$/, '');
}

async function fileBlock(unit: ExecUnit, file: ClosureFile, read: ScriptReader): Promise<string> {
  const path = visible(posix.join(unit.closure.root, file.path));
  const facts = `${modeText(file.mode)}  ${formatSize(file.size)}  sha256:${short(file.hash, 8)}`;
  return `==> ${path}  ${facts}\n${bodyText(await readSafely(read, unit, file))}\n`;
}

async function unitScripts(unit: ExecUnit, read: ScriptReader): Promise<string[]> {
  const head = title(unit);
  if (unit.closure.inPlace)
    return [
      `${head}\n  runs in place from ${visible(unit.closure.root)}; the scripts are part of your repository\n`,
    ];
  if (!unit.closure.files.length) return [`${head}\n  no scripts\n`];
  const blocks = [head];
  for (const file of unit.closure.files) blocks.push(await fileBlock(unit, file, read));
  return blocks;
}

/** Every script body of `units` with its path, mode, size and short hash (`v`). */
export async function scriptsText(units: readonly ExecUnit[], read: ScriptReader): Promise<string> {
  const blocks: string[] = [];
  for (const unit of units) blocks.push(...(await unitScripts(unit, read)));
  return blocks.join('\n');
}

/** The unit's definition as lines: commands with event and matcher, env keys, cwd. */
function definition(unit: ExecUnit): string {
  const lines = unit.commands.map((c) => {
    const at = [c.event, c.matcher].filter(Boolean).join(' ');
    return at ? `${at}  ${c.canonical}` : c.canonical;
  });
  if (unit.env !== undefined) lines.push(`env: ${unit.env.length ? unit.env.join(', ') : 'none'}`);
  if (unit.cwd !== undefined) lines.push(`cwd: ${unit.cwd}`);
  return `${lines.join('\n')}\n`;
}

async function fileDiff(
  units: { before: ExecUnit; after: ExecUnit },
  path: string,
  read: ScriptReader,
): Promise<string[]> {
  const old = units.before.closure.files.find((f) => f.path === path);
  const now = units.after.closure.files.find((f) => f.path === path);
  if (old && now && old.hash === now.hash && old.mode === now.mode) return [];
  const mode =
    old && now && old.mode !== now.mode
      ? [`mode ${modeText(old.mode)} → ${modeText(now.mode)}  ${visible(path)}`]
      : [];
  const a = old ? await readSafely(read, units.before, old) : '';
  const b = now ? await readSafely(read, units.after, now) : '';
  if (a === undefined || b === undefined)
    return [...mode, `${visible(path)}: changed; palm could not read both versions from the cache`];
  const diff = unifiedDiff(visibleBody(a), visibleBody(b), visible(path));
  return diff ? [...mode, diff] : mode;
}

async function unitDiff(before: ExecUnit, after: ExecUnit, read: ScriptReader): Promise<string[]> {
  const from = before.from?.sha
    ? ` (commit ${before.from.sha.slice(0, 7)} → ${after.from?.sha?.slice(0, 7) ?? 'working tree'})`
    : '';
  const out = [`${title(after)}: changes since the trusted version${from}`];
  const defDiff = unifiedDiff(
    visibleBody(definition(before)),
    visibleBody(definition(after)),
    `${after.kind} ${visible(after.entity.name)}`,
  );
  if (defDiff) out.push(defDiff);
  const paths = new Set([...before.closure.files, ...after.closure.files].map((f) => f.path));
  for (const path of [...paths].sort())
    out.push(...(await fileDiff({ before, after }, path, read)));
  if (out.length === 1) out.push('  no change in the commands or scripts');
  return out;
}

/**
 * Each unit that has a trusted previous version (`previous[key]`), diffed against it: the
 * commands, env keys and cwd, then every added, removed or changed script (`d`, `update --review`).
 */
export async function execDiff(
  units: readonly ExecUnit[],
  previous: Record<string, ExecUnit> | undefined,
  read: ScriptReader,
): Promise<string> {
  const blocks: string[] = [];
  for (const unit of units) {
    const before = previous?.[unit.key];
    if (before) blocks.push(...(await unitDiff(before, unit, read)), '');
  }
  return blocks.join('\n');
}
