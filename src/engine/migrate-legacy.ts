/**
 * The 0.1 formats to the 0.2 model (DESIGN §6 "Migrate", PLAN.md 8), as data: every alias an
 * entry uses becomes a source keyed by `owner/repo` (GitHub) or `./dir` (in the project; a local
 * origin's `path` and `root` join into that one directory), else by the alias; `name@alias#ref`
 * becomes an entry under its source; a plugin keeps its uninstalled members as `exclude:`; a
 * command becomes a skill; registry and ad hoc MCP servers move to `mcp:`; `--target` leaks
 * become per-entry `targets:`. No IO here.
 */
import { relative, resolve } from 'node:path';
import type {
  InstallFailure,
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
import { toPosix } from '../lib/fs.js';
import { isValidAlias, slugify } from '../lib/names.js';
import { isRecord } from '../lib/object.js';
import { replacePlaceholders } from '../lib/placeholders.js';
import { MANIFEST_SOURCE } from './sources.js';

export interface LegacyInput {
  manifest: LegacyManifest;
  lock?: LegacyLockfile;
  config?: LegacyConfig;
  scope: Scope;
  /** The directory local paths in palm.yaml are relative to (project root, or $PALM_HOME). */
  root: string;
  /** palm's home as the person knows it (`~/.palm`), for the advice on `~/.palm/mine` entries. */
  palmHome?: string;
}

export interface MigratedSource {
  source: Source;
  lock: LockSource;
  fromConfig: boolean;
  entries: number;
  /** The 0.1 origin it came from (T6: hints name it while palm.yaml is still 0.1). */
  origin: LegacyOriginSpec;
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
  /** S11: 0.1 entries the migration could not place, one each (the migration exits 1). */
  dropped: InstallFailure[];
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
  const rel = local ? toPosix(relative(input.root, localDir(input, spec))) : undefined;
  let key = spec.alias;
  if (gh) key = `${gh[1]}/${gh[2]}`;
  else if (rel !== undefined && !rel.startsWith('..')) key = `./${rel || '.'}`;
  return taken.has(key.toLowerCase()) ? spec.alias : key;
}

/** The directory a local origin names: its `path` (relative to `root`) joined with its `root`. */
function localDir(input: LegacyInput, spec: LegacyOriginSpec): string {
  return resolve(input.root, spec.path ?? '.', spec.root ?? '');
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

/** The source of `entries`; a split-off pin (T4) keeps no alias, which stays with the main one. */
function sourceOf(
  input: LegacyInput,
  key: string,
  origin: Origin,
  part: { entries: LegacyLockEntry[]; pinned: boolean },
): MigratedSource {
  const { spec } = origin;
  const src: Source = { name: key, type: spec.type };
  const lock: LockSource = {};
  if (spec.type === 'local' && spec.path) src.path = localDir(input, spec);
  else gitFields(spec, part.entries, src, lock);
  if (spec.layout) src.layout = lock.layout = spec.layout;
  if (!part.pinned && spec.alias !== key && isValidAlias(spec.alias)) src.alias = spec.alias;
  const entries = part.entries.length;
  return { source: src, lock, fromConfig: origin.fromConfig, entries, origin: spec };
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

/**
 * How close a harness file's server block is to the `mcp:` form, lowest first: Claude's
 * `.mcp.json` and `~/.claude.json`, Cursor, VS Code, then Gemini (`httpUrl`). Codex TOML and
 * OpenCode never qualify (`env_vars`, `bearer_token_env_var`; `command` arrays, `environment`).
 */
const FORM_ORDER: readonly RegExp[] = [
  /(^|\/)\.(mcp|claude)\.json$/,
  /\.cursor\/mcp\.json$/,
  /\.vscode\/mcp\.json$/,
  /settings\.json$/,
];

function formRank(file: string): number {
  const i = FORM_ORDER.findIndex((re) => re.test(file));
  return i < 0 ? Number.POSITIVE_INFINITY : i;
}

/** `${env:VAR}` (Cursor, VS Code) as the `${VAR}` palm.yaml uses, in every string of `value`. */
function plainReferences(value: unknown): unknown {
  if (typeof value === 'string')
    return replacePlaceholders(value, (p) =>
      p.style === 'env-colon' ? `\${${p.name}}` : undefined,
    );
  if (Array.isArray(value)) return value.map(plainReferences);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainReferences(v)]));
}

