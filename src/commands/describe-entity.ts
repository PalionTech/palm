/**
 * `palm describe` of one entity: an installed one from the lock (files per harness, notes,
 * `at:`, programs and trust, variables), or one a source offers from its index (J21).
 */
import { PalmError } from '../core/errors.js';
import type { Entity, EntityRefSpec, PalmContext, Scope } from '../core/types.js';
import { TARGET_IDS } from '../core/types.js';
import type { EntityInfo, ScopeState, SourceListing } from '../create/engine.js';
import { displayLockPath, shortHash, truncate } from '../ui/format.js';
import type { Output } from '../ui/output.js';
import type { App } from './app.js';
import { formatName, nearest, palmLine } from './hints.js';
import { refCell, sourceLabel } from './scope-view.js';
import { engine, engineDeps, withSpinner } from './shared.js';

export function field(out: Output, label: string, value: string | undefined): void {
  if (value) out.out(`  ${out.colors.dim(label.padEnd(Math.max(12, label.length + 1)))}${value}`);
}

const setWord = (s: { name: string; set: boolean }) => `${s.name} (${s.set ? 'set' : 'not set'})`;

/** An MCP server: each harness's file and pointer, then the block palm merged there. */
function printBlocks(out: Output, blocks: NonNullable<EntityInfo['blocks']>): void {
  for (const t of TARGET_IDS)
    for (const b of blocks[t] ?? []) {
      field(out, t, `${displayLockPath(b.file)} ${b.at}`);
      for (const line of JSON.stringify(b.value, null, 2).split('\n')) out.out(`      ${line}`);
    }
}

function printFiles(out: Output, info: EntityInfo): void {
  if (info.blocks) {
    printBlocks(out, info.blocks);
    return;
  }
  for (const t of TARGET_IDS) {
    const files = info.files[t];
    if (files?.length) field(out, t, files.map(displayLockPath).join(', '));
  }
  for (const m of info.entry.merged ?? [])
    field(out, 'merged', `${displayLockPath(m.file)} ${m.at}`);
}

function printExec(out: Output, info: EntityInfo, scope: Scope): void {
  if (!info.exec) return;
  for (const c of info.exec.commands) field(out, 'runs', `${c.id}  ${c.command}`);
  const hash = `sha256:${shortHash(info.exec.hash, 8)}`;
  const e = info.entry;
  const key = `${e.kind}:${e.name}@${e.source}=${info.exec.hash}`;
  const allow = palmLine('install', ['--allow-exec', key], scope);
  field(out, 'trust', info.exec.trusted ? `trusted (${hash})` : `not trusted; allow it: ${allow}`);
}

/** Y3: when an instruction applies, as its source format says (`always`, `for src/**`, …). */
function activationOf(e: Entity | undefined): string | undefined {
  if (e?.def.kind !== 'instruction') return undefined;
  const { activation, globs } = e.def.instruction;
  if (activation === 'paths') return `for files matching ${(globs ?? []).join(', ')}`;
  if (activation === 'on-request') return 'when the agent finds it relevant (its description)';
  if (activation === 'manual') return 'only when you name it';
  return 'always';
}

export function printEntity(out: Output, info: EntityInfo, scope: Scope): void {
  const e = info.entry;
  out.out(`${out.colors.bold(`${e.kind} ${e.name}`)}  (installed, ${scope} scope)`);
  if (info.entity?.description) out.out(`  ${info.entity.description}`);
  const location = info.source.url ?? info.source.path;
  field(out, 'source', [sourceLabel(e.source), location].filter(Boolean).join('  '));
  field(out, 'ref', [refCell(info.source), shortHash(info.source.sha)].filter(Boolean).join('  '));
  field(out, 'path', e.path);
  field(out, 'version', info.entity?.version);
  field(out, 'at', e.at ? `${e.at} (placed at the root until 0.3)` : undefined);
  field(out, 'selected by', info.selectedBy === 'manifest' ? 'palm.yaml' : info.selectedBy);
  field(out, 'members', e.deps?.map((d) => `${d.kind} ${d.name}`).join(', '));
  field(out, 'activation', activationOf(info.entity));
  printFiles(out, info);
  for (const note of info.notes) field(out, 'note', note);
  printExec(out, info, scope);
  field(out, 'variables', info.secrets?.map(setWord).join(', '));
}

/** The entity of a listing `ref` names; E_NOT_FOUND with the name it nearly is, or E_AMBIGUOUS. */
function pickOffered(listed: SourceListing, ref: EntityRefSpec, scope: Scope): Entity {
  const lower = ref.name.toLowerCase();
  const hits = listed.index.entities.filter(
    (e) => e.name.toLowerCase() === lower && (!ref.kind || e.kind === ref.kind),
  );
  const source = listed.source.name;
  const [hit, second] = hits;
  if (hit && !second) return hit;
  if (hit)
    throw new PalmError(
      'E_AMBIGUOUS',
      `"${ref.name}" names ${hits.length} kinds in source ${source}`,
      hits
        .map((e) => `  ${palmLine('describe', [source, `${e.kind}:${e.name}`], scope)}`)
        .join('\n'),
    );
  const near = nearest(
    ref.name,
    listed.index.entities.map((e) => e.name),
  );
  throw new PalmError(
    'E_NOT_FOUND',
    `"${formatName(ref)}" is not in source ${source}${near ? `; did you mean ${near}?` : ''}`,
    near
      ? palmLine('describe', [source, near], scope)
      : palmLine('install', [source, '--grep', ref.name], scope),
  );
}

interface Offered {
  source: string;
  ref: EntityRefSpec;
  state: ScopeState;
}

/** J21: an entity a source offers, read from its index (nothing installed, nothing saved). */
export async function describeAvailable(ctx: PalmContext, app: App, job: Offered): Promise<void> {
  const scope = job.state.paths.scope;
  const listed = await withSpinner(ctx, `Fetching ${job.source}`, () =>
    engine(app).listSource(ctx, job.source, { scope }, engineDeps(app)),
  );
  const e = pickOffered(listed, job.ref, scope);
  const executable = await engine(app).isExecutable(e);
  const install = palmLine('install', [job.source, `${e.kind}:${e.name}`], scope);
  if (app.out.jsonMode)
    return app.out.json({
      ...entityDoc(e, executable),
      source: listed.source.name,
      installed: false,
    });
  const out = app.out;
  out.out(
    `${out.colors.bold(`${e.kind} ${e.name}`)}  (offered by ${listed.source.name}, not installed)`,
  );
  if (e.description) out.out(`  ${truncate(e.description, 200)}`);
  field(out, 'source', [listed.source.name, listed.source.describe()].join('  '));
  const ref = [listed.checkout.ref, shortHash(listed.checkout.sha ?? listed.checkout.tree)];
  field(out, 'ref', ref.filter(Boolean).join('  '));
  field(out, 'path', e.path);
  field(out, 'version', e.version);
  field(out, 'activation', activationOf(e));
  for (const note of e.notes ?? []) field(out, 'note', note);
  if (executable) field(out, 'program', 'runs on your machine; palm asks before installing it');
  field(out, 'install it', install);
}

function entityDoc(e: Entity, executable: boolean) {
  return {
    kind: e.kind,
    name: e.name,
    description: e.description,
    version: e.version,
    path: e.path,
    executable,
  };
}
