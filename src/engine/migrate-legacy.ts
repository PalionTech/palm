/**
 * The 0.1 formats to the 0.2 model (DESIGN §6 "Migrate", PLAN.md 8), as data: every alias an
 * entry uses becomes a source keyed by `owner/repo` (GitHub) or `./dir` (in the project), else by
 * the alias; `name@alias#ref` becomes an entry under its source; a plugin keeps its uninstalled
 * members as `exclude:`; a command becomes a skill; registry and ad hoc MCP servers move to
 * `mcp:`; `--target` leaks become per-entry `targets:`. No IO here.
 */
import { relative } from 'node:path';
import type {
  Kind,
  LegacyConfig,
  LegacyLockEntry,
  LegacyLockfile,
  LegacyManifest,
  LegacyOriginSpec,
  LockSource,
  ManifestEntry,
  McpManifestEntry,
  Scope,
  Source,
  TargetId,
} from '../core/types.js';
import { isRecord } from '../lib/object.js';
import { MANIFEST_SOURCE } from './sources.js';

export interface LegacyInput {
  manifest: LegacyManifest;
  lock?: LegacyLockfile;
  config?: LegacyConfig;
  scope: Scope;
  /** The directory local paths in palm.yaml are relative to (project root, or $PALM_HOME). */
  root: string;
}

interface MigratedSource {
  source: Source;
  lock: LockSource;
  fromConfig: boolean;
  entries: number;
}

export interface LegacyItem {
  entry: LegacyLockEntry;
  source: string;
  kind: Kind;
  via?: string;
}

export interface Migration {
  targets?: TargetId[];
  sources: MigratedSource[];
  entries: Array<{ source: string; kind: Kind; entry: ManifestEntry }>;
  mcp: Array<{ name: string; entry: McpManifestEntry }>;
  legacy: LegacyItem[];
  warnings: string[];
}

const SECTIONS: Record<string, Kind> = {
  skills: 'skill',
  commands: 'skill',
  agents: 'agent',
  instructions: 'instruction',
  hooks: 'hook',
  plugins: 'plugin',
};

interface Dep {
  kind: Kind;
  name: string;
  origin?: string;
  ref?: string;
}

function parseDep(raw: unknown, kind: Kind): Dep | undefined {
  if (isRecord(raw) && typeof raw.name === 'string') {
    const d: Dep = { kind, name: raw.name };
    if (typeof raw.origin === 'string') d.origin = raw.origin;
    if (typeof raw.ref === 'string') d.ref = raw.ref;
    return d;
  }
  if (typeof raw !== 'string') return undefined;
  const [head = '', ref] = raw.split('#');
  const at = head.lastIndexOf('@');
  const d: Dep = { kind, name: at > 0 ? head.slice(0, at) : head };
  if (at > 0) d.origin = head.slice(at + 1);
  if (ref) d.ref = ref;
  return d;
}

function manifestDeps(m: LegacyManifest): Dep[] {
  const out: Dep[] = [];
  for (const [key, kind] of Object.entries(SECTIONS))
    for (const raw of (m as Record<string, unknown[] | undefined>)[key] ?? []) {
      const d = parseDep(raw, kind);
      if (d) out.push(d);
    }
  return out;
}

export function kindOf(legacy: string): Kind {
  return legacy === 'command' ? 'skill' : (legacy as Kind);
}

interface Origin {
  spec: LegacyOriginSpec;
  fromConfig: boolean;
}

function originMap(input: LegacyInput): Map<string, Origin> {
  const out = new Map<string, Origin>();
  for (const spec of input.config?.origins ?? [])
    out.set(spec.alias.toLowerCase(), { spec, fromConfig: true });
  for (const raw of input.manifest.origins ?? [])
    if (isRecord(raw) && typeof raw.alias === 'string')
      out.set(raw.alias.toLowerCase(), { spec: raw as LegacyOriginSpec, fromConfig: false });
  return out;
}

const GITHUB = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

