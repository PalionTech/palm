/**
 * The checks that read generated files (DESIGN §6 "Check"): `lock-disk`, `hook-scripts`,
 * `secrets` and `hidden-unicode`. Nothing is written.
 */
import { readFile, stat } from 'node:fs/promises';
import type { CheckRun, LockEntry, Rendered, TargetId } from '../core/types.js';
import { lockId } from '../domain/entity-key.js';
import { isGitTracked } from '../lib/fs.js';
import { findPlaceholders, isRuntimeVar } from '../lib/placeholders.js';
import { scanHiddenUnicode } from '../lib/unicode.js';
import { type CheckContext, checkRun, count, entityOf, type Found, found } from './check-kit.js';
import { fileStates, fragmentStates } from './diff.js';
import { palmCommand } from './report.js';
import { readConfig } from './rotate.js';

const MAX_TEXT_BYTES = 1024 * 1024;

function fixes(c: CheckContext, e: LockEntry) {
  const scope = c.run.state.paths.scope;
  return {
    restore: palmCommand('install', [], scope),
    force: palmCommand('install', [e.source, e.name], scope, '--force'),
  };
}

async function targetDisk(c: CheckContext, e: LockEntry, r: Rendered, f: Found): Promise<void> {
  const { paths, applied } = c.run.state;
  const fix = fixes(c, e);
  for (const [file, s] of await fileStates(paths, r, applied ? { applied } : {})) {
    if (s === 'missing')
      f.fail.push({ entity: entityOf(e), file, message: `${file} is missing`, fix: fix.restore });
    else if (s !== 'same')
      f.fail.push({
        entity: entityOf(e),
        file,
        message: `${file} differs from what palm renders`,
        fix: fix.force,
      });
  }
  for (const [key, s] of await fragmentStates(paths, r)) {
    const file = key.split('#')[0];
    if (s === 'missing')
      f.fail.push({
        entity: entityOf(e),
        file,
        message: `palm's entry in ${file} is missing`,
        fix: fix.restore,
      });
    if (s === 'changed')
      f.fail.push({
        entity: entityOf(e),
        file,
        message: `palm's entry in ${file} was changed`,
        fix: fix.force,
      });
  }
}

