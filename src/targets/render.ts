/**
 * Rendering: one small strategy per entity kind (`RENDERERS`) fills a `RenderJob` with whole
 * files (lock form, bytes, mode), fragments to merge into shared files (with id, key and value),
 * the exec lines the harness will run, and notes. Nothing here writes, and nothing reads the
 * destination: a render depends on the source, the closure and the scope's layout alone, so it
 * is the same on every machine and `hash` (domain `renderHashOf`) is what the lock compares.
 *
 * Secret values never reach the hash: fragments are hashed with literal values replaced by their
 * `${VAR}` placeholders, plus a marker naming the variables written literally, so a policy
 * change re-renders and a rotated secret does not.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isPalmError, messageOf, PalmError } from '../core/errors.js';
import type {
  Closure,
  Entity,
  InstructionDefinition,
  Kind,
  Rendered,
  RenderedFile,
  RenderedFragment,
  RenderInput,
  TargetId,
} from '../core/types.js';
import { fragmentId, fragmentKey } from '../domain/lock.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { SKILL_MAX_BYTES, SKILL_MAX_FILES } from '../domain/skill-copy.js';
import { isWithin, toPosix } from '../lib/fs.js';
import { stringifyJson } from '../lib/json.js';
import { formatPointer } from '../lib/json-pointer.js';
import { type ClosureEntry, gitMode, readClosure } from './assets.js';
import { renderAgent } from './convert-agent.js';
import { convertHooks, type Relocate } from './convert-hooks.js';
import { renderInstruction } from './convert-instruction.js';
import { renderCommandAsSkill } from './convert-skill.js';
import { listSkillFiles, type SkillFiles } from './fs-utils.js';
import { hookClosureFiles } from './hook-closure.js';
import { sharedSkillsRoot, type TargetLayout } from './layout.js';
import { renderMcp } from './mcp-config.js';
import { relocateCommand, relocateMcp } from './relocate.js';
import { renderHash } from './render-hash.js';
import { withSkillName } from './skill-name.js';

/** Permission bits of a file that can hold secrets. */
const PRIVATE_MODE = 0o600;

/** Collects one render; `finish()` turns it into a `Rendered`. */
export class RenderJob {
  private readonly files = new Map<string, RenderedFile>();
  private readonly fragments: RenderedFragment[] = [];
  private readonly exec: Rendered['exec'] = [];
  private readonly notes: string[] = [];
  private skipped = false;

  constructor(
    readonly input: RenderInput,
    readonly paths: ScopePaths,
    readonly layout: TargetLayout,
    readonly target: { id: TargetId; displayName: string },
  ) {}

  get entity(): Entity {
    return this.input.entity;
  }

  lock(abs: string): string {
    return this.paths.lockForm(abs);
  }

  note(msg: string): void {
    if (!this.notes.includes(msg)) this.notes.push(msg);
  }

  /** The target has nothing to do for this entity (a documented gap), with the reason. */
  skip(msg: string): void {
    this.note(msg);
    this.skipped = true;
  }

  file(abs: string, data: string | Uint8Array, mode?: number): void {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const p = this.lock(abs);
    this.files.set(p, { path: p, data: bytes, ...(mode !== undefined ? { mode } : {}) });
  }

  /**
   * A fragment of the shared file `abs` at `at` (a JSON pointer, or `block:<id>`). At global
   * scope a JSON or TOML file palm creates is private (0600): it can hold secrets.
   */
  fragment(
    abs: string,
    at: string,
    value: unknown,
    extra: Pick<RenderedFragment, 'mode' | 'ensure'> = {},
  ): void {
    const file = this.lock(abs);
    const privateFile = this.input.scope === 'global' && /\.(json|toml)$/i.test(file);
    this.fragments.push({
      file,
      at,
      id: fragmentId(this.entity, this.fragments.length),
      key: fragmentKey(at, value),
      value,
      ...(privateFile ? { createMode: PRIVATE_MODE } : {}),
      ...extra,
    });
  }

