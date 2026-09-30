/**
 * Consent to executable content (DESIGN.md section 7): `--allow-exec`, the prompt loop with the
 * script viewer and the diff, and the error without a terminal. The default answer is no;
 * `--yes` never consents; nothing here runs what it shows.
 */
import { posix, relative, resolve } from 'node:path';
import { PalmError } from '../core/errors.js';
import { fileAtSha } from '../core/git.js';
import type {
  AllowExec,
  ConsentOutcome,
  ConsentRequest,
  ExecUnit,
  Logger,
  PalmContext,
  ScriptReader,
} from '../core/types.js';
import { isWithin } from '../lib/fs.js';
import { redactTypedArgs } from '../secrets/typed.js';
import { canDiff, consentSummary, consentText, type PromptOptions, programs } from './prompt.js';
import { execDiff, scriptsText } from './review.js';

export { unifiedDiff } from './diff.js';
export { consentText } from './prompt.js';
export { execDiff } from './review.js';

const ALLOW_RE =
  /^(hook|mcp):([A-Za-z0-9][A-Za-z0-9._-]*)@([^\s=,]+)=(?:sha256:)?([0-9a-fA-F]{16,64})$/;
const ALLOW_FORMAT = '<hook|mcp>:<name>@<source>=sha256:<16 or more hex digits>';
const ALLOW_EXAMPLE =
  'palm install --allow-exec hook:gh-cli@trailofbits/skills=sha256:a7cc79110f3b2e8d';
/** The command line assumed when the CLI did not pass one. */
const DEFAULT_ARGS: readonly string[] = ['install'];

function parseEntry(item: string): AllowExec {
  const m = ALLOW_RE.exec(item);
  if (!m)
    throw new PalmError(
      'E_USAGE',
      `--allow-exec "${item}" is not a program key with its hash`,
      `write each entry as ${ALLOW_FORMAT}, comma-separated, for example: ${ALLOW_EXAMPLE}`,
    );
  return { key: `${m[1]}:${m[2]}@${m[3]}`, hash: `sha256:${(m[4] ?? '').toLowerCase()}` };
}

/**
 * `--allow-exec` as typed: `all`, or comma-separated `<kind>:<name>@<source>=sha256:<hash>`
 * entries whose hash may be a prefix of at least 16 hex digits. Malformed → E_USAGE with the format.
 */
export function parseAllowExec(text: string | undefined): AllowExec[] | 'all' {
  const trimmed = text?.trim() ?? '';
  if (trimmed === '') return [];
  if (trimmed.toLowerCase() === 'all') return 'all';
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseEntry);
}

/** True when `allow` covers the unit: `all`, or its key (any case) with a prefix of its hash. */
export function allowed(unit: ExecUnit, allow: AllowExec[] | 'all'): boolean {
  if (allow === 'all') return true;
  const key = unit.key.toLowerCase();
  const hash = unit.hash.toLowerCase();
  return allow.some((a) => a.key.toLowerCase() === key && hash.startsWith(a.hash.toLowerCase()));
}

function shellWord(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function command(words: readonly string[]): string {
  return ['palm', ...words.map(shellWord)].join(' ');
}

/**
 * The command line without `--allow-exec`, `--dry-run` and `--review`, plus the allow entries
 * it had. Typed values are redacted (J11): an `--env` or `--header` value becomes the reference
 * palm writes for it, so a hint that repeats the command never echoes a secret.
 */
function splitArgs(args: readonly string[]): { base: string[]; allow: string[] } {
  const base: string[] = [];
  const allow: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--allow-exec') allow.push(...(args[++i] ?? '').split(','));
    else if (arg.startsWith('--allow-exec=')) allow.push(...arg.slice(13).split(','));
    else if (arg !== '--dry-run' && arg !== '--review') base.push(arg);
  }
  return {
    base: redactTypedArgs(base),
    allow: allow.filter((a) => a !== '' && a.toLowerCase() !== 'all'),
  };
}

/**
 * E_UNTRUSTED_EXEC for units nobody can consent to without a terminal: the review command and
 * the exact `--allow-exec` line (keys with their full hashes, after any entries already given).
 */
export function nonInteractiveError(
  req: ConsentRequest,
  argv: { args: readonly string[] },
): PalmError {
  const n = req.units.length;
  const { base, allow } = splitArgs(argv.args);
  const keys = new Set(req.units.map((u) => u.key.toLowerCase()));
  const kept = allow.filter((a) => !keys.has((a.split('=')[0] ?? '').toLowerCase()));
  const entries = [...kept, ...req.units.map((u) => `${u.key}=${u.hash}`)];
  return new PalmError(
    'E_UNTRUSTED_EXEC',
    `${programs(n)} ${n === 1 ? 'needs' : 'need'} your consent and there is no terminal`,
    [
      `review:  ${command([...base, '--dry-run', '--review'])}`,
      `then:    ${command([...base, '--allow-exec', entries.join(',')])}`,
    ].join('\n'),
  );
}

