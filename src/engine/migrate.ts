/**
 * `palm migrate` (DESIGN §6 "Migrate", 0.2 only): reads the 0.1 palm.yaml, palm.lock.yaml (v1 or
 * v2) and ~/.palm/config.yaml and converts them to the 0.2 palm.yaml (comments kept) and a lock
 * holding the files and fragments 0.1 wrote (so they are palm's to replace). Everything that can
 * refuse comes first and writes nothing: the scope guards and the overlap rule, every source at
 * its locked commit, the bare install's render and the one consent for the programs it
 * re-vendors. Then palm.yaml, the lock and `.gitignore` are written (through symlinks), the
 * install adopts identical files and replaces what 0.1 rendered differently, `.palm/hooks/`
 * goes, and the report lists the files to commit (the CLI then runs `palm check`; a failing check
 * fails the migration). `--dry-run` returns the new palm.yaml (and shows the programs) and writes
 * nothing.
 */
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withScopeLock } from '../core/context.js';
import { isPalmError, PalmError } from '../core/errors.js';
import { hashPath } from '../core/hash.js';
import type {
  EngineDeps,
  ExecUnit,
  LegacyConfig,
  LegacyManifest,
  LockEntry,
  MigrateReport,
  PalmContext,
  Scope,
} from '../core/types.js';
import { Lock } from '../domain/lock.js';
import { detectManifestFormat, Manifest } from '../domain/manifest.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { readTextIfExists, removeEmptyTree, writeFileAtomic } from '../lib/fs.js';
import { parseYaml, readYamlFile, stringifyYaml } from '../lib/yaml.js';
import { resolveEngineDeps } from './deps.js';
import { ensureIgnoreLines } from './gitignore.js';
import { convertLegacy, type LegacyItem, type Migration } from './migrate-legacy.js';
import { provisionalLock } from './migrate-lock.js';
import { type Plan, planMigration } from './migrate-plan.js';
import { display, filesToCommit, shown } from './migrate-report.js';
import { withLegacyComments } from './migrate-text.js';
import { applyAll } from './runner.js';
import { saveScope } from './scope.js';

// ---------------------------------------------------------------------------
// The 0.1 files
// ---------------------------------------------------------------------------

interface Legacy {
  manifest: LegacyManifest;
  /** palm.yaml as written, for its comments. */
  text?: string;
  lock: Awaited<ReturnType<typeof Lock.loadLegacy>>;
  config?: LegacyConfig;
}

async function readLegacy(paths: ScopePaths): Promise<Legacy> {
  const text = await readTextIfExists(paths.manifestFile);
  const raw = text === undefined ? undefined : parseYaml<unknown>(text, paths.manifestFile);
  const lock = await Lock.loadLegacy(paths.lockFile);
  const config = await readYamlFile<LegacyConfig>(join(paths.palmHome, 'config.yaml'));
  const legacy = detectManifestFormat(raw) === 'legacy';
  if (!legacy && !lock)
    throw new PalmError(
      'E_USAGE',
      'nothing to migrate: palm.yaml and palm.lock.yaml are in the 0.2 format',
      paths.scope === 'global' ? 'palm install -g' : 'palm install',
    );
  return {
    manifest: legacy ? (raw as LegacyManifest) : {},
    ...(legacy && text !== undefined ? { text } : {}),
    lock,
    ...(config ? { config } : {}),
  };
}

function baseDir(paths: ScopePaths): string {
  return paths.scope === 'global' ? paths.palmHome : paths.root;
}

function manifestOf(paths: ScopePaths, m: Migration): Manifest {
  const manifest = Manifest.of({});
  if (m.targets) manifest.setTargets(m.targets);
  for (const s of m.sources) manifest.addSource(s.source, baseDir(paths));
  for (const e of m.entries) manifest.addEntry(e.source, e.kind, e.entry);
  for (const s of m.mcp) manifest.setMcp(s.name, s.entry);
  return manifest;
}

// ---------------------------------------------------------------------------
// Lines for the person
// ---------------------------------------------------------------------------

function sourceLines(ctx: PalmContext, paths: ScopePaths, m: Migration): string[] {
  const added: string[] = [];
  const file = paths.scope === 'global' ? '~/.palm/palm.yaml' : 'palm.yaml';
  const tail = paths.scope === 'global' ? '' : '; commit it';
  for (const s of m.sources) {
    if (!s.fromConfig) continue;
    added.push(s.source.name);
    const needed = `${s.entries} ${s.entries === 1 ? 'entry' : 'entries'}`;
    ctx.log.info(
      `${file}: source ${s.source.name} added from ~/.palm/config.yaml, needed by ${needed}${tail}`,
    );
  }
  return added;
}

