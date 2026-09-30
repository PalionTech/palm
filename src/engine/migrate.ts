/**
 * `palm migrate` (DESIGN §6 "Migrate", 0.2 only): reads the 0.1 palm.yaml, palm.lock.yaml (v1 or
 * v2) and ~/.palm/config.yaml, writes the 0.2 palm.yaml and a lock holding the sources and the
 * files 0.1 wrote (so they are palm's to replace), replaces the `.palm/` ignore line, then runs a
 * bare install that adopts identical files, re-vendors hook scripts into `.palm/assets/` (one
 * consent for all of them) and deletes `.palm/hooks/`. `--dry-run` returns the new palm.yaml and
 * writes nothing.
 */
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { PalmError } from '../core/errors.js';
import { hashPath } from '../core/hash.js';
import type {
  EngineDeps,
  ExecUnit,
  InstallFailure,
  LegacyConfig,
  LegacyLockEntry,
  LegacyManifest,
  LockEntry,
  LockMerged,
  MigrateReport,
  PalmContext,
  Scope,
} from '../core/types.js';
import { fragmentId, fragmentKey, Lock } from '../domain/lock.js';
import { detectManifestFormat, Manifest } from '../domain/manifest.js';
import { ScopePaths } from '../domain/scope-paths.js';
import { removeEmptyTree } from '../lib/fs.js';
import { parseJson } from '../lib/json.js';
import { formatPointer, parsePointer } from '../lib/json-pointer.js';
import { deepEqual, isRecord } from '../lib/object.js';
import { readYamlFile, stringifyYaml } from '../lib/yaml.js';
import { resolveEngineDeps } from './deps.js';
import { ensureIgnoreLines } from './gitignore.js';
import { convertLegacy, kindOf, type LegacyItem, type Migration } from './migrate-legacy.js';
import { syncScope } from './sync.js';

// ---------------------------------------------------------------------------
// The files and fragments 0.1 wrote, as the provisional lock entries of the migration
// ---------------------------------------------------------------------------

async function untouched(
  paths: ScopePaths,
  file: string | { path: string; hash: string },
): Promise<string | undefined> {
  if (typeof file === 'string') return undefined;
  const abs = paths.scope === 'global' ? file.path : paths.abs(file.path);
  const hash = await hashPath(abs).catch(() => undefined);
  return hash === file.hash ? paths.lockForm(abs) : undefined;
}

function valueAt(doc: unknown, segments: string[]): unknown {
  let cur = doc;
  for (const s of segments)
    cur = isRecord(cur) || Array.isArray(cur) ? (cur as Record<string, unknown>)[s] : undefined;
  return cur;
}

/** 0.1 fragments are items of arrays under `/hooks/...` and `/instructions`, else object keys. */
function isItem(pointer: string): boolean {
  return pointer.startsWith('/hooks/') || pointer === '/instructions';
}

async function holds(abs: string, m: { pointer: string; value: unknown }): Promise<boolean> {
  const text = await readFile(abs, 'utf8').catch(() => undefined);
  if (text === undefined) return false;
  if (m.pointer.startsWith('block:'))
    return typeof m.value === 'string' && text.includes(m.value.trim());
  try {
    const doc = abs.endsWith('.toml') ? parseToml(text) : parseJson(text, { tolerant: true });
    const at = valueAt(doc, parsePointer(m.pointer));
    return isItem(m.pointer) && Array.isArray(at)
      ? at.some((x) => deepEqual(x, m.value))
      : deepEqual(at, m.value);
  } catch {
    return false;
  }
}

function mergedFor(file: string, pointer: string, value: unknown): { at: string; key: string } {
  if (pointer.startsWith('block:')) return { at: pointer, key: pointer.slice('block:'.length) };
  const segments = parsePointer(pointer);
  const last = segments[segments.length - 1] ?? '';
  if (file.endsWith('.toml')) return { at: pointer, key: last };
  if (isItem(pointer)) return { at: pointer, key: fragmentKey(pointer, value) };
  return { at: formatPointer(segments.slice(0, -1)), key: last };
}

async function mergedOf(paths: ScopePaths, item: LegacyItem): Promise<LockMerged[]> {
  const out: LockMerged[] = [];
  for (const [n, m] of (item.entry.merged ?? []).entries()) {
    const abs = paths.scope === 'global' ? m.file : paths.abs(m.file);
    if (!(await holds(abs, m))) continue;
    const file = paths.lockForm(abs);
    out.push({
      file,
      ...mergedFor(file, m.pointer, m.value),
      id: fragmentId({ kind: item.kind, name: item.entry.name }, n),
    });
  }
  return out;
}

