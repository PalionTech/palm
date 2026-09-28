/** `palm get targets` and `palm describe target <id>`. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pc from 'picocolors';
import { isPalmError, messageOf } from '../core/errors.js';
import {
  type DeployResult,
  type Entity,
  KINDS,
  type Kind,
  type PalmContext,
  type Scope,
  TARGET_IDS,
  type Target,
  type TargetId,
} from '../core/types.js';
import { ScopePaths } from '../domain/scope-paths.js';
import type { Output } from '../ui/output.js';
import { usage } from './grammar.js';
import { displayPath, parseTargetList, scopeRootOf } from './shared.js';

/** Where the active targets of a scope come from (the order resolveTargets applies). */
type TargetSource = 'flag' | 'palm.yaml' | 'config.yaml' | 'detected';

const SOURCE_TEXT: Record<TargetSource, string> = {
  flag: 'targets from --target',
  'palm.yaml': 'targets from palm.yaml',
  'config.yaml': 'targets from the global config',
  detected: 'targets detected',
};

async function targetSource(
  ctx: PalmContext,
  scope: Scope,
  flag: TargetId[] | undefined,
): Promise<TargetSource> {
  if (flag?.length) return 'flag';
  if (scope === 'project') {
    const { Manifest } = await import('../domain/manifest.js');
    const file = ScopePaths.of(ctx, 'project').manifestFile;
    const m = await Manifest.load(file).catch(() => undefined);
    if (m?.targets?.length) return 'palm.yaml';
  }
  return ctx.config.targets?.length ? 'config.yaml' : 'detected';
}

interface TargetRow {
  id: TargetId;
  name: string;
  active: boolean;
  project: boolean;
  global: boolean;
  configDir: string;
}

async function targetRow(
  ctx: PalmContext,
  t: Target,
  scope: Scope,
): Promise<Omit<TargetRow, 'active'>> {
  const [project, global] = await Promise.all([
    t.detect('project', ctx.paths.projectRoot, ctx.env).catch(() => false),
    t.detect('global', ctx.paths.home, ctx.env).catch(() => false),
  ]);
  const configDir = t.configDir(scope, scopeRootOf(ctx, scope), ctx.env);
  return { id: t.id, name: t.displayName, project, global, configDir };
}

async function activeTargets(ctx: PalmContext, scope: Scope, flag?: TargetId[]) {
  const { resolveTargets } = await import('../engine/resolve-targets.js');
  try {
    return { active: await resolveTargets(ctx, { scope, flag }) };
  } catch (e) {
    if (!isPalmError(e)) throw e;
    return { active: [] as TargetId[], unresolved: e.message };
  }
}

export interface TargetsView {
  scope: Scope;
  active: TargetId[];
  source?: TargetSource;
  unresolved?: string;
  items: TargetRow[];
}

/** Configured and detected harnesses of a scope, and why the active ones are active. */
export async function targetsView(
  ctx: PalmContext,
  opts: { scope: Scope; target?: string; names: string[] },
): Promise<TargetsView> {
  const { scope, names } = opts;
  const flag = parseTargetList(opts.target);
  const only = names.length ? parseTargetList(names.join(',')) : undefined;
  const { getTarget } = await import('../targets/index.js');
  const { active, unresolved } = await activeTargets(ctx, scope, flag);
  const source = unresolved ? undefined : await targetSource(ctx, scope, flag);
  const ids = TARGET_IDS.filter((id) => !only || only.includes(id));
  const items: TargetRow[] = await Promise.all(
    ids.map(async (id) => ({
      ...(await targetRow(ctx, getTarget(id), scope)),
      active: active.includes(id),
    })),
  );
  return { scope, active, source, unresolved, items };
}

export function printTargets(ctx: PalmContext, out: Output, view: TargetsView): void {
  const { scope, source } = view;
  const root = scope === 'project' ? ctx.paths.projectRoot : ctx.paths.home;
  const from = source ? pc.dim(`  (${SOURCE_TEXT[source]})`) : '';
  out.out(`${pc.bold(scope)} scope ${pc.dim(root)}${from}`);
  out.table(
    view.items.map((r) => [
      r.id,
      r.name,
      r.active ? pc.green('active') : '',
      r.project ? 'yes' : pc.dim('no'),
      r.global ? 'yes' : pc.dim('no'),
      displayPath(ctx, r.configDir),
    ]),
    ['target', 'harness', 'status', 'project', 'global', `${scope} config dir`],
  );
  if (view.unresolved)
    out.warn(`no targets resolved: ${view.unresolved}; set them with: ${setTargetsHint(scope)}`);
}

/** The command that records targets at `scope`: palm.yaml via init, the global config via config. */
function setTargetsHint(scope: Scope): string {
  return scope === 'global'
    ? 'palm config set targets claude,codex'
    : 'palm init --target claude,codex';
}

/** `palm get targets [id...]`. */
export async function getTargets(
  ctx: PalmContext,
  out: Output,
  opts: { scope: Scope; target?: string; names: string[] },
): Promise<void> {
  const view = await targetsView(ctx, opts);
  if (out.jsonMode) out.json({ ...view, source: view.source ?? null });
  else printTargets(ctx, out, view);
}