/** The server block palm rendered for a registry server, from the harness file closest to `mcp:`. */
function renderedMcp(e: LegacyLockEntry): Record<string, unknown> | undefined {
  const blocks = (e.merged ?? [])
    .filter((m) => m.pointer.split('/').pop() === e.name && isRecord(m.value))
    .filter((m) => formRank(m.file) !== Number.POSITIVE_INFINITY)
    .sort((a, b) => formRank(a.file) - formRank(b.file));
  const first = blocks[0];
  return first ? (plainReferences(first.value) as Record<string, unknown>) : undefined;
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
      m.dropped.push({
        kind: 'mcp',
        name: e.name,
        source: MANIFEST_SOURCE,
        code: 'E_SOURCE',
        message: `mcp ${e.name}: palm found no config for it; not migrated`,
        hint: `palm install mcp ${e.name} --url <url>`,
      });
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

/**
 * `~/.palm/mine` is gone: the entry's file moves into an in-repo source, the project's
 * `./agent-kit` or, under -g, `~/.palm/kit` (DESIGN §2), and one install declares it.
 */
function mineAdvice(input: LegacyInput, e: LegacyLockEntry): string {
  const home = input.palmHome ?? '~/.palm';
  const what = `${kindOf(e.kind)} ${e.name} came from ${home}/mine, which palm 0.2 no longer reads`;
  const from = `${home}/mine/${e.path}`;
  if (input.scope === 'global')
    return `${what}; copy ${from} to ${home}/kit/${e.path}, then run: palm install ${home}/kit ${e.name} -g`;
  return `${what}; copy ${from} to ./agent-kit/${e.path}, then run: palm install ./agent-kit ${e.name}`;
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
      m.warnings.push(mineAdvice(input, e));
      continue;
    }
    const key = e.origin.toLowerCase();
    out.set(key, [...(out.get(key) ?? []), e]);
  }
  return out;
}

interface GroupContext {
  input: LegacyInput;
  origins: Map<string, Origin>;
  deps: Dep[];
  taken: Set<string>;
  m: Migration;
}

/** One ref of an origin and the entries 0.1 installed at it (a plugin's members at the plugin's). */
interface RefPart {
  ref?: string;
  entries: LegacyLockEntry[];
}

/** The ref an entry follows: its own, or its plugin's for a member. */
function followedRef(e: LegacyLockEntry, group: LegacyLockEntry[]): string | undefined {
  if (!e.via?.startsWith('plugin:')) return e.ref;
  const plugin = group.find((x) => x.kind === 'plugin' && `plugin:${x.name}` === e.via);
  return plugin ? plugin.ref : e.ref;
}

/**
 * T4: the entries of a git origin by the ref they were installed at, the most common ref first.
 * A local origin, or one ref for all, is one part.
 */
function refParts(spec: LegacyOriginSpec, group: LegacyLockEntry[]): RefPart[] {
  const { top, others } = mostCommon(group.map((e) => followedRef(e, group)));
  if (spec.type === 'local' || !others.length)
    return [{ ...(top ? { ref: top } : {}), entries: group }];
  const at = (ref: string | undefined) => group.filter((e) => followedRef(e, group) === ref);
  const main = group.filter((e) => !others.includes(followedRef(e, group) ?? ''));
  return [
    { ...(top ? { ref: top } : {}), entries: main },
    ...others.map((ref) => ({ ref, entries: at(ref) })),
  ];
}

/** The repository's own name, for a split-off source's key (`kitcn` of `get-convex/kitcn`). */
function baseName(spec: LegacyOriginSpec, key: string): string {
  const alias = spec.alias.toLowerCase();
  if (isValidAlias(alias)) return alias;
  const repo = slugify(key.split('/').pop() ?? key);
  return repo || 'source';
}

/**
 * T4: the key of a source split off for another ref, as `--as` names one: `<name>-<short sha>`
 * (the ref itself when 0.1 recorded no commit), unique in palm.yaml.
 */
