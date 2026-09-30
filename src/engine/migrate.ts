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
  MigrateChanged,
  MigrateRemoval,
  MigrateReport,
  PalmContext,
  Scope,
} from '../core/types.js';
import { Lock } from '../domain/lock.js';
import { detectManifestFormat, Manifest } from '../domain/manifest.js';
import { ScopePaths } from '../domain/scope-paths.js';
import {
  readTextIfExists,
  removeEmptyParents,
  removeEmptyTree,
  writeFileAtomic,
} from '../lib/fs.js';
import { parseYaml, readYamlFile, stringifyYaml } from '../lib/yaml.js';
import { resolveEngineDeps } from './deps.js';
import { ensureIgnoreLines } from './gitignore.js';
import {
  copyReason,
  heldBefore,
  hookCopyReason,
  lockNotes,
  planned,
  replacedFiles,
  sameBytes,
  sortedRemovals,
} from './migrate-files.js';
import { convertLegacy, type LegacyItem, type Migration } from './migrate-legacy.js';
import {
  adoptChanged,
  type ChangedFragment,
  type Provisional,
  provisionalLock,
} from './migrate-lock.js';
import { type Plan, planMigration } from './migrate-plan.js';
import { display, filesToCommit, shown } from './migrate-report.js';
import { withLegacyComments } from './migrate-text.js';
import { orphansOf } from './orphans.js';
import { applyAll } from './runner.js';
import { assertScope, saveScope } from './scope.js';

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

/** The files below `dir` that still hold what palm 0.1 recorded (`hashes`), and the others. */
async function copiesIn(dir: string, hashes: Map<string, string>) {
  const out = { same: [] as string[], changed: [] as string[] };
  for (const f of await filesBelow(dir)) {
    const recorded = hashes.get(f);
    const same = recorded && recorded === (await hashPath(f).catch(() => undefined));
    (same ? out.same : out.changed).push(f);
  }
  return out;
}

/**
 * Deletes the files below `dir` that still hold what palm 0.1 recorded (`hashes`); the others
 * are the person's and are named in a warning. Empty directories go. Returns the deleted files.
 */
async function dropCopies(plan: Plan, dir: string, hashes: Map<string, string>) {
  const { state, result } = plan.run;
  const { same, changed } = await copiesIn(dir, hashes);
  for (const f of same) await rm(f);
  for (const f of changed)
    result.warnings.push(
      `kept ${display(state.paths, f)}: you changed it after palm 0.1 copied it`,
    );
  await removeEmptyTree(dir);
  return same;
}

/** The 0.2 name of a 0.1 hook (renamed when palm 0.2 names it differently). */
function hookName(plan: Plan, item: LegacyItem): string {
  const to = plan.renamed.find(
    (r) => r.kind === 'hook' && r.source === item.source && r.from === item.entry.name,
  )?.to;
  return to ?? item.entry.name;
}

/** The 0.2 lock entry of a 0.1 hook that migrated. */
function migratedHook(plan: Plan, item: LegacyItem): LockEntry | undefined {
  const e = plan.run.state.lock.find({ kind: 'hook', name: hookName(plan, item) }, item.source);
  return e && Object.keys(e.render).length ? e : undefined;
}

