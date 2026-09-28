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
import { isWithin, pathExists } from '../lib/fs.js';
import { isSafeName } from '../lib/names.js';
import { plural } from '../lib/text.js';
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

/** The copied-scripts dir of a hook entry that has one (`.palm/hooks/<n>`, `$PALM_HOME/hooks/<n>`). */
function hookAssetDir(sp: ScopePaths, e: LockEntry): string | undefined {
  if (e.kind !== 'hook' || !isSafeName(e.name)) return undefined;
  const dir = sp.hooksAssetDir(e.name);
  return e.files.some((f) => isWithin(sp.abs(f.path), dir)) ? dir : undefined;
}

/** Missing files of `e`; hook assets are left to `hookAssets`, which names the fix. */
async function missingFiles(sp: ScopePaths, e: LockEntry): Promise<string | undefined> {
  const assets = hookAssetDir(sp, e);
  const files = e.files.filter((f) => !assets || !isWithin(sp.abs(f.path), assets));
  const missing: string[] = [];
  for (const { path } of files) if (!(await pathExists(sp.abs(path)))) missing.push(path);
  if (!missing.length) return undefined;
  return `${e.kind} ${e.name}: ${missing.length}/${files.length} files missing (e.g. ${missing[0]})`;
}

/** Merged fragments of `e` (MCP keys, hook entries, instruction blocks) no longer in their file. */
async function mergedDrift(sp: ScopePaths, e: LockEntry): Promise<string | undefined> {
  const { Lock } = await import('../domain/lock.js');
  const { mergedRecordState } = await import('../targets/merged-state.js');
  const { driftWords, mergedLabel } = await import('../engine/sync.js');
  const drift = await Lock.mergedDrift(e, sp, mergedRecordState);
  if (!drift.length) return undefined;
  const what = drift.map((d) => `${mergedLabel(d.record)} ${driftWords(d.state)}`);
  return `${e.kind} ${e.name}: ${what.join(', ')}`;
}

/** Lock entries whose files or merged fragments are gone, and manifest entries not installed, in one scope. */
async function scopeDrift(ctx: PalmContext, scope: Scope): Promise<Check> {
  const { Lock } = await import('../domain/lock.js');
  const { Manifest } = await import('../domain/manifest.js');
  const { manifestDeps, satisfies } = await import('../engine/sync.js');
  const sp = ScopePaths.of(ctx, scope);
  const lock = await Lock.load(sp.lockFile);
  const manifest = await Manifest.load(sp.manifestFile);
  const problems: string[] = [];
  for (const e of lock.entries) {
    for (const problem of [await missingFiles(sp, e), await mergedDrift(sp, e)])
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

/**
 * Hook scripts live outside the committed configs (`.palm/hooks` is gitignored), so a fresh
 * clone has the hook entries but not their scripts. One check per scope with hook assets.
 */
async function hookAssets(ctx: PalmContext, scope: Scope): Promise<Check | undefined> {
  const { Lock } = await import('../domain/lock.js');
  const sp = ScopePaths.of(ctx, scope);
  const dirs = (await Lock.load(sp.lockFile)).entries
    .map((e) => hookAssetDir(sp, e))
    .filter((d): d is string => d !== undefined);
  if (dirs.length === 0) return undefined;
  const missing: string[] = [];
  for (const d of dirs) if (!(await pathExists(d))) missing.push(sp.lockForm(d));
  const name = `${scope} scope`;
  if (!missing.length)
    return {
      group: 'hooks',
      name,
      status: 'ok',
      detail: `${plural(dirs.length, 'hook asset dir')} present`,
    };
  const fix =
    scope === 'global'
      ? 'run `palm install -g` to restore hook assets'
      : 'run `palm install` to restore hook assets after a fresh clone';
  return { group: 'hooks', name, status: 'warn', detail: `missing ${missing.join(', ')}; ${fix}` };
}

/**
 * Files palm wrote that the user changed since (their hash differs from the lock's): palm keeps
 * them on uninstall and refuses to overwrite them without --force. One line per scope with any.
 */
async function editedFiles(ctx: PalmContext, scope: Scope): Promise<Check | undefined> {
  const { Lock } = await import('../domain/lock.js');
  const { hashPath } = await import('../core/hash.js');
  const sp = ScopePaths.of(ctx, scope);
  let n = 0;
  for (const e of (await Lock.load(sp.lockFile)).entries)
    n += (await Lock.modifiedFiles(e, sp, (abs) => hashPath(abs))).length;
  if (n === 0) return undefined;
  const audit = `palm audit${scope === 'global' ? ' -g' : ''}`;
  const detail = `${plural(n, 'palm-owned file')} modified since install (see \`${audit}\`)`;
  return { group: 'files', name: `${scope} scope`, status: 'warn', detail };
}

async function checkEditedFiles(ctx: PalmContext): Promise<Check[]> {
  const checks = await Promise.all(SCOPES.map((scope) => editedFiles(ctx, scope)));
  return checks.filter((c): c is Check => c !== undefined);
}

async function checkHookAssets(ctx: PalmContext): Promise<Check[]> {
  const checks = await Promise.all(SCOPES.map((scope) => hookAssets(ctx, scope)));
  return checks.filter((c): c is Check => c !== undefined);
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
    const specs = ctx.origins.specs();
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

/**
 * `palm doctor`: git, node, palm home, harness detection, lock drift, hook assets, files the user
 * edited since palm wrote them, origin reachability.
 */
export async function run(inv: Invocation, app: App): Promise<void> {
  const ctx = await makeContext(app, inv.opts as GlobalOptions, { interactive: false });
  const checks: Check[] = [await checkGit(), checkNode()];
  checks.push(...(await safely('palm', () => checkPalmHome(ctx))));
  checks.push(...(await safely('targets', () => checkTargets(ctx))));
  checks.push(...(await safely('lock', () => checkDrift(ctx))));
  checks.push(...(await safely('hooks', () => checkHookAssets(ctx))));
  checks.push(...(await safely('files', () => checkEditedFiles(ctx))));
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
