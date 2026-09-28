/** facade: prefer src/domain + core/config-file */
//
// The origin registry as the rest of palm has used it since 0.0: the same names as before the
// split, now implemented over `Origin`/`OriginSet` (src/domain), core/config-file (config.yaml,
// stored origin entries) and core/origin-input (parsing user input). New code should use
// `ctx.origins` and those modules directly; addOrigin/removeOrigin/ensureMineOrigin stay here.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { assertAliasFormat, Origin } from '../domain/origin.js';
import type { OriginSet } from '../domain/origin-set.js';
import { removeStoredOrigin, saveConfig, upsertStoredOrigin } from './config-file.js';
import { refreshOrigins } from './context.js';
import { PalmError } from './errors.js';
import { loadManifest, saveManifest } from './manifest.js';
import { deriveAlias } from './origin-input.js';
import { manifestPath } from './paths.js';
import type { OriginSpec, PalmContext, PalmPaths, Scope } from './types.js';

export { loadConfig, saveConfig } from './config-file.js';
export {
  deriveAlias,
  type ParseOriginOptions,
  parseOriginInput,
  validateOriginUrl,
} from './origin-input.js';

/** Cache directory name of an origin (Origin.id). */
export function originId(spec: OriginSpec): string {
  return new Origin(spec).id;
}

/** Origins declared in the project manifest (ctx.origins' project layer). */
export function projectOrigins(ctx: PalmContext): OriginSpec[] {
  return ctx.origins.projectSpecs();
}

/** Every effective origin (config + project manifest; the project wins an alias clash). */
export function allOrigins(ctx: PalmContext): OriginSpec[] {
  return ctx.origins.specs();
}

export function findOrigin(ctx: PalmContext, alias: string): OriginSpec | undefined {
  return ctx.origins.byAlias(alias)?.spec;
}

/** Origin.matches. */
export function matchOrigin(spec: OriginSpec, query: string): boolean {
  return new Origin(spec).matches(query);
}

/** OriginSet.resolveQuery: throws E_NOT_FOUND (listing the aliases) or E_AMBIGUOUS. */
export function resolveOriginQuery(ctx: PalmContext, query: string): OriginSpec {
  return ctx.origins.resolveQuery(query).spec;
}

/** `spec` renamed to a free derived alias when its derived alias is taken by another origin. */
function withFreeAlias(origins: OriginSet, spec: OriginSpec): OriginSpec {
  const clash = origins.byAlias(spec.alias);
  if (!clash || clash.id === new Origin(spec).id || spec.alias !== deriveAlias(spec, []))
    return spec;
  return { ...spec, alias: deriveAlias(spec, origins.specs()) };
}

async function editProjectOrigins(
  paths: PalmPaths,
  edit: (entries: Array<string | OriginSpec>, file: string) => Array<string | OriginSpec>,
): Promise<boolean> {
  const file = manifestPath(paths, 'project');
  const m = await loadManifest(file);
  const before = m.origins ?? [];
  const after = edit(before, file);
  if (after.length === before.length && after.every((o, i) => o === before[i])) return false;
  await saveManifest(file, { ...m, origins: after });
  return true;
}

/**
 * Registers `spec` in config.yaml (global) or the project's palm.yaml (project). A derived alias
 * that another origin uses is replaced by a free one; an explicit one is E_CONFLICT.
 */
export async function addOrigin(
  ctx: PalmContext,
  spec: OriginSpec,
  opts: { scope?: Scope } = {},
): Promise<OriginSpec> {
  assertAliasFormat(spec.alias, 'E_USAGE');
  const next = withFreeAlias(ctx.origins, { ...spec });
  const layer = (opts.scope ?? 'global') === 'global' ? 'user' : 'project';
  const origins = ctx.origins.add(next, layer);
  if (layer === 'user') {
    const config = { ...ctx.config, origins: origins.userSpecs() };
    await saveConfig(ctx.paths, config);
    refreshOrigins(ctx, { config });
  } else {
    const { projectRoot } = ctx.paths;
    await editProjectOrigins(ctx.paths, (entries, file) =>
      upsertStoredOrigin(entries, next, projectRoot, file),
    );
    refreshOrigins(ctx, { project: origins.projectSpecs() });
  }
  return next;
}

/** Unregisters `alias` from config.yaml and the project's palm.yaml; E_NOT_FOUND when in neither. */
export async function removeOrigin(ctx: PalmContext, alias: string): Promise<void> {
  const lower = alias.toLowerCase();
  const kept = ctx.config.origins.filter((o) => o.alias.toLowerCase() !== lower);
  const fromConfig = kept.length !== ctx.config.origins.length;
  const config = fromConfig ? { ...ctx.config, origins: kept } : undefined;
  if (config) await saveConfig(ctx.paths, config);
  const fromProject =
    existsSync(manifestPath(ctx.paths, 'project')) &&
    (await editProjectOrigins(ctx.paths, (entries, file) =>
      removeStoredOrigin(entries, alias, ctx.paths.projectRoot, file),
    ));
  refreshOrigins(ctx, { config, project: fromProject ? 'reload' : undefined });
  if (!fromConfig && !fromProject)
    throw new PalmError(
      'E_NOT_FOUND',
      `No origin with alias "${alias}"`,
      'See `palm origin list`.',
    );
}

const MINE_README = `# mine

Your own palm resources. \`palm create\` writes here; this directory is registered
as the local origin \`mine\`, so everything in it can be installed with
\`palm install <kind> <name>@mine\`.

- skills/<name>/SKILL.md
- agents/<name>.md
- instructions/<name>.md
- commands/<name>.md
`;

/** Creates `<palmHome>/mine` (+ git init) and registers it as the user origin `mine` once. */
export async function ensureMineOrigin(ctx: PalmContext): Promise<OriginSpec> {
  const dir = join(ctx.paths.palmHome, 'mine');
  for (const sub of ['skills', 'agents', 'instructions', 'commands']) {
    await mkdir(join(dir, sub), { recursive: true });
  }
  const readme = join(dir, 'README.md');
  if (!existsSync(readme)) await writeFile(readme, MINE_README, 'utf8');
  if (!existsSync(join(dir, '.git'))) {
    try {
      await execa('git', ['init', '-q', dir], { env: { GIT_TERMINAL_PROMPT: '0' } });
    } catch {
      ctx.log.debug('git init of the mine origin failed; continuing without version control');
    }
  }
  const existing = ctx.config.origins.find((o) => o.alias === 'mine');
  if (existing) return existing;
  const spec: OriginSpec = {
    alias: 'mine',
    type: 'local',
    path: dir,
    description: 'Your own resources (palm create)',
  };
  const config = { ...ctx.config, origins: [...ctx.config.origins, spec] };
  await saveConfig(ctx.paths, config);
  refreshOrigins(ctx, { config });
  return spec;
}