  execLine(line: Rendered['exec'][number]): void {
    this.exec.push(line);
  }

  /**
   * The render with its hash (`renderHash`): under -g the palm home and home directory are
   * hashed as `<palm>` and `<home>`, secret values as their `${VAR}` placeholders.
   */
  finish(): Rendered {
    const files = [...this.files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    return {
      files,
      fragments: this.fragments,
      exec: this.exec,
      notes: this.notes,
      ...(this.skipped ? { skipped: true } : {}),
      hash: renderHash(files, this.fragments, {
        scope: this.input.scope,
        paths: this.paths,
        secretPolicy: this.input.secretPolicy,
        secretValues: this.input.secretValues,
      }),
    };
  }
}

type Renderer = (job: RenderJob) => Promise<void>;

function defOf<K extends Entity['def']['kind']>(
  entity: Entity,
  kind: K,
): Extract<Entity['def'], { kind: K }> {
  if (entity.def.kind !== kind)
    throw new PalmError(
      'E_INTERNAL',
      `entity ${entity.name}: expected a ${kind} definition, got ${entity.def.kind}`,
    );
  return entity.def as Extract<Entity['def'], { kind: K }>;
}

/** A layout's gap note with the entity's name in place of `<name>`. */
function skipNote(note: string, job: RenderJob): string {
  return note.replaceAll('<name>', job.entity.name);
}

/**
 * Where the copies of a skill are. With claude active: cursor reads `.claude/skills` (one copy);
 * the others read only `.agents/skills` (two copies). Without it, cursor and opencode (which have
 * directories of their own) get a note that they read `.agents/skills`.
 */
function noteCopies(job: RenderJob, dir: string, active: readonly TargetId[]): void {
  const id = job.target.id;
  if (id === 'claude') return;
  if (!active.includes('claude')) {
    const shared = path.dirname(dir).endsWith(path.join('.agents', 'skills'));
    if (shared && (id === 'cursor' || id === 'opencode')) job.note(`${id} reads .agents/skills`);
    return;
  }
  if (isWithin(dir, job.paths.harnessHome('claude')))
    job.note(`${job.target.id} reads .claude/skills; no second copy`);
  else job.note('claude gets its own copy in .claude/skills');
}

/** Every file of the skill directory, or the SKILL.md of a command, below `<skillsDir>/<name>/`. */
async function renderSkill(job: RenderJob): Promise<void> {
  const { skill } = defOf(job.entity, 'skill');
  const active = job.input.targets ?? [job.target.id];
  const dir = path.join(job.layout.skillsDir(active), job.entity.name);
  noteCopies(job, dir, active);
  if (skill.fromCommand) {
    const r = renderCommandAsSkill({ ...skill, fromCommand: skill.fromCommand }, job.target.id);
    job.file(path.join(dir, 'SKILL.md'), r.content);
    for (const n of r.notes) job.note(n);
    return;
  }
  await copySkillFiles(job, dir);
}

/** `1,192 files (42.1 MB)`: the size of a skill copy in a message. */
function copySize(count: number, bytes: number): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'file' : 'files'} (${mb} MB)`;
}

/** A skill above 200 files or 5 MB is copied only with `--force` (ruling Y2). */
function assertSkillSize(job: RenderJob, files: SkillFiles['files']): void {
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (job.input.force || (files.length <= SKILL_MAX_FILES && bytes <= SKILL_MAX_BYTES)) return;
  const limit = `${SKILL_MAX_FILES} files or ${SKILL_MAX_BYTES / (1024 * 1024)} MB`;
  throw new PalmError(
    'E_SOURCE',
    `skill ${job.entity.name}: ${copySize(files.length, bytes)} to copy; a skill above ${limit} needs --force`,
    job.entity.path === '.'
      ? 'a SKILL.md at the source root makes the whole repository the skill; to copy it anyway, run'
      : `check ${job.entity.path} in the source; to copy it anyway, run`,
    { retryWith: '--force' },
  );
}

/** `agents/openai.yaml` is Codex metadata: only `.agents/skills` copies get it (DESIGN §2). */
function codexOnly(job: RenderJob, dir: string, rel: string): boolean {
  if (rel !== 'agents/openai.yaml') return false;
  return path.dirname(dir) !== sharedSkillsRoot(job.paths).dir;
}

async function copySkillFiles(job: RenderJob, dir: string): Promise<void> {
  const { absPath, sourceRoot } = job.input;
  const name = job.entity.name;
  // Links may point anywhere inside the source (shared references), never outside it.
  const boundary = isWithin(absPath, sourceRoot) ? sourceRoot : absPath;
  const listed = await listSkillFiles(absPath, { boundary }).catch((e: unknown) => {
    throw new PalmError('E_IO', `skill ${name}: cannot read ${absPath}: ${messageOf(e)}`);
  });
  if (listed.symlinksOutside.length)
    job.note(
      `skill ${name}: not copied (a link leaving the source): ${listed.symlinksOutside.join(', ')}`,
    );
  if (listed.leftOut.length)
    job.note(
      leftOutNote(name, listed.leftOut, 'harness, palm and .env files are not skill content'),
    );
  if (listed.testsLeftOut.length)
    job.note(leftOutNote(name, listed.testsLeftOut, 'tests and fixtures stay in the source'));
  const files = listed.files.filter((f) => !codexOnly(job, dir, f.rel));
  if (files.length === 0)
    throw new PalmError('E_NOT_FOUND', `skill ${name}: no files in ${absPath}`);
  assertSkillSize(job, files);
  for (const f of files) {
    const bytes = await fs.readFile(f.abs);
    const data = f.rel === 'SKILL.md' ? withSkillName(bytes, name) : bytes;
    job.file(path.join(dir, ...f.rel.split('/')), data, gitMode(f.mode));
  }
}

/** `skill x: left out .cursor, palm.yaml +2 (harness, palm and .env files are not skill content)`. */
function leftOutNote(name: string, leftOut: readonly string[], why: string): string {
  const shown = leftOut.slice(0, 3).join(', ');
  const more = leftOut.length > 3 ? ` +${leftOut.length - 3}` : '';
  return `skill ${name}: left out ${shown}${more} (${why})`;
}

async function renderAgentKind(job: RenderJob): Promise<void> {
  const { agent } = defOf(job.entity, 'agent');
  const r = renderAgent({ ...agent, name: job.entity.name }, job.target.id);
  const dest = path.join(job.layout.agentsDir, r.fileName);
  job.file(dest, r.content);
  const shown = job.lock(dest);
  if (r.dropped.length)
    job.note(
      `${shown}: dropped ${r.dropped.join(', ')} (not supported by ${job.target.displayName})`,
    );
  for (const n of r.notes ?? []) job.note(`${shown}: ${n}`);
}

/**
 * The entry an instruction file gets in a JSON list (OpenCode `instructions`): the project path,
 * or at global scope `~/<path>` (OpenCode expands `~/`), so no machine path is rendered.
 */
function listedPath(job: RenderJob, dest: string): string {
  if (job.input.scope === 'project') return job.lock(dest);
  const home = job.paths.token('home');
  return isWithin(dest, home, { strict: true }) ? `~/${toPosix(path.relative(home, dest))}` : dest;
}

/** Harnesses that keep an on-request or manual instruction as it is (Cursor's `.mdc` fields). */
const KEEPS_ACTIVATION: ReadonlySet<TargetId> = new Set(['cursor']);

/**
 * `instruction x: on-request in the source, always-on for claude until 0.3` (ruling Y3): every
 * harness but Cursor loads the rendered instruction always.
 */
function noteWidened(job: RenderJob, activation: InstructionDefinition['activation']): void {
  if (activation !== 'on-request' && activation !== 'manual') return;
  if (KEEPS_ACTIVATION.has(job.target.id)) return;
  job.note(
    `instruction ${job.entity.name}: ${activation} in the source, always-on for ${job.target.id} until 0.3`,
  );
}

/** A Claude rule for claude: the source file byte for byte, under its own name (ruling B12). */
async function copyClaudeRule(job: RenderJob, dir: string, def: InstructionDefinition) {
  const fileName = def.fileName ?? `${job.entity.name}.md`;
  const bytes = await fs.readFile(job.input.absPath).catch((e: unknown) => {
    throw new PalmError(
      'E_IO',
      `instruction ${job.entity.name}: cannot read ${job.input.absPath}: ${messageOf(e)}`,
    );
  });
  job.file(path.join(dir, fileName), bytes);
}

async function renderInstructionKind(job: RenderJob): Promise<void> {
  const where = job.layout.instructions;
  if ('skip' in where) {
    job.skip(skipNote(where.skip, job));
    return;
  }
  const { instruction } = defOf(job.entity, 'instruction');
  noteWidened(job, instruction.activation);
  if (job.target.id === 'claude' && instruction.sourceFormat === 'claude-md' && 'dir' in where)
    return copyClaudeRule(job, where.dir, instruction);
  const r = renderInstruction({ ...instruction, name: job.entity.name }, job.target.id);
  if ('managedBlock' in r) {
    if (!('blockFile' in where))
      throw new PalmError('E_INTERNAL', `${job.target.id}: no file for instruction blocks`);
    job.fragment(where.blockFile, `block:instruction:${job.entity.name}`, r.managedBlock);
    return;
  }
  if (!('dir' in where))
    throw new PalmError('E_INTERNAL', `${job.target.id}: no instruction directory`);
  const dest = path.join(where.dir, r.fileName);
  job.file(dest, r.content);
  if (where.list)
    job.fragment(where.list.json, formatPointer(where.list.path), listedPath(job, dest));
}

/** Closure files below the asset root (git sources); in-place sources copy nothing. */
async function renderClosure(
  job: RenderJob,
  closure: Closure,
  keep: (files: ClosureEntry[]) => ClosureEntry[] = (files) => files,
): Promise<void> {
  if (job.input.inPlace || closure.paths.length === 0) return;
  for (const f of keep(await readClosure(job.input.sourceRoot, closure))) {
    const lockPath = path.posix.join(job.input.assetsRoot, f.rel);
    job.file(job.paths.abs(lockPath), f.data, f.mode);
  }
}

/** `fn()` with an E_SOURCE refusal prefixed by the entity it refuses. */
async function refusing<T>(job: RenderJob, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isPalmError(e) || e.code !== 'E_SOURCE') throw e;
    const { kind, name, source } = job.entity;
    throw new PalmError('E_SOURCE', `${kind} ${name} from ${source}: ${e.message}`, e.hint);
  }
}

function hookRelocate(job: RenderJob): Relocate {
  const { hooks } = defOf(job.entity, 'hook');
  const { assetsRoot, scope, env } = job.input;
  return (command, opts) =>
    relocateCommand(command, hooks.references ?? [], job.target.id, {
      assetsRoot,
      scope,
      env: env ?? job.paths.env,
      powershell: opts?.powershell,
    });
}

async function renderHook(job: RenderJob): Promise<void> {
  const { hooks } = defOf(job.entity, 'hook');
  const where = job.layout.hooks;
  if ('skip' in where) {
    job.skip(skipNote(where.skip, job));
    return;
  }
  const converted = await refusing(job, () =>
    convertHooks(hooks, job.target.id, hookRelocate(job)),
  );
  const { name } = job.entity;
  if (converted.dropped.length)
    job.note(
      `hooks ${name}: dropped for ${job.target.displayName}: ${converted.dropped.join('; ')}`,
    );
  const events = (converted.hooks as { hooks: Record<string, unknown[]> }).hooks;
  if (Object.values(events).every((items) => items.length === 0)) {
    job.skip(`hooks ${name}: nothing ${job.target.displayName} can run`);
    return;
  }
  const file = 'dir' in where ? path.join(where.dir, `${name}.json`) : where.mergeFile;
  if ('dir' in where) job.file(file, stringifyJson(converted.hooks));
  else mergeHookEntries(job, file, events, where.versioned);
  for (const line of converted.exec) job.execLine({ ...line, file: job.lock(file) });
  const closure = hooks.closure ?? { paths: [] };
  const scope = {
    entityPath: job.entity.path,
    targets: job.input.targets ?? [job.target.id],
    ...(closure.reads ? { reads: closure.reads } : {}),
  };
  await refusing(job, () => renderClosure(job, closure, (files) => hookClosureFiles(files, scope)));
}

/** One fragment per converted hook entry, in the shared hooks file. */
function mergeHookEntries(
  job: RenderJob,
  file: string,
  events: Record<string, unknown[]>,
  versioned?: boolean,
): void {
  const extra = versioned ? { ensure: { version: 1 } } : {};
  for (const [event, items] of Object.entries(events))
    for (const item of items) job.fragment(file, formatPointer(['hooks', event]), item, extra);
}

/** The MCP config file and the pointer of the server's key or table. */
function mcpSlot(layout: TargetLayout, key: string): { file: string; at: string } {
  const { mcp } = layout;
  if ('toml' in mcp) return { file: mcp.toml, at: formatPointer(['mcp_servers', key]) };
  return { file: mcp.json, at: formatPointer([...mcp.path, key]) };
}

/**
 * One note for every target (they dedupe): the variables the person exports, and apart from
 * them the optional ones the server starts without (ruling Q8).
 */
function noteVariables(job: RenderJob, r: ReturnType<typeof renderMcp>): void {
  const needed = r.envRefs.filter((v) => !r.optionalRefs.includes(v));
  if (needed.length) job.note(`needs ${needed.join(', ')} in the environment`);
  if (r.optionalRefs.length) job.note(`optional in the environment: ${r.optionalRefs.join(', ')}`);
}

async function renderMcpKind(job: RenderJob): Promise<void> {
  const def = defOf(job.entity, 'mcp');
  const { secretPolicy, secretValues, scope, assetsRoot } = job.input;
  const key = def.mcp.name || job.entity.name;
  const relocated = await refusing(job, () =>
    relocateMcp({ ...def.mcp, name: key }, def.references ?? [], job.target.id, {
      assetsRoot,
      scope,
      absolute: (p) => job.paths.abs(p),
      home: job.paths.token('home'),
    }),
  );
  const values = secretValues ?? {};
  const r = renderMcp(relocated.cfg, job.target.id, secretPolicy, { values, scope });
  for (const n of r.notes) job.note(n);
  if (!r.entry) {
    job.skip(`MCP ${key}: nothing ${job.target.displayName} can run`);
    return;
  }
  const slot = mcpSlot(job.layout, key);
  const literal = secretPolicy === 'literal' && Object.keys(values).length > 0;
  job.fragment(slot.file, slot.at, r.entry, literal ? { mode: PRIVATE_MODE } : {});
  noteVariables(job, r);
  if (def.mcp.transport === 'stdio') {
    const { canonical, rendered: command } = relocated;
    job.execLine({ id: 'stdio', canonical, command, file: job.lock(slot.file) });
  }
  await refusing(job, () => renderClosure(job, def.closure ?? { paths: [] }));
}

async function renderPlugin(job: RenderJob): Promise<void> {
  job.skip(`plugin ${job.entity.name}: members are installed individually`);
}

export const RENDERERS: Record<Kind, Renderer> = {
  skill: renderSkill,
  agent: renderAgentKind,
  instruction: renderInstructionKind,
  hook: renderHook,
  mcp: renderMcpKind,
  plugin: renderPlugin,
};
