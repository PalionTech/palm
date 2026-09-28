/**
 * Registering and unregistering origins: config.yaml (the user's origins) or the project's
 * palm.yaml `origins:`, kept in step with `ctx.origins`, and the local `mine` origin that
 * `palm create` writes to. Reading origins is `ctx.origins` (domain/origin-set); parsing user
 * input is core/origin-input; the files themselves are core/config-file.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { Manifest } from '../domain/manifest.js';
import { assertAliasFormat, Origin } from '../domain/origin.js';
import type { OriginSet } from '../domain/origin-set.js';
import { isWithin, toPosix } from '../lib/fs.js';
import { removeStoredOrigin, saveConfig, upsertStoredOrigin } from './config-file.js';
import { refreshOrigins } from './context.js';
import { PalmError } from './errors.js';
import { runGit } from './git-exec.js';
import { deriveAlias } from './origin-input.js';
import { projectManifest } from './paths.js';
import type { OriginSpec, PalmContext, PalmPaths, Scope } from './types.js';

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
  const file = projectManifest(paths);
  const m = await Manifest.load(file);
  const before = m.origins ?? [];
  const after = edit(before, file);
  if (after.length === before.length && after.every((o, i) => o === before[i])) return false;
  await Manifest.of({ ...m.toJSON(), origins: after }).save(file);
  return true;
}

/**
 * A project's local origins must live inside it: every install refuses others (engine scope
 * guard), so `palm install origin <path> --project` refuses them before anything is saved.
 */
export function assertProjectOrigin(spec: OriginSpec, projectRoot: string): void {
  if (spec.type !== 'local' || isWithin(resolve(projectRoot, spec.path ?? ''), projectRoot)) return;
  throw new PalmError(
    'E_ORIGIN',
    `origin "${spec.alias}" points outside the project: ${spec.path ?? ''}`,
    `a project's local origins must live inside it; use it just for yourself (without --project): palm install origin ${spec.path ?? '<path>'} --alias ${spec.alias}`,
  );
}

/** palm.yaml keeps a local origin's path relative to the project, so a clone finds it too. */
function projectStored(spec: OriginSpec, projectRoot: string): OriginSpec {
  if (spec.type !== 'local' || !spec.path) return spec;
  const rel = toPosix(relative(projectRoot, resolve(projectRoot, spec.path)));
  return { ...spec, path: rel || '.' };
}

/**
 * Registers `spec` in config.yaml (global) or the project's palm.yaml (project). A derived alias
 * that another origin uses is replaced by a free one; an explicit one is E_CONFLICT. A local
 * project origin must live inside the project and is stored with a project-relative path.
 */
export async function addOrigin(
  ctx: PalmContext,
  spec: OriginSpec,
  opts: { scope?: Scope } = {},
): Promise<OriginSpec> {
  assertAliasFormat(spec.alias, 'E_USAGE');
  const layer = (opts.scope ?? 'global') === 'global' ? 'user' : 'project';
  if (layer === 'project') assertProjectOrigin(spec, ctx.paths.projectRoot);
  const next = withFreeAlias(ctx.origins, { ...spec });
  const origins = ctx.origins.add(next, layer);
  if (layer === 'user') {
    const config = { ...ctx.config, origins: origins.userSpecs() };
    await saveConfig(ctx.paths, config);
    refreshOrigins(ctx, { config });
  } else {
    const { projectRoot } = ctx.paths;
    await editProjectOrigins(ctx.paths, (entries, file) =>
      upsertStoredOrigin(entries, projectStored(next, projectRoot), projectRoot, file),
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
    existsSync(projectManifest(ctx.paths)) &&
    (await editProjectOrigins(ctx.paths, (entries, file) =>
      removeStoredOrigin(entries, alias, ctx.paths.projectRoot, file),
    ));
  refreshOrigins(ctx, { config, project: fromProject ? 'reload' : undefined });
  if (!fromConfig && !fromProject)
    throw new PalmError(
      'E_NOT_FOUND',
      `No origin with alias "${alias}"`,
      'See the registered origins: `palm get origins`.',
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
      await runGit(['init', '-q', '--', dir]);
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
