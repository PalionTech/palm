import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertAliasFormat,
  expandTilde,
  Origin,
  OriginAliasError,
  trimSlashes,
} from '../domain/origin.js';
import { errnoCode } from '../lib/fs.js';
import { isRecord, withoutUndefined } from '../lib/object.js';
import { parseYaml, readYamlFile, writeYamlFile } from '../lib/yaml.js';
import { messageOf, PalmError } from './errors.js';
import { deriveAlias, parseOriginInput, validateOriginUrl } from './origin-input.js';
import { configPath, projectManifest } from './paths.js';
import {
  type LayoutDescriptor,
  type Logger,
  type OriginSpec,
  type PalmConfig,
  type PalmPaths,
  TARGET_IDS,
  type TargetId,
} from './types.js';

// ---------------------------------------------------------------------------
// Stored origin entries (config.yaml `origins:` and palm.yaml `origins:`)
// ---------------------------------------------------------------------------

/** A stored origin: its known fields in a fixed order, undefined ones left out. */
export function serializeOrigin(spec: OriginSpec): OriginSpec {
  const { alias, type, url, path, ref, root, layout, description } = spec;
  return withoutUndefined({ alias, type, url, path, ref, root, layout, description });
}

/** `{ alias: x, type: git, url: … }`: a stored origin as one YAML flow mapping (for hints). */
function flowMapping(spec: OriginSpec): string {
  const parts = Object.entries(serializeOrigin(spec))
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => `${k}: ${String(v)}`);
  return `{ ${parts.join(', ')} }`;
}

/** A string entry never has an alias; an unusable URL or path is reported first. */
function stringEntryError(raw: string, baseDir: string, where: string): OriginAliasError {
  const parsed = parseOriginInput(raw, { cwd: baseDir });
  return new OriginAliasError(
    'E_PARSE',
    `${where}: origin ${raw} has no alias`,
    `write it as a mapping and add \`alias: ${parsed.alias}\`, e.g. \`- ${flowMapping(parsed)}\` (palm derives that name with \`palm install origin\`)`,
  );
}

/** The url (git, validated) or absolute path (local, relative to `baseDir`) of a stored entry. */
function storedLocation(
  raw: Record<string, unknown>,
  spec: OriginSpec,
  baseDir: string,
  where: string,
): Pick<OriginSpec, 'url' | 'path'> {
  if (spec.type === 'git') {
    if (typeof raw.url !== 'string' || !raw.url)
      throw new PalmError('E_PARSE', `${where}: git origin "${spec.alias}" has no url`);
    validateOriginUrl(raw.url, `${where}: origin "${spec.alias || raw.url}"`);
    return { url: raw.url };
  }
  if (typeof raw.path !== 'string' || !raw.path)
    throw new PalmError('E_PARSE', `${where}: local origin "${spec.alias}" has no path`);
  return { path: resolve(baseDir, expandTilde(raw.path)) };
}

function storedOptionals(raw: Record<string, unknown>): Partial<OriginSpec> {
  const out: Partial<OriginSpec> = {};
  if (typeof raw.ref === 'string' && raw.ref) out.ref = raw.ref;
  if (typeof raw.root === 'string' && raw.root) out.root = trimSlashes(raw.root);
  if (isRecord(raw.layout)) out.layout = raw.layout as LayoutDescriptor;
  if (typeof raw.description === 'string') out.description = raw.description;
  return out;
}

/**
 * Turn a stored origin entry into a full OriginSpec. Relative local paths resolve against `baseDir`.
 * The alias is mandatory and never derived here: a string entry or a mapping without `alias` is
 * E_PARSE (an OriginAliasError, which callers never skip).
 */
export function normalizeStoredOrigin(raw: unknown, baseDir: string, where: string): OriginSpec {
  if (typeof raw === 'string') throw stringEntryError(raw, baseDir, where);
  if (!isRecord(raw))
    throw new PalmError('E_PARSE', `${where}: invalid origin entry ${JSON.stringify(raw)}`);
  const local =
    raw.type === 'local' || (raw.type === undefined && typeof raw.path === 'string' && !raw.url);
  const alias =
    typeof raw.alias === 'string' || typeof raw.alias === 'number' ? String(raw.alias) : '';
  const base: OriginSpec = { alias, type: local ? 'local' : 'git' };
  const spec: OriginSpec = {
    ...base,
    ...storedLocation(raw, base, baseDir, where),
    ...storedOptionals(raw),
  };
  if (!alias.trim()) {
    throw new OriginAliasError(
      'E_PARSE',
      `${where}: origin ${String(local ? raw.path : raw.url)} has no alias`,
      `add \`alias: ${deriveAlias(spec, [])}\` (palm derives that name with \`palm install origin\`)`,
    );
  }
  assertAliasFormat(alias, 'E_PARSE', where);
  return spec;
}

