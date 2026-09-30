/**
 * The consent prompt text (DESIGN.md section 7), laid out as the design shows it: a count line,
 * one numbered block per unit (commit, event and matcher rows with the rendered command, the
 * targets and their files, the scripts), the prompt hooks, what a yes records, the question.
 * Everything that comes from a source goes through `visible`.
 */
import { short } from '../core/hash.js';
import type { ClosureFile, ConsentRequest, ExecUnit, Scope, TargetId } from '../core/types.js';
import { TARGET_IDS } from '../core/types.js';
import { plural } from '../lib/text.js';
import { PROJECT_DIR } from '../targets/index.js';
import { formatSize, modeText, visible } from './format.js';
import { commandAt, firstTarget } from './units.js';

export interface PromptOptions {
  scope: Scope;
  /** The lock file as shown to the user (`palm.lock.yaml`, `~/.palm/palm.lock.yaml`). */
  lockFile: string;
}

/** Width of the event and matcher column (a longer label widens it for its unit). */
const LABEL_WIDTH = 20;
/** Scripts listed by name before `... N more`. */
const SHOWN_SCRIPTS = 3;
const ROW = '     ';
const SUB_ROW = '       ';

/** `1 program`, `2 programs`. */
export function programs(n: number): string {
  return plural(n, 'program');
}

/** `  (commit 82fe822, v2.1.0, 2026-07-14)`, or nothing for a unit without a commit. */
function fromText(from: ExecUnit['from']): string {
  const parts = [
    from?.sha ? `commit ${from.sha.slice(0, 7)}` : undefined,
    from?.ref,
    from?.date?.slice(0, 10),
  ].filter((p): p is string => !!p);
  return parts.length ? `  (${visible(parts.join(', '))})` : '';
}

/** `command` with the target's project-dir idiom neutralised, so renders that differ only there compare equal. */
function neutral(command: string, target: TargetId): string {
  const idiom = PROJECT_DIR[target];
  return idiom ? command.split(idiom).join('\0') : command;
}

/** A line per further target whose rendering of command `i` differs beyond the project-dir idiom. */
function otherTargets(unit: ExecUnit, first: TargetId | undefined, i: number): string[] {
  if (!first) return [];
  const base = neutral(commandAt(unit, first, i), first);
  return TARGET_IDS.filter((t) => t !== first && unit.rendered[t]?.length)
    .map((t) => [t, commandAt(unit, t, i)] as const)
    .filter(([t, command]) => neutral(command, t) !== base)
    .map(([t, command]) => `${SUB_ROW}${t}: ${visible(command)}`);
}

function hookRows(unit: ExecUnit): string[] {
  const first = firstTarget(unit);
  const labels = unit.commands.map((c) => {
    const event = c.event ?? c.id;
    return visible(c.matcher ? `${event}  ${c.matcher}` : event);
  });
  const width = Math.max(LABEL_WIDTH, ...labels.map((l) => l.length));
  return unit.commands.flatMap((_, i) => [
    `${ROW}${(labels[i] ?? '').padEnd(width)}  ${visible(commandAt(unit, first, i))}`,
    ...otherTargets(unit, first, i),
  ]);
}

function mcpRows(unit: ExecUnit): string[] {
  const first = firstTarget(unit);
  const env = unit.env?.length ? unit.env.join(', ') : 'none';
  const cwd = unit.cwd ? `   cwd: ${unit.cwd}` : '';
  return [
    `${ROW}stdio  ${visible(commandAt(unit, first, 0))}   env: ${visible(env)}${visible(cwd)}`,
    ...otherTargets(unit, first, 0),
  ];
}

/** `targets: claude (.claude/settings.json), cursor (.cursor/hooks.json)`. */
function targetsLine(unit: ExecUnit): string[] {
  const parts = TARGET_IDS.flatMap((t) => {
    const files = [...new Set((unit.rendered[t] ?? []).map((r) => r.file))];
    return files.length ? [`${t} (${files.join(', ')})`] : [];
  });
  return parts.length ? [`${ROW}targets: ${visible(parts.join(', '))}`] : [];
}

function names(command: string, path: string): boolean {
  return (
    [`/${path}`, ` ${path}`, `"${path}`].some((s) => command.includes(s)) ||
    command.startsWith(path)
  );
}

/** The scripts a command names, in command order, else the first ones by path; at most SHOWN_SCRIPTS. */
function shownScripts(unit: ExecUnit): ClosureFile[] {
  const named: ClosureFile[] = [];
  unit.commands.forEach((c, i) => {
    const text = [c.canonical, ...TARGET_IDS.map((t) => commandAt(unit, t, i))].join('\n');
    for (const f of unit.closure.files)
      if (!named.includes(f) && names(text, f.path)) named.push(f);
  });
  return (named.length ? named : unit.closure.files).slice(0, SHOWN_SCRIPTS);
}