async function provisional(paths: ScopePaths, item: LegacyItem): Promise<LockEntry> {
  const e: LegacyLockEntry = item.entry;
  const files: string[] = [];
  for (const f of e.files ?? []) {
    const kept = await untouched(paths, f);
    if (kept) files.push(kept);
  }
  const entry: LockEntry = {
    kind: item.kind,
    name: e.name,
    source: item.source,
    path: e.path,
    content: e.contentHash ?? '',
    render: {},
    files: files.sort(),
  };
  const merged = await mergedOf(paths, item);
  if (merged.length) entry.merged = merged;
  if (item.via) entry.via = item.via;
  if (item.kind === 'plugin' && e.deps?.length)
    entry.deps = e.deps.map((d) => ({ kind: kindOf(d.kind), name: d.name }));
  return entry;
}

// ---------------------------------------------------------------------------
// The new palm.yaml and lock
// ---------------------------------------------------------------------------

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

async function lockOf(paths: ScopePaths, m: Migration): Promise<Lock> {
  const lock = new Lock();
  for (const s of m.sources) {
    const ls = { ...s.lock };
    if (s.source.path) ls.path = paths.lockForm(s.source.path);
    lock.setSource(s.source.name, ls);
  }
  for (const item of m.legacy) lock.upsert(await provisional(paths, item));
  return lock;
}

// ---------------------------------------------------------------------------
// migrateScope
// ---------------------------------------------------------------------------

interface Legacy {
  manifest: LegacyManifest;
  lock: Awaited<ReturnType<typeof Lock.loadLegacy>>;
  config?: LegacyConfig;
  configFile: string;
}

async function readLegacy(paths: ScopePaths): Promise<Legacy> {
  const raw = await readYamlFile<unknown>(paths.manifestFile);
  const lock = await Lock.loadLegacy(paths.lockFile);
  const configFile = join(paths.palmHome, 'config.yaml');
  const config = await readYamlFile<LegacyConfig>(configFile);
  if (detectManifestFormat(raw) !== 'legacy' && !lock)
    throw new PalmError(
      'E_USAGE',
      'nothing to migrate: palm.yaml and palm.lock.yaml are in the 0.2 format',
      'palm install',
    );
  const manifest = detectManifestFormat(raw) === 'legacy' ? (raw as LegacyManifest) : {};
  return { manifest, lock, ...(config ? { config } : {}), configFile };
}

function sourceLines(ctx: PalmContext, m: Migration): string[] {
  const added: string[] = [];
  for (const s of m.sources) {
    if (!s.fromConfig) continue;
    added.push(s.source.name);
    ctx.log.info(
      `palm.yaml: source ${s.source.name} added from ~/.palm/config.yaml, needed by ${s.entries} entries; commit it`,
    );
  }
  return added;
}

/** `.palm/hooks/<name>` of every migrated hook, once its scripts live under `.palm/assets/`. */
async function dropHookDirs(paths: ScopePaths, lock: Lock): Promise<string[]> {
  const hooksDir =
    paths.scope === 'global' ? join(paths.palmHome, 'hooks') : join(paths.root, '.palm', 'hooks');
  const moved: string[] = [];
  for (const e of lock.entries) {
    const dir = join(hooksDir, e.name);
    if (e.kind !== 'hook' || !existsSync(dir)) continue;
    await rm(dir, { recursive: true, force: true });
    const to = e.exec?.closure?.root;
    moved.push(`${paths.lockForm(dir)}${to ? ` → ${to}` : ''}`);
  }
  await removeEmptyTree(hooksDir);
  return moved;
}

async function install(
  ctx: PalmContext,
  scope: Scope,
  deps: EngineDeps,
): Promise<{ units: ExecUnit[]; failures: InstallFailure[]; warnings: string[] }> {
  const units: ExecUnit[] = [];
  const capture: EngineDeps = {
    ...deps,
    askConsent: async (c, req) => {
      units.push(...req.units);
      return deps.askConsent(c, req);
    },
  };
  const result = await syncScope(ctx, { scope }, capture);
  return { units, failures: result.failures, warnings: result.warnings };
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
  });
  const manifest = manifestOf(paths, m);
  const lock = await lockOf(paths, m);
  const report: MigrateReport = {
    manifest: stringifyYaml(manifest.toJSON()),
    lock: stringifyYaml(lock.toJSON()),
    sourcesAdded: [],
    movedAssets: [],
    exec: [],
    warnings: [...m.warnings],
    failures: [],
  };
  if (opts.dryRun) return report;
  report.sourcesAdded = sourceLines(ctx, m);
  await rm(paths.manifestFile, { force: true });
  await manifest.save(paths.manifestFile);
  await lock.save(paths.lockFile);
  const ignore = opts.scope === 'project' ? await ensureIgnoreLines(paths.root, false) : undefined;
  if (ignore) report.gitignore = ignore;
  const installed = await install(ctx, opts.scope, deps);
  report.exec = installed.units;
  report.failures = installed.failures;
  report.warnings.push(...installed.warnings);
  report.movedAssets = await dropHookDirs(paths, await Lock.load(paths.lockFile));
  if (legacy.config) ctx.log.info('~/.palm/config.yaml is no longer read; delete it');
  return report;
}