/** No two origins of one file may share an alias. */
function assertUniqueAliases(origins: readonly OriginSpec[], where: string): void {
  const seen = new Map<string, OriginSpec>();
  for (const o of origins) {
    const prev = seen.get(o.alias);
    if (prev) {
      throw new OriginAliasError(
        'E_PARSE',
        `${where}: origin alias "${o.alias}" is used twice (${new Origin(prev).describe()} and ${new Origin(o).describe()})`,
        'Give each origin its own alias.',
      );
    }
    seen.set(o.alias, o);
  }
}

/** The lowercased alias of a stored entry, or undefined when it does not parse. */
function storedAlias(raw: unknown, baseDir: string, where: string): string | undefined {
  try {
    return normalizeStoredOrigin(raw, baseDir, where).alias.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Stored entries with the one of `spec`'s alias replaced in place (or `spec` appended). Entries
 * that do not parse are kept as they are.
 */
export function upsertStoredOrigin(
  entries: ReadonlyArray<string | OriginSpec>,
  spec: OriginSpec,
  baseDir: string,
  where: string,
): Array<string | OriginSpec> {
  const key = spec.alias.toLowerCase();
  const i = entries.findIndex((o) => storedAlias(o, baseDir, where) === key);
  const stored = serializeOrigin(spec);
  return i >= 0 ? entries.with(i, stored) : [...entries, stored];
}

/** Stored entries without those aliased `alias` (entries that do not parse are kept). */
export function removeStoredOrigin(
  entries: ReadonlyArray<string | OriginSpec>,
  alias: string,
  baseDir: string,
  where: string,
): Array<string | OriginSpec> {
  const key = alias.toLowerCase();
  return entries.filter((o) => storedAlias(o, baseDir, where) !== key);
}

/**
 * Origins declared in the project's palm.yaml (read synchronously; the file is small). A refused
 * URL or missing path skips the entry with a warning; a missing or invalid alias is a hard error.
 */
export function loadProjectOrigins(paths: PalmPaths, log: Logger): OriginSpec[] {
  const file = projectManifest(paths);
  if (!existsSync(file)) return [];
  let data: unknown;
  try {
    data = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    log.warn(`Ignoring origins in ${file}: ${messageOf(e)}`);
    return [];
  }
  if (!isRecord(data) || !Array.isArray(data.origins)) return [];
  const out: OriginSpec[] = [];
  for (const raw of data.origins) {
    try {
      out.push(normalizeStoredOrigin(raw, paths.projectRoot, file));
    } catch (e) {
      if (e instanceof OriginAliasError) throw e;
      log.warn(messageOf(e));
    }
  }
  assertUniqueAliases(out, file);
  return out;
}

// ---------------------------------------------------------------------------
// config.yaml
// ---------------------------------------------------------------------------

function validTargets(v: unknown): TargetId[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter(
    (t): t is TargetId => typeof t === 'string' && (TARGET_IDS as readonly string[]).includes(t),
  );
  return out.length ? out : undefined;
}

/** A user YAML file: undefined when missing or empty; E_IO when unreadable, E_PARSE when invalid. */
async function readUserYaml(file: string): Promise<unknown> {
  try {
    return await readYamlFile(file);
  } catch (e) {
    if (errnoCode(e)) throw new PalmError('E_IO', `Cannot read ${file}: ${messageOf(e)}`);
    throw new PalmError('E_PARSE', messageOf(e));
  }
}

/** `<palmHome>/config.yaml`; `{ origins: [] }` when missing. Unknown keys are kept. */
export async function loadConfig(paths: PalmPaths): Promise<PalmConfig> {
  const file = configPath(paths);
  const data = await readUserYaml(file);
  if (data === undefined || data === null) return { origins: [] };
  if (!isRecord(data)) throw new PalmError('E_PARSE', `${file} must be a YAML mapping`);
  const cfg = { ...data, origins: [] } as PalmConfig;
  const targets = validTargets(data.targets);
  if (targets) cfg.targets = targets;
  else delete cfg.targets;
  if (Array.isArray(data.origins)) {
    cfg.origins = data.origins.map((o) => normalizeStoredOrigin(o, paths.palmHome, file));
    assertUniqueAliases(cfg.origins, file);
  }
  return cfg;
}

/** Writes config.yaml (0600: user-private), keeping the comments and order of the current file. */
export async function saveConfig(paths: PalmPaths, cfg: PalmConfig): Promise<void> {
  const { targets, origins, ...rest } = cfg;
  const out = withoutUndefined({ targets, origins: origins.map(serializeOrigin), ...rest });
  await writeYamlFile(configPath(paths), out, { flowKeys: ['targets'], mode: 0o600 });
}
