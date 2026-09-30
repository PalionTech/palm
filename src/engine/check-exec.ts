/**
 * The checks about programs palm installs (DESIGN §6 "Check", §7): `exec-trusted` and
 * `hook-scripts`. A unit is trusted when the lock trusts the hash palm computes now (a changed
 * in-repo script moves it, E2); an entry that runs a program without a consent record fails
 * (V1); a command in a hook array palm merges into that no lock entry explains is a warning,
 * and one sitting where palm's own command went missing is a failure (D3, V6).
 */
import { stat } from 'node:fs/promises';
import { short } from '../core/hash.js';
import type { CheckProblem, CheckRun, LockEntry } from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import { visible } from '../exec/format.js';
import { type HookFinding, hookFindings } from './check-hooks.js';
import {
  type CheckContext,
  checkRun,
  count,
  entityOf,
  type Found,
  found,
  rendersFiles,
} from './check-kit.js';
import { fragmentStates, ownedFragments } from './diff.js';
import { palmCommand } from './report.js';

function scopeOf(c: CheckContext) {
  return c.run.state.paths.scope;
}

function problem(e: LockEntry, message: string, fix: string): CheckProblem {
  return { entity: entityOf(e), message, fix };
}

/** V1: a lock entry that runs a program palm has no trust for (none recorded, or not its hash). */
function untrusted(c: CheckContext, e: LockEntry, f: Found): void {
  const unit = c.renders.get(lockId(e))?.unit;
  if (!e.exec) {
    if (unit)
      f.fail.push(
        problem(
          e,
          `${e.kind} ${e.name} runs a program palm.lock.yaml has no consent for`,
          palmCommand('install', [], scopeOf(c)),
        ),
      );
    return;
  }
  const key = `${e.kind}:${e.name}@${e.source}`;
  if (!(e.trust ?? []).includes(e.exec.hash))
    f.fail.push(
      problem(
        e,
        `${e.kind} ${e.name} runs a program nobody consented to (${short(e.exec.hash)})`,
        palmCommand('install', [], scopeOf(c), `--allow-exec ${key}=${e.exec.hash}`),
      ),
    );
}

/** E2: the unit palm computes now (commands and every script byte) is not the trusted one. */
function moved(c: CheckContext, e: LockEntry, f: Found): void {
  const unit = c.renders.get(lockId(e))?.unit;
  if (!unit || !e.exec || unit.hash === e.exec.hash || c.drifted.has(lockId(e))) return;
  f.fail.push(
    problem(
      e,
      `${e.kind} ${e.name} changed since consent (${short(e.exec.hash)} → ${short(unit.hash)}); its commands or scripts are not the ones trusted`,
      `${palmCommand('install', [], scopeOf(c))} (asks again)`,
    ),
  );
}

/** A hook's merged entry on disk found by key with another value than palm renders. */
async function mergedDrift(c: CheckContext, e: LockEntry, f: Found): Promise<void> {
  const out = c.renders.get(lockId(e));
  if (!out || e.kind !== 'hook') return;
  const fix = palmCommand('install', [e.source, e.name], scopeOf(c), '--force');
  for (const r of Object.values(out.renders)) {
    if (!r) continue;
    for (const [key, s] of await fragmentStates(c.run.state.paths, r, ownedFragments(e)))
      if (s === 'changed')
        f.fail.push({
          ...problem(e, `a command of hook ${e.name} on disk differs from palm.lock.yaml`, fix),
          file: key.split('#')[0] as string,
        });
  }
}

function hookProblem(c: CheckContext, h: HookFinding): CheckProblem {
  const where = `${h.file} (${h.event})`;
  const command = visible(h.command);
  if (h.owner)
    return problem(
      h.owner,
      `a command palm installed in ${where} was changed on disk: ${command}`,
      `review it, then ${palmCommand('install', [h.owner.source, `${h.owner.kind}:${h.owner.name}`], scopeOf(c), '--force')}`,
    );
  const missing = h.missing ? `; script missing: ${h.missing}` : '';
  return {
    file: h.file,
    message: `foreign hook command in ${where}: ${command}${missing}`,
    fix: `keep it if you added it; else remove it from ${h.file} (palm does not manage it)`,
  };
}