const SAMPLE = 'palm-sample';

/** A minimal entity of each kind, for a dry-run deploy that reveals where the kind goes. */
function sampleEntity(kind: Kind): Entity | undefined {
  const base = { kind, name: SAMPLE, path: SAMPLE, origin: 'palm' };
  switch (kind) {
    case 'skill':
      return { ...base, def: { kind, skill: { name: SAMPLE, description: 'sample' } } };
    case 'agent':
      return { ...base, def: { kind, agent: { name: SAMPLE, description: 'sample', body: 'x' } } };
    case 'instruction':
      return {
        ...base,
        def: { kind, instruction: { name: SAMPLE, alwaysApply: true, body: 'x' } },
      };
    case 'command':
      return { ...base, def: { kind, command: { name: SAMPLE, body: 'x' } } };
    case 'hook': {
      const raw = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] } };
      return { ...base, def: { kind, hooks: { name: SAMPLE, dialect: 'claude', raw } } };
    }
    case 'mcp':
      return { ...base, def: { kind, mcp: { name: SAMPLE, transport: 'stdio', command: 'true' } } };
    default:
      return undefined;
  }
}

interface KindPaths {
  kind: Kind;
  files: string[];
  merged: string[];
  notes: string[];
  skipped: boolean;
}

function kindPaths(ctx: PalmContext, kind: Kind, r: DeployResult): KindPaths {
  const show = (p: string) =>
    (p.startsWith('/') ? displayPath(ctx, p) : p).split(SAMPLE).join('<name>');
  return {
    kind,
    files: r.files.map(show),
    merged: (r.merged ?? []).map(
      (m) => `${show(m.file)} ${m.pointer.split(SAMPLE).join('<name>')}`,
    ),
    notes: r.notes.map((n) => n.split(SAMPLE).join('<name>')),
    skipped: Boolean(r.skipped),
  };
}

interface DryRun {
  ctx: PalmContext;
  target: Target;
  scope: Scope;
  /** Temp dir holding the sample skill. */
  dir: string;
}

async function dryDeploy(d: DryRun, kind: Kind): Promise<KindPaths | undefined> {
  const { ctx, dir, scope } = d;
  const entity = sampleEntity(kind);
  if (!entity) return undefined;
  const absPath = join(dir, kind);
  if (kind === 'skill') {
    await mkdir(absPath, { recursive: true });
    await writeFile(join(absPath, 'SKILL.md'), `---\nname: ${SAMPLE}\ndescription: sample\n---\n`);
  }
  const scopeRoot = scopeRootOf(ctx, scope);
  const input = {
    entity,
    absPath,
    originRoot: dir,
    scope,
    scopeRoot,
    secretPolicy: 'env-ref' as const,
  };
  try {
    const r = await d.target.deploy({
      ...input,
      dryRun: true,
      force: true,
      ownedFiles: [],
      env: ctx.env,
    });
    return kindPaths(ctx, kind, r);
  } catch (e) {
    return { kind, files: [], merged: [], notes: [`unavailable: ${messageOf(e)}`], skipped: true };
  }
}

function printKindPaths(out: Output, rows: KindPaths[]): void {
  for (const r of rows) {
    const where = [...r.files, ...r.merged.map((m) => `merged into ${m}`)];
    const first = where.shift() ?? pc.dim(r.notes[0] ?? 'nothing written');
    out.out(`  ${pc.dim(r.kind.padEnd(12))}${first}`);
    for (const w of where) out.out(`  ${' '.repeat(12)}${w}`);
  }
}

/** `palm describe target <id>`: where each kind goes for this scope (a dry-run deploy per kind). */
export async function describeTarget(
  ctx: PalmContext,
  out: Output,
  opts: { scope: Scope; names: string[] },
): Promise<void> {
  const [id, ...extra] = opts.names;
  if (!id || extra.length)
    throw usage('name one target to describe', 'palm describe target claude');
  const [targetId] = parseTargetList(id) ?? [];
  if (!targetId) throw usage('name one target to describe', 'palm describe target claude');
  const { getTarget } = await import('../targets/index.js');
  const t = getTarget(targetId);
  const row = await targetRow(ctx, t, opts.scope);
  const dir = await mkdtemp(join(tmpdir(), 'palm-describe-'));
  try {
    const kinds: KindPaths[] = [];
    for (const kind of KINDS) {
      const k = await dryDeploy({ ctx, target: t, scope: opts.scope, dir }, kind);
      if (k) kinds.push(k);
    }
    if (out.jsonMode) return out.json({ ...row, scope: opts.scope, kinds });
    out.out(`${pc.bold(`target ${t.id}`)}  ${t.displayName}  ${pc.dim(`${opts.scope} scope`)}`);
    out.out(`  ${pc.dim('config dir'.padEnd(12))}${displayPath(ctx, row.configDir)}`);
    out.out(
      `  ${pc.dim('detected'.padEnd(12))}project ${row.project ? 'yes' : 'no'}, global ${row.global ? 'yes' : 'no'}`,
    );
    out.out();
    printKindPaths(out, kinds);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