/** `hooks/persist-session-id.sh     755   612 B   sha256:1b9e04c2`, columns aligned. */
function scriptRows(files: ClosureFile[]): string[] {
  const paths = files.map((f) => visible(f.path));
  const sizes = files.map((f) => formatSize(f.size));
  const pathWidth = Math.max(...paths.map((p) => p.length)) + 2;
  const sizeWidth = Math.max(...sizes.map((s) => s.length)) + 2;
  return files.map(
    (f, i) =>
      `${SUB_ROW}${(paths[i] ?? '').padEnd(pathWidth)}${modeText(f.mode).padEnd(6)}${(sizes[i] ?? '').padEnd(sizeWidth)}sha256:${short(f.hash, 8)}`,
  );
}

/** Where the scripts live: copied into the assets directory, or run in place from the repository. */
function scriptsHead(unit: ExecUnit, scope: Scope): string {
  const { files, inPlace, root, bytes } = unit.closure;
  const dir = visible(root.endsWith('/') ? root : `${root}/`);
  const count = `${plural(files.length, 'file')}, ${formatSize(bytes)}`;
  if (inPlace) return `${ROW}scripts: ${count}  in  ${dir}  (run in place from your repository)`;
  const where = scope === 'project' ? '  (committed with your repo)' : '';
  return `${ROW}scripts: ${count}  ->  ${dir}${where}`;
}

function scriptLines(unit: ExecUnit, scope: Scope): string[] {
  const { files } = unit.closure;
  if (files.length === 0) return [];
  const shown = shownScripts(unit);
  const more = files.length - shown.length;
  return [
    scriptsHead(unit, scope),
    ...scriptRows(shown),
    ...(more > 0 ? [`${SUB_ROW}... ${more} more  (v shows every script)`] : []),
  ];
}

/** `reads: skills/using-superpowers/SKILL.md`: files a script reads rather than runs (E1). */
function readsLines(unit: ExecUnit): string[] {
  const reads = unit.reads ?? [];
  if (!reads.length) return [];
  const shown = reads.slice(0, SHOWN_SCRIPTS).map(visible).join(', ');
  const more = reads.length > SHOWN_SCRIPTS ? `  ... ${reads.length - SHOWN_SCRIPTS} more` : '';
  return [`${ROW}reads:   ${shown}${more}`];
}

function unitLines(unit: ExecUnit, n: number, scope: Scope): string[] {
  const name = visible(unit.entity.name);
  const head = `  ${n}. ${unit.kind} ${name}  from ${visible(unit.entity.source)}${fromText(unit.from)}`;
  const rows = unit.kind === 'mcp' ? mcpRows(unit) : hookRows(unit);
  const warnings = (unit.warnings ?? []).map((w) => `${ROW}! ${visible(w)}`);
  return [
    head,
    ...rows,
    ...targetsLine(unit),
    ...scriptLines(unit, scope),
    ...readsLines(unit),
    ...warnings,
  ];
}

/** `Also 2 prompt hooks (text sent to the model; no program runs): fp-check Stop, SubagentStop.` */
function promptHooksLines(prompts: ConsentRequest['prompts']): string[] {
  if (!prompts.length) return [];
  const byEntity = new Map<string, string[]>();
  for (const p of prompts) {
    const events = byEntity.get(p.entity) ?? [];
    events.push(p.matcher ? `${p.event} ${p.matcher}` : p.event);
    byEntity.set(p.entity, events);
  }
  const list = [...byEntity].map(([entity, events]) => `${entity} ${events.join(', ')}`);
  const count = plural(prompts.length, 'prompt hook');
  return [
    '',
    `  Also ${count} (text sent to the model; no program runs): ${visible(list.join('; '))}.`,
  ];
}

function closing(n: number, opts: PromptOptions): string[] {
  const one = n === 1;
  const who = opts.scope === 'project' ? 'teammates and CI' : 'your other machines';
  const recorded = one ? 'its hash goes' : 'their hashes go';
  return [
    `palm never runs ${one ? 'this' : 'these'} itself. If you say yes, ${recorded} into ${opts.lockFile},`,
    `so ${who} install ${one ? 'it' : 'them'} without being asked; any change asks again.`,
  ];
}

/** True when some unit has a trusted previous version to diff against (`d`). */
export function canDiff(req: ConsentRequest): boolean {
  return req.units.some((u) => req.previous?.[u.key] !== undefined);
}

function question(req: ConsentRequest): string {
  const n = req.units.length;
  const ask = n === 1 ? 'Allow this program to run?' : `Allow these ${n} programs to run?`;
  return `${ask}  [y/N/v=view scripts${canDiff(req) ? '/d=diff' : ''}]`;
}

/** Everything the prompt shows before its question (printed as is without a terminal and in dry runs). */
export function consentSummary(req: ConsentRequest, opts: PromptOptions): string {
  const n = req.units.length;
  return [
    `This ${req.operation} adds ${programs(n)} that will run on your machine.`,
    '',
    ...req.units.flatMap((u, i) => unitLines(u, i + 1, opts.scope)),
    ...promptHooksLines(req.prompts),
    '',
    ...closing(n, opts),
  ].join('\n');
}

/** The consent prompt of DESIGN.md section 7, question included. */
export function consentText(req: ConsentRequest, opts: PromptOptions): string {
  return `${consentSummary(req, opts)}\n\n${question(req)}`;
}
