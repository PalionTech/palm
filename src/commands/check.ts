/**
 * `palm check [-g] [--json]` (DESIGN.md §6 "Check"): read-only. One line per check it ran,
 * then one line per problem with the command that fixes it, then `no problems` only when
 * nothing failed or warned. Exit 1 when a check failed; warnings alone exit 0.
 */
import type { CheckProblem, CheckReport, CheckRun, CheckStatus } from '../core/types.js';
import type { Mark } from '../ui/format.js';
import type { Output } from '../ui/output.js';
import type { App } from './app.js';
import { ExitSignal, type Invocation } from './grammar.js';
import { engine, engineDeps, type GlobalOptions, makeContext, scopeOf } from './shared.js';

const CHECK_MARK: Readonly<Record<CheckStatus, string>> = { ok: '✓', warn: '!', fail: 'x' };
const PROBLEM_MARK: Readonly<Record<CheckStatus, Mark>> = { ok: 'i', warn: '!', fail: 'x' };
const COLOUR = { ok: 'green', warn: 'yellow', fail: 'red' } as const;

/**
 * `x skill tdd: .claude/skills/tdd/SKILL.md differs from what palm renders; fix: palm install …`.
 * The file joins the subject only when the message does not name it already.
 */
function problemLine(p: CheckProblem): string {
  const file = p.file && !p.message.includes(p.file) ? p.file : '';
  const who = [p.entity ? `${p.entity.kind} ${p.entity.name}` : '', file].filter(Boolean).join(' ');
  return `${who ? `${who}: ` : ''}${p.message}${p.fix ? `; fix: ${p.fix}` : ''}`;
}

function checkLine(out: Output, c: CheckRun): string {
  return `${out.colors[COLOUR[c.status]](CHECK_MARK[c.status])} ${c.label}`;
}

function printCheck(out: Output, report: CheckReport): void {
  for (const c of report.checks) out.out(checkLine(out, c));
  const problems = report.checks.flatMap((c) => c.problems.map((p) => ({ c, p })));
  if (problems.length) out.out();
  for (const { c, p } of problems) out.mark(PROBLEM_MARK[c.status], problemLine(p));
  const clean = report.checks.every((c) => c.status === 'ok');
  if (clean) out.out('no problems');
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as GlobalOptions;
  const ctx = await makeContext(app, flags);
  const report = await engine(app).checkScope(ctx, { scope: scopeOf(flags) }, engineDeps(app));
  if (app.out.jsonMode) app.out.json({ ok: report.ok, checks: report.checks });
  else printCheck(app.out, report);
  if (!report.ok) throw new ExitSignal(1);
}