/** The source key of an origin: `owner/repo`, `./dir`, or the alias. */
function keyOf(input: LegacyInput, spec: LegacyOriginSpec, taken: Set<string>): string {
  const gh = spec.url ? GITHUB.exec(spec.url) : null;
  const local = spec.type === 'local' && spec.path && input.scope === 'project';
  const rel = local ? relative(input.root, absolute(input, spec.path as string)) : undefined;
  let key = spec.alias;
  if (gh) key = `${gh[1]}/${gh[2]}`;
  else if (rel !== undefined && !rel.startsWith('..')) key = `./${rel || '.'}`;
  return taken.has(key.toLowerCase()) ? spec.alias : key;
}

function absolute(input: LegacyInput, path: string): string {
  return path.startsWith('/') ? path : `${input.root}/${path.replace(/^\.\//, '')}`;
}

/** The most common value, and the others. */
function mostCommon(values: Array<string | undefined>): { top?: string; others: string[] } {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  return { ...(sorted[0] ? { top: sorted[0][0] } : {}), others: sorted.slice(1).map(([v]) => v) };
}

/** A git origin's url, root, ref (the most common of its entries) and the sha of that ref. */
function gitFields(
  spec: LegacyOriginSpec,
  entries: LegacyLockEntry[],
  src: Source,
  lock: LockSource,
): void {
  const ref = mostCommon(entries.map((e) => e.ref)).top ?? spec.ref;
  const url = spec.url ?? entries.find((e) => e.url)?.url;
  if (url) src.url = lock.url = url;
  const root = spec.root ?? entries.find((e) => e.root)?.root;
  if (root) src.root = lock.root = root;
  if (ref) src.ref = lock.ref = ref;
  const sha = mostCommon(entries.filter((e) => e.ref === ref).map((e) => e.sha)).top;
  if (sha) lock.sha = sha;
}

function sourceOf(
  input: LegacyInput,
  key: string,
  origin: Origin,
  entries: LegacyLockEntry[],
): MigratedSource {
  const { spec } = origin;
  const src: Source = { name: key, type: spec.type };
  const lock: LockSource = {};
  if (spec.type === 'local' && spec.path) src.path = absolute(input, spec.path);
  else gitFields(spec, entries, src, lock);
  if (spec.layout) src.layout = lock.layout = spec.layout;
  if (spec.alias !== key && /^[a-z0-9][a-z0-9._-]*$/.test(spec.alias)) src.alias = spec.alias;
  return { source: src, lock, fromConfig: origin.fromConfig, entries: entries.length };
}

/** The origin of a lock entry: the declared spec, else one rebuilt from the entry's url. */
function originOf(origins: Map<string, Origin>, e: LegacyLockEntry): Origin | undefined {
  const known = origins.get(e.origin.toLowerCase());
  if (known) return known;
  if (!e.url) return undefined;
  const spec: LegacyOriginSpec = { alias: e.origin, type: 'git', url: e.url };
  if (e.root) spec.root = e.root;
  return { spec, fromConfig: false };
}

// ---------------------------------------------------------------------------
// MCP servers: registry and ad hoc ones move to `mcp:`
// ---------------------------------------------------------------------------

const MCP_KEYS = ['transport', 'command', 'args', 'env', 'cwd', 'url', 'headers'] as const;

/** An MCP config (inline palm.yaml entry or a rendered harness block) as a `mcp:` entry. */
function mcpEntryOf(raw: Record<string, unknown>): McpManifestEntry {
  const out: Record<string, unknown> = {};
  for (const k of MCP_KEYS) if (raw[k] !== undefined) out[k] = raw[k];
  const type = raw.type;
  if (!out.transport && (type === 'http' || type === 'sse' || type === 'stdio'))
    out.transport = type;
  if (out.transport === 'http' && out.url) delete out.transport;
  if (out.transport === 'stdio' && out.command) delete out.transport;
  return out as McpManifestEntry;
}

