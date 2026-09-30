/**
 * `palm check [-g] [--json] [--quiet]` (DESIGN.md §6 "Check"): read-only. One line per check it
 * ran (a skipped check says so, never ✓), then one line per problem with the command that fixes
 * it, the problems of one entity that differ only by file as one line with a count (C24, D24),
 * then `no problems` only when nothing failed or warned. `--quiet` prints the problems alone.
 * `--json` keeps every problem. Exit 1 when a check failed; warnings alone exit 0.
 */
import type { CheckProblem, CheckReport, CheckRun, CheckStatus } from '../core/types.js';
import type { Mark } from '../ui/format.js';
import type { Output } from '../ui/output.js';
import type { App } from './app.js';
import { ExitSignal, type Invocation } from './grammar.js';
import { engine, engineDeps, type GlobalOptions, makeContext, scopeOf } from './shared.js';

interface CheckFlags extends GlobalOptions {
  quiet?: boolean;
}

type Colour = 'green' | 'yellow' | 'red' | 'dim';

interface StatusLook {
  mark: string;
  problem: Mark;
  colour: Colour;
}

/** How each status reads; `skip` (a check that could not run) is never ✓. */
const STATUS: Readonly<Record<CheckStatus, StatusLook>> = {
  ok: { mark: '✓', problem: 'i', colour: 'green' },
  warn: { mark: '!', problem: '!', colour: 'yellow' },
  fail: { mark: 'x', problem: 'x', colour: 'red' },
  skip: { mark: '-', problem: 'i', colour: 'dim' },
};

/** A status this version does not know reads as skipped. */
const statusOf = (c: CheckRun): StatusLook =>
  (STATUS as Readonly<Record<string, StatusLook>>)[c.status] ?? STATUS.skip;

/** Problems that differ only by their file, for one entity and one fix. */
interface Group {
  check: CheckRun;
  first: CheckProblem;
  files: string[];
}

const TEMPLATE_FILE = '\u0000';

function keyOf(c: CheckRun, p: CheckProblem): string {
  const who = p.entity ? `${p.entity.kind}:${p.entity.name}:${p.entity.source}` : '';
  const template = p.file ? p.message.replaceAll(p.file, TEMPLATE_FILE) : p.message;
  return [c.id, who, template, p.fix ?? ''].join('\u0001');
}

/** Adds one problem: to the group of its entity, fix and message template, or as a new group. */
function addTo(byKey: Map<string, Group>, check: CheckRun, p: CheckProblem): void {
  const key = p.entity && p.file ? keyOf(check, p) : `${byKey.size}`;
  const g = byKey.get(key);
  if (g && p.file) g.files.push(p.file);
  else byKey.set(key, { check, first: p, files: p.file ? [p.file] : [] });
}

function groups(report: CheckReport): Group[] {
  const byKey = new Map<string, Group>();
  for (const check of report.checks) for (const p of check.problems) addTo(byKey, check, p);
  return [...byKey.values()];
}

/** `.claude/skills/tdd/SKILL.md is missing` for 8 files: `8 files are missing (.claude/skills/tdd/SKILL.md, …)`. */
function groupedMessage(g: Group): string {
  const { first, files } = g;
  if (files.length < 2 || !first.file) return first.message;
  const template = first.message.replaceAll(first.file, TEMPLATE_FILE);
  const count = `${files.length} files`;
  const said = template.startsWith(`${TEMPLATE_FILE} `)
    ? `${count} ${template
        .slice(2)
        .replace(/^is /, 'are ')
        .replace(/^(differ|hold|resolve)s /, '$1 ')}`
    : template.replace(TEMPLATE_FILE, count);
  return `${said} (${first.file}, …)`;
}

/**
 * `x skill tdd: .claude/skills/tdd/SKILL.md differs from what palm renders; fix: palm install …`.
 * The file joins the subject only when the message does not name it already.
 */
function problemLine(g: Group): string {
  const p = g.first;
  const message = groupedMessage(g);
  const file = g.files.length < 2 && p.file && !message.includes(p.file) ? p.file : '';
  const who = [p.entity ? `${p.entity.kind} ${p.entity.name}` : '', file].filter(Boolean).join(' ');
  return `${who ? `${who}: ` : ''}${message}${p.fix ? `; fix: ${p.fix}` : ''}`;
}

export function printCheck(out: Output, report: CheckReport, quiet: boolean): void {
  if (!quiet)
    for (const c of report.checks) {
      const s = statusOf(c);
      out.out(`${out.colors[s.colour](s.mark)} ${c.label}`);
    }
  const found = groups(report);
  if (found.length && !quiet) out.out();
  for (const g of found) out.mark(statusOf(g.check).problem, problemLine(g));
  const clean = report.checks.every((c) => c.status !== 'fail' && c.status !== 'warn');
  if (clean && !quiet) out.out('no problems');
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as CheckFlags;
  const ctx = await makeContext(app, flags);
  const report = await engine(app).checkScope(ctx, { scope: scopeOf(flags) }, engineDeps(app));
  if (app.out.jsonMode) app.out.json({ ok: report.ok, checks: report.checks });
  else printCheck(app.out, report, Boolean(flags.quiet));
  if (!report.ok) throw new ExitSignal(1);
}