/** The migration guide's advice: config.yaml stays until every project is migrated. */
function configLine(ctx: PalmContext, scope: Scope): void {
  ctx.log.info(
    scope === 'global'
      ? '~/.palm/config.yaml is no longer read; delete it once every project is migrated'
      : 'keep ~/.palm/config.yaml until every project is migrated; palm migrate reads it',
  );
}

function renameLines(ctx: PalmContext, plan: Plan): void {
  for (const r of plan.renamed)
    ctx.log.info(
      `${r.kind} ${r.from} from ${r.source} is ${r.kind} ${r.to} in palm 0.2 (named after its folder)`,
    );
}

// ---------------------------------------------------------------------------
// .palm/hooks: 0.1's copies of hook scripts
// ---------------------------------------------------------------------------

async function filesBelow(dir: string): Promise<string[]> {
  const found = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return found.filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name));
}

/**
 * Deletes the files below `dir` that still hold what palm 0.1 recorded (`hashes`); the others
 * are the person's and are named in a warning. Empty directories go.
 */
async function dropCopies(plan: Plan, dir: string, hashes: Map<string, string>): Promise<void> {
  const { state, result } = plan.run;
  for (const f of await filesBelow(dir)) {
    const recorded = hashes.get(f);
    if (recorded && recorded === (await hashPath(f).catch(() => undefined))) await rm(f);
    else
      result.warnings.push(
        `kept ${display(state.paths, f)}: you changed it after palm 0.1 copied it`,
      );
  }
  await removeEmptyTree(dir);
}

/** The 0.2 lock entry of a 0.1 hook (renamed when palm 0.2 names it differently). */
function migratedHook(plan: Plan, item: LegacyItem): LockEntry | undefined {
  const to = plan.renamed.find(
    (r) => r.kind === 'hook' && r.source === item.source && r.from === item.entry.name,
  )?.to;
  const e = plan.run.state.lock.find({ kind: 'hook', name: to ?? item.entry.name }, item.source);
  return e && Object.keys(e.render).length ? e : undefined;
}

/**
 * A hook that did not migrate keeps its `.palm/hooks/<name>` copy (its 0.1 command still runs
 * it), so the project's `.gitignore` keeps ignoring `.palm/hooks/` until it does.
 */