/** Long text through the output's pager when it has one (`Output.page`), else as one info block. */
async function page(ctx: PalmContext, text: string): Promise<void> {
  const log = ctx.log as Logger & { page?: (text: string) => Promise<void> };
  if (typeof log.page === 'function') await log.page(text);
  else ctx.log.info(text);
}

/** A block of text as it is (the output's data lines when it has them), not as an `i` line. */
function show(ctx: PalmContext, text: string): void {
  const log = ctx.log as Logger & { out?: (line: string) => void };
  if (typeof log.out === 'function') log.out(text);
  else ctx.log.info(text);
}

/** Every script body of `units`, from the pinned commit through `read`, paged (`v`). */
export async function viewScripts(
  ctx: PalmContext,
  units: ExecUnit[],
  read: ScriptReader,
): Promise<void> {
  await page(ctx, await scriptsText(units, read));
}

/**
 * A ScriptReader over git checkouts: `locate(unit)` names the checkout holding the unit's
 * commit and the repository directory its closure root was copied from; bodies come from
 * `git show <sha>:<dir>/<path>`.
 */
export function checkoutReader(
  locate: (unit: ExecUnit) => { checkoutDir: string; dirRel: string } | undefined,
): ScriptReader {
  return async (unit, file) => {
    const at = locate(unit);
    const sha = unit.from?.sha;
    if (!at || !sha) return undefined;
    return fileAtSha(at.checkoutDir, sha, posix.join(at.dirRel, file.path));
  };
}

const unreadable: ScriptReader = async () => undefined;

/** Scope and display form of the lock file the request names. */
function promptOptions(ctx: PalmContext, lockFile: string): PromptOptions {
  const { projectRoot, palmHome, home } = ctx.paths;
  const abs = resolve(projectRoot, lockFile);
  const scope = isWithin(abs, palmHome, { strict: true }) ? 'global' : 'project';
  let shown = abs;
  if (scope === 'project' && isWithin(abs, projectRoot, { strict: true }))
    shown = relative(projectRoot, abs);
  else if (isWithin(abs, home, { strict: true })) shown = `~/${relative(home, abs)}`;
  return { scope, lockFile: shown };
}

/** Asks until the answer is yes or no; `v` pages the scripts, `d` the diff, then it asks again. */
async function consentLoop(
  ctx: PalmContext,
  req: ConsentRequest,
  opts: PromptOptions,
): Promise<boolean> {
  const text = consentText(req, opts);
  const diff = canDiff(req);
  const read = req.read ?? unreadable;
  for (;;) {
    const answer = await ctx.ui.consent(text, { canDiff: diff });
    if (answer === 'yes') return true;
    if (answer === 'no') return false;
    if (answer === 'view') await viewScripts(ctx, req.units, read);
    else if (diff) await page(ctx, await execDiff(req.units, req.previous, read));
  }
}

function allWithoutTerminal(args: readonly string[]): PalmError {
  const { base } = splitArgs(args);
  return new PalmError(
    'E_USAGE',
    '--allow-exec all works only on a terminal; without one, name each program with its hash',
    `${command([...base, '--dry-run', '--review'])} prints each key and hash`,
  );
}

/**
 * Consent for `req.units`. Units `--allow-exec` covers pass; none left → allowed without a
 * prompt. `--allow-exec all` without a terminal is E_USAGE; on a terminal it allows every unit
 * after showing them. A dry run shows the units and asks nothing. Without a terminal the units
 * are shown and E_UNTRUSTED_EXEC names the review command and the `--allow-exec` line.
 * Otherwise `ctx.ui.consent` asks (Enter is no); a no declines every unit it listed. `--review`
 * pages every script body first (in a dry run, after the units).
 */
export async function askConsent(ctx: PalmContext, req: ConsentRequest): Promise<ConsentOutcome> {
  const allow = ctx.flags.allowExec ?? [];
  const args = ctx.argv ?? DEFAULT_ARGS;
  if (allow === 'all' && !ctx.ui.isInteractive) throw allWithoutTerminal(args);
  const opts = promptOptions(ctx, req.lockFile);
  const covered = req.units.filter((u) => allowed(u, allow)).map((u) => u.key);
  const rest: ConsentRequest = { ...req, units: req.units.filter((u) => !allowed(u, allow)) };
  if (allow === 'all' && req.units.length) show(ctx, consentSummary(req, opts));
  if (rest.units.length === 0) return { allowed: covered, declined: [] };
  const review = () =>
    ctx.flags.review ? viewScripts(ctx, rest.units, req.read ?? unreadable) : undefined;
  if (ctx.flags.dryRun || !ctx.ui.isInteractive) {
    show(ctx, consentSummary(rest, opts));
    await review();
    if (ctx.flags.dryRun) return { allowed: covered, declined: [] };
    throw nonInteractiveError(rest, { args });
  }
  await review();
  const keys = rest.units.map((u) => u.key);
  if (await consentLoop(ctx, rest, opts)) return { allowed: [...covered, ...keys], declined: [] };
  return { allowed: covered, declined: keys };
}