function inlineMcp(m: LegacyManifest): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const raw of m.mcp ?? [])
    if (isRecord(raw) && typeof raw.name === 'string' && MCP_KEYS.some((k) => raw[k] !== undefined))
      out.set(raw.name.toLowerCase(), raw);
  return out;
}

/** The server block palm rendered for a registry server (the merged value under its name). */
function renderedMcp(e: LegacyLockEntry): Record<string, unknown> | undefined {
  for (const m of e.merged ?? [])
    if (m.pointer.split('/').pop() === e.name && isRecord(m.value)) return m.value;
  return undefined;
}

function isHandMcp(e: LegacyLockEntry, origins: Map<string, Origin>): boolean {
  if (e.kind !== 'mcp') return false;
  if (e.origin === 'registry' || e.origin === 'adhoc') return true;
  return !origins.has(e.origin.toLowerCase()) && !e.url;
}

function collectMcp(input: LegacyInput, origins: Map<string, Origin>, m: Migration): void {
  const inline = inlineMcp(input.manifest);
  for (const e of input.lock?.entries ?? []) {
    if (!isHandMcp(e, origins)) continue;
    const raw = inline.get(e.name.toLowerCase()) ?? renderedMcp(e);
    if (raw) {
      m.mcp.push({ name: e.name, entry: mcpEntryOf(raw) });
      m.legacy.push({ entry: e, source: MANIFEST_SOURCE, kind: 'mcp' });
    } else
      m.warnings.push(
        `mcp ${e.name}: palm found no config for it; declare it again: palm install mcp ${e.name} --url <url>`,
      );
    inline.delete(e.name.toLowerCase());
  }
  for (const [, raw] of inline) m.mcp.push({ name: raw.name as string, entry: mcpEntryOf(raw) });
}

// ---------------------------------------------------------------------------
// Targets: the scope set, widened by --target leaks (then narrowed per entry)
// ---------------------------------------------------------------------------

const ORDER: readonly TargetId[] = ['claude', 'codex', 'copilot', 'cursor', 'gemini', 'opencode'];

function scopeTargets(
  input: LegacyInput,
  direct: LegacyLockEntry[],
  m: Migration,
): TargetId[] | undefined {
  const declared = input.manifest.targets ?? input.lock?.targets ?? input.config?.targets;
  if (!declared) return undefined;
  const leaks = direct.filter((e) => (e.targets ?? []).some((t) => !declared.includes(t)));
  if (!leaks.length) return declared;
  const all = new Set([...declared, ...leaks.flatMap((e) => e.targets ?? [])]);
  const widened = ORDER.filter((t) => all.has(t));
  for (const e of leaks) {
    const extra = (e.targets ?? []).filter((t) => !declared.includes(t));
    m.warnings.push(
      `${kindOf(e.kind)} ${e.name} was also installed for ${extra.join(', ')}; palm.yaml targets are now ${widened.join(', ')} and entries on fewer targets keep theirs with targets:`,
    );
  }
  return widened;
}

function narrowed(e: LegacyLockEntry, targets?: TargetId[]): TargetId[] | undefined {
  if (!targets || !e.targets?.length) return undefined;
  const own = ORDER.filter((t) => e.targets?.includes(t));
  return own.length === targets.length ? undefined : own;
}

// ---------------------------------------------------------------------------
// convertLegacy
// ---------------------------------------------------------------------------

function refOf(deps: Dep[], e: LegacyLockEntry): string | undefined {
  const d = deps.find(
    (x) => x.kind === kindOf(e.kind) && x.name.toLowerCase() === e.name.toLowerCase(),
  );
  return d?.ref ?? e.ref;
}

function pluginEntry(e: LegacyLockEntry, group: LegacyLockEntry[]): ManifestEntry {
  const via = `plugin:${e.name}`;
  const present = new Set(
    group.filter((x) => x.via === via).map((x) => `${kindOf(x.kind)}:${x.name}`.toLowerCase()),
  );
  const exclude = (e.deps ?? [])
    .map((d) => `${kindOf(d.kind)}:${d.name}`)
    .filter((k) => !present.has(k.toLowerCase()));
  return exclude.length ? { name: e.name, exclude } : e.name;
}