async function keepIgnored(paths: ScopePaths): Promise<void> {
  if (paths.scope !== 'project') return;
  const file = join(paths.root, '.gitignore');
  const text = (await readTextIfExists(file)) ?? '';
  if (text.split('\n').some((l) => l.trim() === '.palm/hooks/')) return;
  await writeFileAtomic(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.palm/hooks/\n`);
}

/**
 * `.palm/hooks/<name>` of every migrated hook goes: the scripts now live under `.palm/assets/`
 * (or run in place from an in-repo source). A hook that did not migrate keeps its copy, since
 * its 0.1 command still runs it.
 */
async function dropHookDirs(plan: Plan, legacy: LegacyItem[], hashes: Map<string, string>) {
  const { state, result, ctx } = plan.run;
  const hooksDir = join(state.paths.palmDir, 'hooks');
  const moved: string[] = [];
  for (const item of legacy.filter((i) => i.kind === 'hook')) {
    const dir = join(hooksDir, item.entry.name);
    if (!existsSync(dir)) continue;
    const shownDir = display(state.paths, dir);
    const e = migratedHook(plan, item);
    if (!e) {
      await keepIgnored(state.paths);
      const ignored = state.paths.scope === 'project' ? ', still ignored by git' : '';
      result.warnings.push(`kept ${shownDir}${ignored}: hook ${item.entry.name} did not migrate`);
      continue;
    }
    await dropCopies(plan, dir, hashes);
    const root = e.exec?.closure?.root;
    if (root) moved.push(`${shownDir} → ${display(state.paths, state.paths.abs(root))}`);
    else
      ctx.log.info(
        `hook ${e.name} runs in place from your repository (${e.source}); removed ${shownDir}`,
      );
  }
  await removeEmptyTree(hooksDir);
  return moved;
}

// ---------------------------------------------------------------------------
// After the install: the files to commit (the CLI runs `palm check` next)
// ---------------------------------------------------------------------------

async function finish(plan: Plan, report: MigrateReport): Promise<void> {
  const { state, result } = plan.run;
  report.failures = [...result.failures];
  report.warnings.push(...result.warnings);
  const commit = await filesToCommit(state);
  if (commit) report.commit = commit;
}

// ---------------------------------------------------------------------------
// migrateScope
// ---------------------------------------------------------------------------

/** The first write of the migration: palm.yaml (comments kept), the lock and `.gitignore`. */
async function writeScope(plan: Plan, text: string): Promise<string | undefined> {
  const { paths, lock } = plan.run.state;
  await writeFileAtomic(paths.manifestFile, text);
  await lock.save(paths.lockFile);
  if (paths.scope !== 'project') return undefined;
  return ensureIgnoreLines(paths.root, false);
}

/** The programs re-vendored with the one consent (in a dry run: the ones it would ask for). */
function consented(plan: Plan): ExecUnit[] {
  const asked = plan.run.ctx.flags.dryRun ? ['allowed', 'ask'] : ['allowed'];
  return plan.prepared.filter((p) => asked.includes(p.consent)).map((p) => p.out.unit as ExecUnit);
}

/** Up to the consent; in a dry run a refusal is reported with the preview instead of thrown. */
async function planOrReport(
  ctx: PalmContext,
  input: Parameters<typeof planMigration>[2] & { scope: Scope },
  report: MigrateReport,
  deps: EngineDeps,
): Promise<Plan | undefined> {
  try {
    return await planMigration(ctx, input.scope, input, deps);
  } catch (e) {
    if (!ctx.flags.dryRun || !isPalmError(e) || e.code === 'E_CANCELLED') throw e;
    report.failures.push({
      kind: 'source',
      name: '',
      source: 'palm.yaml',
      code: e.code,
      message: e.message,
      ...(e.hint ? { hint: e.hint } : {}),
    });
    return undefined;
  }
}

/** One migration: the scope, its 0.1 files and their conversion. */
interface Migrating {
  paths: ScopePaths;
  legacy: Legacy;
  m: Migration;
}

function baseReport(mig: Migrating, manifest: Manifest, lock: Lock): MigrateReport {
  return {
    manifest: withLegacyComments(manifest.text(), mig.legacy.text, mig.m),
    lock: stringifyYaml(lock.toJSON()),
    sourcesAdded: [],
    movedAssets: [],
    exec: [],
    warnings: [...mig.m.warnings],
    failures: [],
  };
}

/** After the consent: the files, the install, `.palm/hooks`. */
async function apply(ctx: PalmContext, mig: Migrating, plan: Plan, report: MigrateReport) {
  const { paths, m, legacy } = mig;
  report.sourcesAdded = sourceLines(ctx, paths, m);
  renameLines(ctx, plan);
  const gitignore = await writeScope(plan, report.manifest);
  if (gitignore) report.gitignore = gitignore.replace(/^\.gitignore: /, '');
  await applyAll(plan.run, plan.prepared);
  await saveScope(plan.run.state);
  report.lock = stringifyYaml(plan.run.state.lock.toJSON());
  report.movedAssets = await dropHookDirs(plan, m.legacy, plan.hashes);
  if (legacy.config) configLine(ctx, paths.scope);
}

async function migrate(ctx: PalmContext, mig: Migrating, deps: EngineDeps): Promise<MigrateReport> {
  const { lock, hashes } = await provisionalLock(mig.paths, mig.m);
  const manifest = manifestOf(mig.paths, mig.m);
  const report = baseReport(mig, manifest, lock);
  const input = { manifest, lock, hashes, legacy: mig.m.legacy, text: report.manifest };
  const plan = await planOrReport(ctx, { ...input, scope: mig.paths.scope }, report, deps);
  if (!plan) return report;
  report.manifest = withLegacyComments(plan.run.state.manifest.text(), mig.legacy.text, mig.m);
  report.exec = consented(plan);
  if (ctx.flags.dryRun) {
    const refusals = plan.prepared.flatMap((p) => p.out.refusals);
    report.failures.push(...plan.run.result.failures, ...refusals);
    return report;
  }
  await apply(ctx, mig, plan, report);
  await finish(plan, report);
  return report;
}

/** DESIGN §6 "Migrate". */
export async function migrateScope(
  ctx: PalmContext,
  opts: { scope: Scope; dryRun: boolean },
  depsIn?: Partial<EngineDeps>,
): Promise<MigrateReport> {
  const deps = await resolveEngineDeps(depsIn);
  const paths = ScopePaths.of(ctx, opts.scope);
  const legacy = await readLegacy(paths);
  const m = convertLegacy({
    manifest: legacy.manifest,
    ...(legacy.lock ? { lock: legacy.lock } : {}),
    ...(legacy.config ? { config: legacy.config } : {}),
    scope: opts.scope,
    root: baseDir(paths),
    palmHome: shown(paths, paths.palmHome),
  });
  const c = opts.dryRun ? { ...ctx, flags: { ...ctx.flags, dryRun: true } } : ctx;
  const run = () => migrate(c, { paths, legacy, m }, deps);
  return opts.dryRun ? run() : withScopeLock(paths, run);
}