/** N15: in a dry run, the `.palm/hooks` scripts the migration would delete. */
async function plannedHookCopies(plan: Plan, legacy: LegacyItem[]): Promise<MigrateRemoval[]> {
  const { state } = plan.run;
  const out: MigrateRemoval[] = [];
  for (const item of legacy.filter((i) => i.kind === 'hook')) {
    const name = hookName(plan, item);
    const p = plan.prepared.find(
      (x) =>
        x.job.entity.kind === 'hook' &&
        x.job.entity.name === name &&
        x.job.source.name === item.source,
    );
    if (!p || !Object.keys(p.out.renders).length) continue;
    const reason = hookCopyReason(state, { name, source: item.source, root: p.out.closure.root });
    const dir = join(state.paths.palmDir, 'hooks', item.entry.name);
    for (const f of (await copiesIn(dir, plan.hashes)).same)
      out.push({ file: display(state.paths, f), reason });
  }
  return out;
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
interface HookDirs {
  moved: string[];
  removed: MigrateRemoval[];
}

/** One migrated hook's `.palm/hooks/<name>`: its unchanged scripts go, and the report says where it runs now. */
async function moveHookDir(plan: Plan, e: LockEntry, dir: string, out: HookDirs): Promise<void> {
  const { state, ctx } = plan.run;
  const shownDir = display(state.paths, dir);
  const root = e.exec?.closure?.root;
  const reason = hookCopyReason(state, {
    name: e.name,
    source: e.source,
    ...(root ? { root } : {}),
  });
  for (const f of await dropCopies(plan, dir, plan.hashes))
    out.removed.push({ file: display(state.paths, f), reason });
  const inPlace = state.sources.byName(e.source)?.isLocal;
  if (root && !inPlace)
    out.moved.push(`${shownDir} → ${display(state.paths, state.paths.abs(root))}`);
  else
    ctx.log.info(
      `hook ${e.name} runs in place from your repository (${e.source}); removed ${shownDir}`,
    );
}

async function dropHookDirs(plan: Plan, legacy: LegacyItem[]): Promise<HookDirs> {
  const { state, result } = plan.run;
  const hooksDir = join(state.paths.palmDir, 'hooks');
  const out: HookDirs = { moved: [], removed: [] };
  for (const item of legacy.filter((i) => i.kind === 'hook')) {
    const dir = join(hooksDir, item.entry.name);
    if (!existsSync(dir)) continue;
    const e = migratedHook(plan, item);
    if (e) {
      await moveHookDir(plan, e, dir, out);
      continue;
    }
    await keepIgnored(state.paths);
    const ignored = state.paths.scope === 'project' ? ', still ignored by git' : '';
    const shownDir = display(state.paths, dir);
    result.warnings.push(`kept ${shownDir}${ignored}: hook ${item.entry.name} did not migrate`);
  }
  await removeEmptyTree(hooksDir);
  return out;
}

// ---------------------------------------------------------------------------
// After the install: the files to commit (the CLI runs `palm check` next)
// ---------------------------------------------------------------------------

async function finish(plan: Plan, report: MigrateReport): Promise<void> {
  const { state, result } = plan.run;
  report.failures = [...report.failures, ...result.failures];
  report.warnings.push(...result.warnings);
  const commit = await filesToCommit(state);
  const all = [...new Set([...(commit ?? []), ...(report.commit ?? [])])].sort();
  if (all.length) report.commit = all;
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
    // S11: every 0.1 entry the migration could not place fails it (exit 1).
    failures: [...mig.m.dropped],
  };
}

/**
 * Files 0.1 copied into a folder palm owns that 0.2 does not write there (a skill's
 * `agents/openai.yaml` goes only into `.agents/skills`): removed while they still match the
 * source at the migrated commit, so the folder holds what the lock lists. Anything else stays,
 * and `palm check` names it.
 */
async function dropStaleCopies(plan: Plan): Promise<string[]> {
  const { state, ctx } = plan.run;
  const removed: string[] = [];
  for (const p of plan.prepared) {
    const entry = state.lock.find(p.job.entity, p.job.source.name);
    for (const { dir, file } of entry ? await orphansOf(state, entry) : []) {
      const source = join(p.job.checkout.root, p.job.entity.path, file.slice(dir.length + 1));
      if (!(await sameBytes(state.paths.abs(file), source))) continue;
      await rm(state.paths.abs(file), { force: true });
      await removeEmptyParents(state.paths.abs(file), state.paths.abs(dir));
      removed.push(file);
    }
  }
  if (removed.length)
    ctx.log.info(
      `removed ${removed.length === 1 ? '1 file' : `${removed.length} files`} palm 0.1 copied that palm 0.2 does not write there: ${removed[0]}${removed.length > 1 ? ', …' : ''}`,
    );
  return removed;
}

/** The top folder of each removed file (`.claude/`): its deletion is committed with the rest. */
function topFolders(files: readonly string[]): string[] {
  return [...new Set(files.map((f) => (f.includes('/') ? `${f.slice(0, f.indexOf('/'))}/` : f)))];
}

/** X8: the install and the stray copies it removed, as report lines; in a project, their folders to commit. */
async function installAndRemove(mig: Migrating, plan: Plan, report: MigrateReport) {
  const { state } = plan.run;
  const before = heldBefore(state.lock);
  await applyAll(plan.run, plan.prepared);
  const stale = await dropStaleCopies(plan);
  const shown = (f: string) => display(state.paths, state.paths.abs(f));
  const replaced = replacedFiles(state, before, mig.m.legacy);
  const gone = [...stale.map((f) => ({ file: shown(f), reason: copyReason(f) })), ...replaced];
  if (gone.length && state.paths.scope === 'project')
    report.commit = topFolders(gone.map((r) => r.file));
  return gone;
}

/** After the consent: the files, the install, `.palm/hooks`. */
async function apply(ctx: PalmContext, mig: Migrating, plan: Plan, report: MigrateReport) {
  const { paths, m, legacy } = mig;
  report.sourcesAdded = sourceLines(ctx, paths, m);
  renameLines(ctx, plan);
  const gitignore = await writeScope(plan, report.manifest);
  if (gitignore) report.gitignore = gitignore.replace(/^\.gitignore: /, '');
  const gone = await installAndRemove(mig, plan, report);
  await saveScope(plan.run.state);
  report.lock = stringifyYaml(plan.run.state.lock.toJSON());
  const hooks = await dropHookDirs(plan, m.legacy);
  report.movedAssets = hooks.moved;
  const removed = sortedRemovals([...gone, ...hooks.removed]);
  if (removed.length) report.removed = removed;
  const notes = lockNotes(plan.run.state.lock);
  if (notes.length) report.notes = notes;
  if (legacy.config) configLine(ctx, paths.scope);
}