function pinnedKey(ctx: GroupContext, spec: LegacyOriginSpec, part: RefPart, key: string): string {
  const sha = mostCommon(part.entries.map((e) => e.sha)).top;
  const tail = sha ? sha.slice(0, 7) : slugify(part.ref ?? '') || 'pinned';
  const base = `${baseName(spec, key)}-${tail}`;
  let name = base;
  for (let n = 2; ctx.taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
  ctx.taken.add(name.toLowerCase());
  return name;
}

/** T4: what the split says, once per split-off source. */
function pinnedLine(part: RefPart, name: string, main: { key: string; ref?: string }): string {
  const direct = part.entries.filter((e) => !e.via?.startsWith('plugin:'));
  const names = direct.map((e) => `${kindOf(e.kind)} ${e.name}`).join(', ');
  const verb = direct.length === 1 ? 'was' : 'were';
  const them = direct.length === 1 ? 'it' : 'them';
  const tracks = main.ref ? `${main.key} tracks ${main.ref}` : `${main.key} tracks its default ref`;
  return `${names} ${verb} pinned to ${part.ref}; palm.yaml declares source ${name} for ${them} at that ref (${tracks}), as --as ${name} would`;
}

/** S11: every entry of an alias palm cannot find again, as a failure naming it. */
function unplaced(m: Migration, group: LegacyLockEntry[]): void {
  const first = group[0] as LegacyLockEntry;
  for (const e of group)
    m.dropped.push({
      kind: kindOf(e.kind),
      name: e.name,
      source: e.origin,
      code: 'E_SOURCE',
      message: `${kindOf(e.kind)} ${e.name}: the 0.1 alias ${first.origin} has no url in palm.lock.yaml or ~/.palm/config.yaml; not migrated`,
      hint: `palm install <owner/repo> ${e.name}`,
    });
}

/** The entries of one part under `key`: every one in the lock record, the direct ones in palm.yaml. */
function addEntries(m: Migration, key: string, part: RefPart, group: LegacyLockEntry[]): void {
  for (const e of part.entries) {
    const via = e.via?.startsWith('plugin:') ? e.via : undefined;
    m.legacy.push({ entry: e, source: key, kind: kindOf(e.kind), ...(via ? { via } : {}) });
    if (!via)
      m.entries.push({ source: key, kind: kindOf(e.kind), entry: entryOf(e, group, m.targets) });
  }
}

function addGroup(ctx: GroupContext, group: LegacyLockEntry[]): void {
  const { input, m } = ctx;
  const origin = originOf(ctx.origins, group[0] as LegacyLockEntry);
  if (!origin) {
    unplaced(m, group);
    return;
  }
  const key = keyOf(input, origin.spec, ctx.taken);
  ctx.taken.add(key.toLowerCase());
  const withRefs = group.map((e) => ({
    ...e,
    ...(refOf(ctx.deps, e) ? { ref: refOf(ctx.deps, e) } : {}),
  }));
  const [main, ...pins] = refParts(origin.spec, withRefs) as [RefPart, ...RefPart[]];
  m.sources.push(sourceOf(input, key, origin, { entries: main.entries, pinned: false }));
  addEntries(m, key, main, withRefs);
  for (const part of pins) {
    const name = pinnedKey(ctx, origin.spec, part, key);
    m.sources.push(sourceOf(input, name, origin, { entries: part.entries, pinned: true }));
    m.warnings.push(pinnedLine(part, name, { key, ...(main.ref ? { ref: main.ref } : {}) }));
    addEntries(m, name, part, withRefs);
  }
}

/**
 * R5': the aliases in the order the 0.1 palm.yaml names them (its `origins:` list and its
 * `name@alias` entries, as the file has them), so the 0.2 sources keep that order and the
 * comments above them stay where they were.
 */
function mentionOrder(m: LegacyManifest): string[] {
  const out: string[] = [];
  for (const [key, list] of Object.entries(m as Record<string, unknown>))
    for (const alias of Array.isArray(list) ? aliasesIn(key, list) : []) {
      const a = alias?.toLowerCase();
      if (a && !out.includes(a)) out.push(a);
    }
  return out;
}

/** The aliases one top-level list of the 0.1 palm.yaml names, in its order. */
function aliasesIn(key: string, list: unknown[]): Array<string | undefined> {
  if (key === 'origins') return list.map(originAlias);
  return SECTIONS[key] ? list.map((raw) => parseDep(raw, 'skill')?.origin) : [];
}

/** The alias of an `origins:` item (a spec, or the alias alone). */
function originAlias(o: unknown): string | undefined {
  if (typeof o === 'string') return o;
  return isRecord(o) && typeof o.alias === 'string' ? o.alias : undefined;
}

/** The groups in the 0.1 palm.yaml's order; aliases it never names follow in lock order. */
function ordered(input: LegacyInput, byOrigin: Map<string, LegacyLockEntry[]>) {
  const order = mentionOrder(input.manifest);
  const rank = (alias: string) => {
    const i = order.indexOf(alias);
    return i < 0 ? order.length : i;
  };
  return [...byOrigin].sort((a, b) => rank(a[0]) - rank(b[0])).map(([, group]) => group);
}

/** The whole conversion: sources, entries, hand-declared servers, targets and warnings. */
export function convertLegacy(input: LegacyInput): Migration {
  const m: Migration = { sources: [], entries: [], mcp: [], legacy: [], warnings: [], dropped: [] };
  const origins = originMap(input);
  const deps = manifestDeps(input.manifest);
  collectMcp(input, origins, m);
  const byOrigin = groups(input, origins, m);
  const direct = [...byOrigin.values()].flat().filter((e) => !e.via?.startsWith('plugin:'));
  const targets = scopeTargets(input, direct, m);
  if (targets) m.targets = targets;
  const ctx = { input, origins, deps, taken: new Set<string>(), m };
  for (const group of ordered(input, byOrigin)) addGroup(ctx, group);
  return m;
}