/** Every listed file and fragment is on disk as the render recomputed from the cache has it. */
export async function lockDisk(c: CheckContext): Promise<CheckRun> {
  const f = found();
  for (const e of c.run.state.lock.entries) {
    if (e.declined || e.kind === 'plugin' || c.driftedSources.has(e.source)) continue;
    const out = c.renders.get(lockId(e));
    if (!out) {
      f.fail.push({
        entity: entityOf(e),
        message: `palm cannot render ${e.kind} ${e.name} from source ${e.source}`,
        fix: fixes(c, e).restore,
      });
      continue;
    }
    for (const id of Object.keys(e.render) as TargetId[]) {
      const r = out.renders[id];
      if (!r || r.hash !== e.render[id]) {
        f.fail.push({
          entity: entityOf(e),
          message: `${e.kind} ${e.name} renders differently for ${id} than palm.lock.yaml records`,
          fix: fixes(c, e).restore,
        });
        continue;
      }
      await targetDisk(c, e, r, f);
    }
  }
  return checkRun(
    'lock-disk',
    {
      ok: 'generated files match the lock',
      bad: (n) => `${count(n, 'generated file')} ${n === 1 ? 'differs' : 'differ'} from the lock`,
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
) {
  const mode = await modeOf(ref.abs);
  const file = c.run.state.paths.lockForm(ref.abs);
  let why: string | undefined;
  if (mode === undefined) why = 'does not exist';
  else if (ref.direct && !(mode & 0o111)) why = 'is not executable';
  return why
    ? { entity: entityOf(e), file, message: `${id}: ${file} ${why}`, fix: fixes(c, e).restore }
    : undefined;
}

/** Every file a hook command names exists (and is executable when the command runs it directly). */
export async function hookScripts(c: CheckContext): Promise<CheckRun> {
  const f = found();
  for (const e of c.run.state.lock.entries) {
    if (e.declined || !e.exec) continue;
    for (const cmd of e.exec.commands)
      for (const ref of scriptRefs(c, cmd.command)) {
        const p = await scriptProblem(c, e, cmd.id, ref);
        if (p) f.fail.push(p);
      }
  }
  const bad = (n: number) => `${count(n, 'hook script')} missing or not executable`;
  return checkRun('hook-scripts', { ok: 'every hook script exists', bad }, f);
}

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

/** Generated JSON and TOML files (whole files and the shared files palm merged into). */
function configFiles(c: CheckContext): Map<string, LockEntry> {
  const out = new Map<string, LockEntry>();
  for (const e of c.run.state.lock.entries)
    for (const file of [...e.files, ...(e.merged ?? []).map((m) => m.file)])
      if (/\.(json|toml)$/.test(file) && !out.has(file)) out.set(file, e);
  return out;
}

async function literalSecrets(c: CheckContext, f: Found): Promise<void> {
  const { paths } = c.run.state;
  for (const [file, owner] of configFiles(c)) {
    const abs = paths.abs(file);
    const findings = c.run.deps.scanSecrets(await readConfig(abs), file);
    if (!findings.length) continue;
    const tracked = c.git ? await isGitTracked(abs, paths.root) : undefined;
    const others = ((await modeOf(abs)) ?? 0) & 0o004;
    if (!tracked && !others) continue;
    const why = tracked ? 'tracked by git' : 'readable by others';
    const where = findings.map((x) => x.where).join(', ');
    f.fail.push({
      entity: entityOf(owner),
      file,
      message: `${file} holds a literal secret (${where}), ${why}`,
      fix: `${fixes(c, owner).force} after fixing the source`,
    });
  }
}

/** Every `${VAR}` the installed servers need, and whether it is set (unset: a warning). */
function variables(c: CheckContext, f: Found): string[] {
  const seen = new Set<string>();
  for (const e of c.run.state.lock.entries) {
    if (e.kind !== 'mcp') continue;
    const out = c.renders.get(lockId(e));
    const text = JSON.stringify(
      Object.values(out?.renders ?? {}).map((r) => r?.fragments.map((x) => x.value)),
    );
    for (const p of findPlaceholders(text)) {
      if (isRuntimeVar(p.name) || seen.has(p.name)) continue;
      seen.add(p.name);
      if (c.run.ctx.env[p.name] === undefined)
        f.warn.push({
          entity: entityOf(e),
          message: `needs ${p.name}, which is not set`,
          fix: `export ${p.name}`,
        });
    }
  }
  return [...seen].filter((v) => c.run.ctx.env[v] !== undefined);
}

/** No literal secret in a tracked or world-readable generated file; required variables listed. */
export async function secrets(c: CheckContext): Promise<CheckRun> {
  const f = found();
  await literalSecrets(c, f);
  const set = variables(c, f);
  const needs = set.length ? `; ${set.join(', ')} set` : '';
  const bad = (n: number) => `${count(n, 'secret problem')}${needs}`;
  return checkRun('secrets', { ok: `no literal secret in generated files${needs}`, bad }, f);
}

// ---------------------------------------------------------------------------
// hidden-unicode
// ---------------------------------------------------------------------------

async function textOf(abs: string): Promise<string | undefined> {
  const data = await readFile(abs).catch(() => undefined);
  if (!data || data.length > MAX_TEXT_BYTES || data.subarray(0, 8192).includes(0)) return undefined;
  return data.toString('utf8');
}

/** No critical hidden Unicode in a generated file (zero-width characters warn). */
export async function hiddenUnicode(c: CheckContext): Promise<CheckRun> {
  const f = found();
  const { paths } = c.run.state;
  for (const e of c.run.state.lock.entries)
    for (const file of e.files) {
      const text = await textOf(paths.abs(file));
      const findings = text ? scanHiddenUnicode(text) : [];
      const critical = findings.find((x) => x.severity === 'critical');
      const any = critical ?? findings[0];
      if (!any) continue;
      const problem = {
        entity: entityOf(e),
        file,
        message: `${file} holds ${any.name} (U+${any.codePoint.toString(16).toUpperCase()})`,
        fix: `fix the source, then ${fixes(c, e).force}`,
      };
      (critical ? f.fail : f.warn).push(problem);
    }
  return checkRun(
    'hidden-unicode',
    {
      ok: 'no hidden Unicode in generated files',
      bad: (n) => `${count(n, 'file')} with hidden Unicode`,
    },
    f,
  );
}