function entryOf(
  e: LegacyLockEntry,
  group: LegacyLockEntry[],
  targets?: TargetId[],
): ManifestEntry {
  const base = e.kind === 'plugin' ? pluginEntry(e, group) : e.name;
  const own = narrowed(e, targets);
  if (!own) return base;
  return typeof base === 'string' ? { name: base, targets: own } : { ...base, targets: own };
}

function groups(
  input: LegacyInput,
  origins: Map<string, Origin>,
  m: Migration,
): Map<string, LegacyLockEntry[]> {
  const out = new Map<string, LegacyLockEntry[]>();
  for (const e of input.lock?.entries ?? []) {
    if (isHandMcp(e, origins)) continue;
    if (e.origin === 'mine') {
      m.warnings.push(
        `${kindOf(e.kind)} ${e.name} came from your personal ~/.palm/mine directory; copy it into ./agent-kit/${kindOf(e.kind)}s/${e.name} and run: palm install ./agent-kit ${e.name}`,
      );
      continue;
    }
    const key = e.origin.toLowerCase();
    out.set(key, [...(out.get(key) ?? []), e]);
  }
  return out;
}

function pinWarnings(key: string, group: LegacyLockEntry[], deps: Dep[], m: Migration): void {
  const { top, others } = mostCommon(group.map((e) => refOf(deps, e)));
  if (!top || !others.length) return;
  for (const e of group)
    if (others.includes(refOf(deps, e) ?? ''))
      m.warnings.push(
        `${e.name} was pinned to ${refOf(deps, e)}; ${key} now tracks ${top}; pin the source or split it`,
      );
}

function addGroup(
  ctx: {
    input: LegacyInput;
    origins: Map<string, Origin>;
    deps: Dep[];
    taken: Set<string>;
    m: Migration;
  },
  group: LegacyLockEntry[],
): void {
  const { input, m } = ctx;
  const first = group[0] as LegacyLockEntry;
  const origin = originOf(ctx.origins, first);
  if (!origin) {
    m.warnings.push(
      `the 0.1 alias ${first.origin} has no url in palm.lock.yaml or ~/.palm/config.yaml; declare its repository again: palm install <owner/repo> ${first.name}`,
    );
    return;
  }
  const key = keyOf(input, origin.spec, ctx.taken);
  ctx.taken.add(key.toLowerCase());
  const withRefs = group.map((e) => ({
    ...e,
    ...(refOf(ctx.deps, e) ? { ref: refOf(ctx.deps, e) } : {}),
  }));
  m.sources.push(sourceOf(input, key, origin, withRefs));
  pinWarnings(key, group, ctx.deps, m);
  for (const e of group) {
    const via = e.via?.startsWith('plugin:') ? e.via : undefined;
    m.legacy.push({ entry: e, source: key, kind: kindOf(e.kind), ...(via ? { via } : {}) });
    if (!via)
      m.entries.push({ source: key, kind: kindOf(e.kind), entry: entryOf(e, group, m.targets) });
  }
}

/** The whole conversion: sources, entries, hand-declared servers, targets and warnings. */
export function convertLegacy(input: LegacyInput): Migration {
  const m: Migration = { sources: [], entries: [], mcp: [], legacy: [], warnings: [] };
  const origins = originMap(input);
  const deps = manifestDeps(input.manifest);
  collectMcp(input, origins, m);
  const byOrigin = groups(input, origins, m);
  const direct = [...byOrigin.values()].flat().filter((e) => !e.via?.startsWith('plugin:'));
  const targets = scopeTargets(input, direct, m);
  if (targets) m.targets = targets;
  const ctx = { input, origins, deps, taken: new Set<string>(), m };
  for (const group of byOrigin.values()) addGroup(ctx, group);
  return m;
}
