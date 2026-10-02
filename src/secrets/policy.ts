/**
 * Whether a literal secret may be written to one destination (DESIGN.md section 8), and the
 * message palm prints when it replaced a literal it found on disk.
 */
import { readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Scope, SecretDecision, SecretPolicy } from '../core/types.js';
import { gitToplevel, isGitIgnored } from '../lib/fs.js';

export interface SecretDestination {
  scope: Scope;
  /** The value arrived from a source (never written as a literal). */
  fromSource: boolean;
  /** `--secrets`; project scope needs `literal` for a typed literal. */
  requested?: SecretPolicy;
  destinationAbs: string;
  /** Part of the call; `--force` never overrides the worktree guard (J26). */
  force: boolean;
}

/** The two git questions decideSecret asks; tests pass fakes. */
export interface GitProbe {
  gitToplevel(dir: string): Promise<string | undefined>;
  isGitIgnored(abs: string, cwd: string): Promise<boolean | undefined>;
}

const GIT: GitProbe = {
  gitToplevel: (dir) => gitToplevel(dir),
  isGitIgnored: (abs, cwd) => isGitIgnored(abs, cwd),
};

/** Symlink hops followed through dangling links before giving up. */
const MAX_LINK_HOPS = 40;

/** `p` with the home directory written as `~`, for messages. */
function shown(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(`${home}${sep}`) ? `~${p.slice(home.length)}` : p;
}

/**
 * The real path `abs` resolves to: symlinks followed, a dangling link to where it points, a
 * missing tail appended to the real path of the deepest existing ancestor.
 */
async function realOf(abs: string, hops = 0): Promise<string> {
  const real = await realpath(abs).catch(() => undefined);
  if (real !== undefined) return real;
  const link = hops < MAX_LINK_HOPS ? await readlink(abs).catch(() => undefined) : undefined;
  if (link !== undefined) return realOf(resolve(dirname(abs), link), hops + 1);
  const parent = dirname(abs);
  return parent === abs ? abs : join(await realOf(parent, hops), basename(abs));
}

/** The nearest existing directory at or above `dirname(abs)` (git needs a cwd that exists). */
async function nearestDir(abs: string): Promise<string> {
  let dir = dirname(abs);
  const isDir = (d: string) =>
    stat(d).then(
      (s) => s.isDirectory(),
      () => false,
    );
  while (!(await isDir(dir)) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

function destinationText(dest: string, real: string): string {
  return dest === real ? shown(dest) : `${shown(dest)} resolves to ${shown(real)}, which`;
}

/**
 * A typed literal in project scope: written, with a warning when git would carry it (the
 * destination is inside a worktree and not ignored; a new `.mcp.json` is untracked until the
 * commit that adds it).
 */
async function projectLiteral(input: SecretDestination, git: GitProbe): Promise<SecretDecision> {
  const real = await realOf(input.destinationAbs);
  const top = await git.gitToplevel(await nearestDir(real));
  const ignored = top === undefined ? undefined : await git.isGitIgnored(real, top);
  if (top === undefined || ignored) {
    const why = top === undefined ? 'outside every git worktree' : 'ignored by git';
    return { policy: 'literal', action: 'literal', reason: `${shown(real)} is ${why}` };
  }
  return {
    policy: 'literal',
    action: 'warn',
    reason: `${destinationText(input.destinationAbs, real)} is in a git worktree and not ignored; the literal value will be committed with it`,
  };
}

async function globalLiteral(input: SecretDestination, git: GitProbe): Promise<SecretDecision> {
  const real = await realOf(input.destinationAbs);
  const top = await git.gitToplevel(await nearestDir(real));
  if (top === undefined)
    return {
      policy: 'literal',
      action: 'literal',
      reason: `${shown(real)} is outside every git worktree`,
    };
  const where = `${destinationText(input.destinationAbs, real)} is inside the git worktree ${shown(top)}`;
  return {
    policy: 'env-ref',
    action: 'refused',
    reason: `${where}; refusing to write a literal secret there (use --secrets env-ref and export the variable)`,
  };
}

/**
 * The decision for one destination (API.md, DESIGN.md section 8):
 *
 * - a literal from a source: `refused` (palm writes the `${VAR}` reference), `force` or not;
 * - no `--secrets literal`: `env-ref`;
 * - project scope with `literal`: `literal`, or `warn` when the destination is inside a git
 *   worktree and not ignored (git would commit it);
 * - global scope with `literal`: `literal` only when the destination's real path lies outside
 *   every git worktree, else `refused`; `force` never overrides this worktree guard (J1, J26).
 */
export async function decideSecret(
  input: SecretDestination,
  git: GitProbe = GIT,
): Promise<SecretDecision> {
  if (input.fromSource)
    return {
      policy: 'env-ref',
      action: 'refused',
      reason:
        'a literal secret from a source is never written; palm writes a reference to an environment variable',
    };
  if (input.requested !== 'literal')
    return {
      policy: 'env-ref',
      action: 'env-ref',
      reason: 'secrets are written as environment references',
    };
  return input.scope === 'project' ? projectLiteral(input, git) : globalLiteral(input, git);
}

export interface RotateInput {
  server: string;
  /** The file as shown to the user (`.cursor/mcp.json`). */
  file: string;
  /** The env key or header that held the value. */
  key: string;
  variable: string;
  /** git tracks the file, so the old value is in its history. */
  tracked: boolean;
  /** Display names of the harnesses that read the file (`Cursor`). */
  harnesses: string[];
}

/** `a`, `a or b`, `a, b or c`. */
export function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

/**
 * The message after palm replaced a literal it found on disk (DESIGN.md section 8):
 * `inbound: .cursor/mcp.json held a literal value for x-inbound-api-key (tracked in git). palm
 * replaced it with ${INBOUND_API_KEY}. The old value stays in git history: rotate it. export
 * INBOUND_API_KEY before starting Cursor.`
 */
export function rotateMessage(input: RotateInput): string {
  const tracked = input.tracked ? ' (tracked in git)' : '';
  const history = input.tracked
    ? 'The old value stays in git history: rotate it.'
    : 'The old value was stored in plain text: rotate it.';
  const when = input.harnesses.length
    ? `before starting ${orList(input.harnesses)}`
    : 'before starting your agent';
  return `${input.server}: ${input.file} held a literal value for ${input.key}${tracked}. palm replaced it with \${${input.variable}}. ${history} export ${input.variable} ${when}.`;
}