/** N15 M11 X8: a dry run's report: the files it would write and delete, and the notes. */
async function dryRunReport(mig: Migrating, plan: Plan, report: MigrateReport): Promise<void> {
  const refusals = plan.prepared.flatMap((p) => p.out.refusals);
  report.failures.push(...plan.run.result.failures, ...refusals);
  const { written, removed, notes } = await planned(plan, mig.m.legacy);
  const all = sortedRemovals([...removed, ...(await plannedHookCopies(plan, mig.m.legacy))]);
  if (written.length) report.written = written;
  if (all.length) report.removed = all;
  if (notes.length) report.notes = notes;
}

// ---------------------------------------------------------------------------
// V5': fragments 0.1 wrote that someone changed since
// ---------------------------------------------------------------------------

function changedRows(paths: ScopePaths, changed: readonly ChangedFragment[]): MigrateChanged[] {
  return changed.map((c) => ({
    kind: c.entry.kind,
    name: c.entry.name,
    file: display(paths, paths.abs(c.merged.file)),
    at: c.merged.at,
    action: 'ask' as const,
  }));
}

/**
 * V5': what to do with them: a dry run decides nothing, `--force` replaces them, a terminal
 * asks; without one palm refuses before anything is written.
 */
async function changedAction(
  ctx: PalmContext,
  rows: readonly MigrateChanged[],
): Promise<MigrateChanged['action']> {
  if (ctx.flags.dryRun) return 'ask';
  if (ctx.flags.force) return 'replaced';
  const list = rows.map((r) => `${r.kind} ${r.name} in ${r.file} (${r.at})`).join(', ');
  const it = rows.length === 1 ? 'it' : 'them';
  if (!ctx.ui.isInteractive)
    throw new PalmError(
      'E_CONFLICT',
      `${list} changed since palm 0.1 wrote ${it}; nothing was migrated`,
      `palm migrate --force replaces ${it} with palm 0.2's render; to keep your change, run palm migrate in a terminal and answer no`,
    );
  const replace = await ctx.ui.confirm(
    `${list} changed since palm 0.1 wrote ${it}; replace ${it} with palm 0.2's render?`,
    false,
  );
  return replace ? 'replaced' : 'kept';
}

/** V5': the changed fragments, decided; the replaced ones join the provisional lock. */
async function decideChanged(
  ctx: PalmContext,
  paths: ScopePaths,
  prov: Provisional,
): Promise<MigrateChanged[]> {
  if (!prov.changed.length) return [];
  const rows = changedRows(paths, prov.changed);
  const action = await changedAction(ctx, rows);
  if (action === 'replaced') adoptChanged(prov.lock, prov.changed);
  return rows.map((r) => ({ ...r, action }));
}

async function migrate(ctx: PalmContext, mig: Migrating, deps: EngineDeps): Promise<MigrateReport> {
  const prov = await provisionalLock(mig.paths, mig.m);
  const changed = await decideChanged(ctx, mig.paths, prov);
  const { lock, hashes } = prov;
  const manifest = manifestOf(mig.paths, mig.m);
  const report = baseReport(mig, manifest, lock);
  if (changed.length) report.changed = changed;
  const input = { manifest, lock, hashes, legacy: mig.m.legacy, sources: mig.m.sources };
  const scope = mig.paths.scope;
  const plan = await planOrReport(ctx, { ...input, text: report.manifest, scope }, report, deps);
  if (!plan) return report;
  report.manifest = withLegacyComments(plan.run.state.manifest.text(), mig.legacy.text, mig.m);
  report.exec = consented(plan);
  if (ctx.flags.dryRun) {
    await dryRunReport(mig, plan, report);
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
  // The scope guards come before the 0.1 files are read (the home directory is never a project).
  assertScope(ctx, opts.scope);
  const paths = ScopePaths.of(ctx, opts.scope);
  const c = opts.dryRun ? { ...ctx, flags: { ...ctx.flags, dryRun: true } } : ctx;
  // B1: the 0.1 files are read holding the process lock, like palm.yaml and the lock.
  const run = async () => {
    const legacy = await readLegacy(paths);
    const m = convertLegacy({
      manifest: legacy.manifest,
      ...(legacy.lock ? { lock: legacy.lock } : {}),
      ...(legacy.config ? { config: legacy.config } : {}),
      scope: opts.scope,
      root: baseDir(paths),
      palmHome: shown(paths, paths.palmHome),
    });
    return migrate(c, { paths, legacy, m }, deps);
  };
  return opts.dryRun ? run() : withScopeLock(paths, run);
}