/**
 * Every exec unit is trusted in the lock at the hash palm computes now, and no command palm
 * installed in a hook array was replaced on disk (D3: `changed`, never re-added beside it).
 */
export async function execTrusted(c: CheckContext): Promise<CheckRun> {
  const f = found();
  for (const e of c.run.state.lock.entries) {
    if (!rendersFiles(e)) continue;
    untrusted(c, e, f);
    moved(c, e, f);
    await mergedDrift(c, e, f);
  }
  for (const h of await hookFindings(c)) if (h.owner) f.fail.push(hookProblem(c, h));
  return checkRun(
    'exec-trusted',
    {
      ok: 'every program palm installed is trusted',
      bad: (n) => `${count(n, 'program')} not trusted or changed on disk`,
    },
    f,
  );
}

/**
 * V6 V2': a command in any event array of a hook file palm parses that no lock entry explains
 * (warning; a failure under `--strict`).
 */
export async function foreignHooks(c: CheckContext): Promise<CheckRun> {
  const f = found();
  for (const h of await hookFindings(c)) if (!h.owner) f.warn.push(hookProblem(c, h));
  return checkRun(
    'foreign-hooks',
    {
      ok: 'no foreign command in the hook files palm manages',
      bad: (n) => `${count(n, 'foreign hook command')} in the hook files palm manages`,
    },
    f,
  );
}

// ---------------------------------------------------------------------------
// hook-scripts
// ---------------------------------------------------------------------------

/** `<root idiom>/<path>` in a rendered command, with the directory the idiom stands for. */
function scriptRefs(c: CheckContext, command: string): Array<{ abs: string; direct: boolean }> {
  const { paths } = c.run.state;
  const roots: Array<[RegExp, string]> = [
    [/"\$(?:CLAUDE|CURSOR|GEMINI)_PROJECT_DIR"\/([^\s"']+)/g, paths.root],
    [/"\$\(git rev-parse --show-toplevel 2>\/dev\/null \|\| pwd\)"\/([^\s"']+)/g, paths.root],
    [/"\$\{PALM_HOME:-\$HOME\/\.palm\}"\/([^\s"']+)/g, paths.palmHome],
    [/"\$HOME"\/([^\s"']+)/g, paths.token('home')],
  ];
  const out: Array<{ abs: string; direct: boolean }> = [];
  for (const [re, dir] of roots)
    for (const m of command.matchAll(re))
      out.push({ abs: `${dir}/${m[1]}`, direct: m.index === 0 });
  return out;
}

async function modeOf(abs: string): Promise<number | undefined> {
  try {
    return (await stat(abs)).mode;
  } catch {
    return undefined;
  }
}

/** A missing script, or one the command runs directly without the executable bit. */
async function scriptProblem(
  c: CheckContext,
  e: LockEntry,
  id: string,
  ref: { abs: string; direct: boolean },
): Promise<CheckProblem | undefined> {
  const mode = await modeOf(ref.abs);
  const file = c.run.state.paths.lockForm(ref.abs);
  let why: string | undefined;
  if (mode === undefined) why = 'does not exist';
  else if (ref.direct && !(mode & 0o111)) why = 'is not executable';
  if (!why) return undefined;
  const fix = palmCommand('install', [], scopeOf(c));
  return { ...problem(e, `${id}: ${file} ${why}`, fix), file };
}

/** Every file a hook command names exists (and is executable when the command runs it directly). */
export async function hookScripts(c: CheckContext): Promise<CheckRun> {
  const f = found();
  for (const e of c.run.state.lock.entries) {
    if (!e.exec) continue;
    for (const cmd of e.exec.commands)
      for (const ref of scriptRefs(c, cmd.command)) {
        const p = await scriptProblem(c, e, cmd.id, ref);
        if (p) f.fail.push(p);
      }
  }
  const bad = (n: number) => `${count(n, 'hook script')} missing or not executable`;
  return checkRun('hook-scripts', { ok: 'every hook script exists', bad }, f);
}
