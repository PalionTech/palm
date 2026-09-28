import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import pc from 'picocolors';
import { messageOf } from '../core/errors.js';
import {
  type LockEntry,
  type OriginSpec,
  type PalmContext,
  type Scope,
  TARGET_IDS,
} from '../core/types.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { pathExists } from '../lib/fs.js';
import { type Output, symbol } from '../ui/output.js';
import type { App } from './app.js';
import { dirSize, formatBytes } from './disk.js';
import type { Invocation } from './grammar.js';
import { ExitSignal, type GlobalOptions, makeContext } from './shared.js';

export type CheckStatus = 'ok' | 'info' | 'warn' | 'fail';
export interface Check {
  group: string;
  name: string;
  status: CheckStatus;
  detail: string;
}

const SYMBOL: Record<CheckStatus, string> = {
  ok: symbol('added'),
  info: symbol('info'),
  warn: symbol('warning'),
  fail: symbol('error'),
};

/** Nearest existing ancestor of `p` (for writability checks before palm home exists). */
async function nearestExisting(p: string): Promise<string> {
  let cur = p;
  while (!(await pathExists(cur))) {
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

async function checkGit(): Promise<Check> {
  try {
    const { stdout } = await execa('git', ['--version'], { timeout: 10_000 });
    return { group: 'system', name: 'git', status: 'ok', detail: stdout.trim() };
  } catch {
    return {
      group: 'system',
      name: 'git',
      status: 'fail',
      detail: 'git not found on PATH (needed to fetch origins)',
    };
  }
}

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 22
    ? { group: 'system', name: 'node', status: 'ok', detail: `v${process.versions.node}` }
    : {
        group: 'system',
        name: 'node',
        status: 'fail',
        detail: `v${process.versions.node}; palm needs Node 22 or newer`,
      };
}

async function checkPalmHome(ctx: PalmContext): Promise<Check[]> {
  const home = ctx.paths.palmHome;
  const probe = await nearestExisting(home);
  const writable = await access(probe, constants.W_OK).then(
    () => true,
    () => false,
  );
  const checks: Check[] = [
    writable
      ? {
          group: 'palm',
          name: 'palm home',
          status: 'ok',
          detail: probe === home ? home : `${home} (will be created)`,
        }
      : { group: 'palm', name: 'palm home', status: 'fail', detail: `${probe} is not writable` },
  ];
  const cache = join(home, 'cache');
  checks.push({
    group: 'palm',
    name: 'cache',
    status: 'info',
    detail: (await pathExists(cache))
      ? `${formatBytes(await dirSize(cache))} in ${cache}`
      : 'empty',
  });
  return checks;
}

async function checkTargets(ctx: PalmContext): Promise<Check[]> {
  const { getTarget } = await import('../targets/index.js');
  const checks: Check[] = [];
  for (const id of TARGET_IDS) {
    const t = getTarget(id);
    const found: string[] = [];
    for (const scope of SCOPES) {
      const root = ScopePaths.of(ctx, scope).root;
      if (await t.detect(scope, root, ctx.env).catch(() => false)) found.push(scope);
    }
    checks.push({
      group: 'targets',
      name: t.displayName,
      status: found.length ? 'ok' : 'info',
      detail: found.length ? `detected (${found.join(', ')})` : 'not detected',
    });
  }
  return checks;
}

const SCOPES: readonly Scope[] = ['project', 'global'];

async function missingFiles(sp: ScopePaths, e: LockEntry): Promise<string | undefined> {
  const missing: string[] = [];
  for (const f of e.files) if (!(await pathExists(sp.abs(f)))) missing.push(f);
  if (!missing.length) return undefined;
  return `${e.kind} ${e.name}: ${missing.length}/${e.files.length} files missing (e.g. ${missing[0]})`;
}

/** Lock entries whose files are gone, and manifest entries that are not installed, in one scope. */
async function scopeDrift(ctx: PalmContext, scope: Scope): Promise<Check> {
  const { loadLock } = await import('../core/lockfile.js');
  const { loadManifest } = await import('../core/manifest.js');
  const { manifestDeps, satisfies } = await import('../engine/sync.js');
  const sp = ScopePaths.of(ctx, scope);
  const lock = await loadLock(sp.lockFile);
  const manifest = await loadManifest(sp.manifestFile);
  const problems: string[] = [];
  for (const e of lock.entries as LockEntry[]) {
    const problem = await missingFiles(sp, e);
    if (problem) problems.push(problem);
  }
  for (const d of manifestDeps(manifest))
    if (!lock.entries.some((e) => satisfies(e, d)))
      problems.push(`${d.kind} ${d.dep.name} is in palm.yaml but not installed`);
  const name = `${scope} scope`;
  if (!problems.length) {
    const n = lock.entries.length;
    return {
      group: 'lock',
      name,
      status: 'ok',
      detail: `${n} entr${n === 1 ? 'y' : 'ies'}, no drift`,
    };
  }
  const fix = `palm install${scope === 'global' ? ' -g' : ''}`;
  return {
    group: 'lock',
    name,
    status: 'warn',
    detail: `${problems.join('; ')}; fix with: ${fix}`,
  };
}

async function checkDrift(ctx: PalmContext): Promise<Check[]> {
  return Promise.all(SCOPES.map((scope) => scopeDrift(ctx, scope)));
}

async function checkOrigin(spec: OriginSpec): Promise<Check> {
  if (spec.type === 'local') {
    const ok = spec.path ? await pathExists(spec.path) : false;
    return {
      group: 'origins',
      name: spec.alias,
      status: ok ? 'ok' : 'fail',
      detail: ok ? `${spec.path}` : `directory missing: ${spec.path ?? '(no path)'}`,
    };
  }
  try {
    const { pingRemote } = await import('../core/git.js');
    await pingRemote(spec.url ?? '');
    return { group: 'origins', name: spec.alias, status: 'ok', detail: `reachable (${spec.url})` };
  } catch (e) {
    const msg = messageOf(e).split('\n')[0];
    return {
      group: 'origins',
      name: spec.alias,
      status: 'fail',
      detail: `unreachable: ${spec.url} (${msg})`,
    };
  }
}

async function safely(group: string, fn: () => Promise<Check[]>): Promise<Check[]> {
  try {
    return await fn();
  } catch (e) {
    return [
      {
        group,
        name: group,
        status: 'warn',
        detail: `check failed: ${messageOf(e)}`,
      },
    ];
  }
}

async function originChecks(ctx: PalmContext): Promise<Check[]> {
  if (ctx.flags.offline)
    return [{ group: 'origins', name: 'origins', status: 'info', detail: 'skipped (--offline)' }];
  return safely('origins', async () => {
    const { allOrigins } = await import('../core/config.js');
    const specs = allOrigins(ctx);
    if (specs.length === 0)
      return [{ group: 'origins', name: 'origins', status: 'info', detail: 'none registered' }];
    return Promise.all(specs.map((s) => checkOrigin(s)));
  });
}

function printChecks(out: Output, checks: Check[]): void {
  let group = '';
  for (const c of checks) {
    if (c.group !== group) {
      out.out(`${group ? '\n' : ''}${pc.bold(c.group)}`);
      group = c.group;
    }
    const detail = c.status === 'info' ? pc.dim(c.detail) : c.detail;
    out.out(`  ${SYMBOL[c.status]} ${c.name.padEnd(16)} ${detail}`);
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** `palm doctor`: git, node, palm home, harness detection, lock drift, origin reachability. */
export async function run(inv: Invocation, app: App): Promise<void> {
  const ctx = await makeContext(app, inv.opts as GlobalOptions, { interactive: false });
  const checks: Check[] = [await checkGit(), checkNode()];
  checks.push(...(await safely('palm', () => checkPalmHome(ctx))));
  checks.push(...(await safely('targets', () => checkTargets(ctx))));
  checks.push(...(await safely('lock', () => checkDrift(ctx))));
  checks.push(...(await originChecks(ctx)));
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  const out = app.out;
  if (out.jsonMode) out.json(checks);
  else {
    printChecks(out, checks);
    const problems = failed ? pc.red(plural(failed, 'problem')) : pc.green('no problems');
    out.out(`\n${problems}${warned ? pc.yellow(`, ${plural(warned, 'warning')}`) : ''}`);
  }
  if (failed) throw new ExitSignal(1);
}
