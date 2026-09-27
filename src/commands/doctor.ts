import { constants } from 'node:fs';
import { access, lstat, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { Command } from 'commander';
import { execa } from 'execa';
import pc from 'picocolors';
import { KINDS, TARGET_IDS, type LockEntry, type OriginSpec, type PalmContext, type Scope } from '../core/types.js';
import { ExitSignal, makeContext, printJson, type GlobalOptions } from './shared.js';

export type CheckStatus = 'ok' | 'info' | 'warn' | 'fail';
export interface Check {
  group: string;
  name: string;
  status: CheckStatus;
  detail: string;
}

const SYMBOL: Record<CheckStatus, string> = {
  ok: pc.green('✓'),
  info: pc.dim('·'),
  warn: pc.yellow('⚠'),
  fail: pc.red('✗'),
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await lstat(p).catch(() => undefined))?.size ?? 0;
  }
  return total;
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/** Nearest existing ancestor of `p` (for writability checks before palm home exists). */
async function nearestExisting(p: string): Promise<string> {
  let cur = p;
  while (!(await exists(cur))) {
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
    return { group: 'system', name: 'git', status: 'fail', detail: 'git not found on PATH (needed to fetch origins)' };
  }
}

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 22
    ? { group: 'system', name: 'node', status: 'ok', detail: `v${process.versions.node}` }
    : { group: 'system', name: 'node', status: 'fail', detail: `v${process.versions.node}; palm needs Node 22 or newer` };
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
      ? { group: 'palm', name: 'palm home', status: 'ok', detail: probe === home ? home : `${home} (will be created)` }
      : { group: 'palm', name: 'palm home', status: 'fail', detail: `${probe} is not writable` },
  ];
  const cache = join(home, 'cache');
  checks.push({ group: 'palm', name: 'cache', status: 'info', detail: (await exists(cache)) ? `${formatBytes(await dirSize(cache))} in ${cache}` : 'empty' });
  return checks;
}

async function checkTargets(ctx: PalmContext): Promise<Check[]> {
  const { getTarget } = await import('../targets/index.js');
  const checks: Check[] = [];
  for (const id of TARGET_IDS) {
    const t = getTarget(id);
    const found: string[] = [];
    for (const scope of ['project', 'global'] as Scope[]) {
      const root = scope === 'global' ? ctx.paths.home : ctx.paths.projectRoot;
      if (await t.detect(scope, root, ctx.env).catch(() => false)) found.push(scope);
    }
    checks.push({ group: 'targets', name: t.displayName, status: found.length ? 'ok' : 'info', detail: found.length ? `detected (${found.join(', ')})` : 'not detected' });
  }
  return checks;
}

/** Lock entries whose files are gone, and manifest entries that are not installed. */
async function checkDrift(ctx: PalmContext): Promise<Check[]> {
  const { lockPath, manifestPath } = await import('../core/paths.js');
  const { loadLock } = await import('../core/lockfile.js');
  const { loadManifest, listDeps } = await import('../core/manifest.js');
  const checks: Check[] = [];
  for (const scope of ['project', 'global'] as Scope[]) {
    const root = scope === 'global' ? ctx.paths.home : ctx.paths.projectRoot;
    const lock = await loadLock(lockPath(ctx.paths, scope));
    const manifest = await loadManifest(manifestPath(ctx.paths, scope));
    const problems: string[] = [];
    for (const e of lock.entries as LockEntry[]) {
      const missing: string[] = [];
      for (const f of e.files) if (!(await exists(isAbsolute(f) ? f : join(root, f)))) missing.push(f);
      if (missing.length) problems.push(`${e.kind} ${e.name}: ${missing.length}/${e.files.length} files missing (e.g. ${missing[0]})`);
    }
    for (const kind of KINDS) {
      for (const dep of listDeps(manifest, kind)) {
        if (!lock.entries.some((e) => e.kind === kind && e.name === dep.name)) problems.push(`${kind} ${dep.name} is in palm.yaml but not installed`);
      }
    }
    checks.push(
      problems.length
        ? { group: 'lock', name: `${scope} scope`, status: 'warn', detail: `${problems.join('; ')} — run \`palm install${scope === 'global' ? ' -g' : ''}\`` }
        : { group: 'lock', name: `${scope} scope`, status: 'ok', detail: `${lock.entries.length} entr${lock.entries.length === 1 ? 'y' : 'ies'}, no drift` },
    );
  }
  return checks;
}

async function checkOrigin(ctx: PalmContext, spec: OriginSpec): Promise<Check> {
  if (spec.type === 'local') {
    const ok = spec.path ? await exists(spec.path) : false;
    return { group: 'origins', name: spec.alias, status: ok ? 'ok' : 'fail', detail: ok ? `${spec.path}` : `directory missing: ${spec.path ?? '(no path)'}` };
  }
  try {
    await execa('git', ['ls-remote', '--exit-code', spec.url ?? '', 'HEAD'], {
      timeout: 20_000,
      env: { ...ctx.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { group: 'origins', name: spec.alias, status: 'ok', detail: `reachable (${spec.url})` };
  } catch (e) {
    const msg = e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
    return { group: 'origins', name: spec.alias, status: 'fail', detail: `unreachable: ${spec.url} (${msg})` };
  }
}

async function safely(group: string, fn: () => Promise<Check[]>): Promise<Check[]> {
  try {
    return await fn();
  } catch (e) {
    return [{ group, name: group, status: 'warn', detail: `check failed: ${e instanceof Error ? e.message : String(e)}` }];
  }
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .summary('check the environment, targets, lockfiles and origins')
    .description('Check git and Node, palm home, harness detection, lock/manifest drift and origin reachability (skipped with --offline).')
    .action(async (_opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = await makeContext(g, { interactive: false });
      const checks: Check[] = [await checkGit(), checkNode()];
      checks.push(...(await safely('palm', () => checkPalmHome(ctx))));
      checks.push(...(await safely('targets', () => checkTargets(ctx))));
      checks.push(...(await safely('lock', () => checkDrift(ctx))));
      if (ctx.flags.offline) {
        checks.push({ group: 'origins', name: 'origins', status: 'info', detail: 'skipped (--offline)' });
      } else {
        checks.push(
          ...(await safely('origins', async () => {
            const { allOrigins } = await import('../core/config.js');
            const specs = allOrigins(ctx);
            if (specs.length === 0) return [{ group: 'origins', name: 'origins', status: 'info', detail: 'none registered' } satisfies Check];
            return Promise.all(specs.map((s) => checkOrigin(ctx, s)));
          })),
        );
      }

      const failed = checks.filter((c) => c.status === 'fail').length;
      const warned = checks.filter((c) => c.status === 'warn').length;
      if (g.json) printJson(checks);
      else {
        let group = '';
        for (const c of checks) {
          if (c.group !== group) {
            group = c.group;
            console.log(`${group === checks[0]?.group ? '' : '\n'}${pc.bold(group)}`);
          }
          console.log(`  ${SYMBOL[c.status]} ${c.name.padEnd(16)} ${c.status === 'info' ? pc.dim(c.detail) : c.detail}`);
        }
        console.log(
          `\n${failed ? pc.red(`${failed} problem${failed === 1 ? '' : 's'}`) : pc.green('no problems')}${warned ? pc.yellow(`, ${warned} warning${warned === 1 ? '' : 's'}`) : ''}`,
        );
      }
      if (failed) throw new ExitSignal(1);
    });
}
