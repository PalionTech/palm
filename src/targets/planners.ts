/**
 * Kind planners: one small strategy per entity kind that turns a `DeployInput` into plan
 * entries (whole files and shared-file edits) without writing anything. `PLANNERS[kind]`
 * returns true when the target has nothing to do for the kind at this scope (a documented gap).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { messageOf, PalmError } from '../core/errors.js';
import type { DeployInput, Entity, HookSet, Kind, TargetId } from '../core/types.js';
import { HOOK_ASSET_SKIP_FILE, HOOK_ASSET_SKIP_TOP } from '../domain/ignore.js';
import type { ScopePaths } from '../domain/scope-paths.js';
import { isWithin, pathExists } from '../lib/fs.js';
import { stringifyJson } from '../lib/json.js';
import { formatPointer } from '../lib/json-pointer.js';
import { renderAgent } from './convert-agent.js';
import { renderCommand } from './convert-command.js';
import { convertHooks, referencesPluginRoot } from './convert-hooks.js';
import { renderInstruction } from './convert-instruction.js';
import { listCopyFiles } from './fs-utils.js';
import { appendItemText, ensureKeyText, setKeyText } from './json-merge.js';
import type { InstructionList, TargetLayout } from './layout.js';
import { upsertBlockText } from './managed-block.js';
import { renderMcp } from './mcp-config.js';
import { type DeployPlan, type Ownership, type PlannedEdit, planMerge } from './plan.js';
import { redactSecrets } from './recorded.js';
import { mergeTableText } from './toml-merge.js';

/** One deploy call: its input, paths and layout, the plan being built and the ownership policy. */
export interface Job {
  input: DeployInput;
  paths: ScopePaths;
  layout: TargetLayout;
  plan: DeployPlan;
  owner: Ownership;
  target: { id: TargetId; displayName: string };
}

/** Plans one kind; true when skipped. */
type Planner = (job: Job) => Promise<boolean>;

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

/** Every file of the skill directory, below `<skillsDir>/<name>/`. */
async function planSkill(job: Job): Promise<boolean> {
  const { entity, absPath, originRoot } = job.input;
  const dest = path.join(job.layout.skillsDir, entity.name);
  // Links may point anywhere inside the origin (shared references), never outside it.
  const boundary = isWithin(absPath, originRoot) ? originRoot : absPath;
  const { files, skipped } = await listCopyFiles(absPath, { boundary }).catch((e: unknown) => {
    throw new PalmError('E_IO', `skill ${entity.name}: cannot read ${absPath}: ${messageOf(e)}`);
  });
  if (skipped.length)
    job.plan.note(
      `skill ${entity.name}: not copied (symlink leaving the origin, or broken): ${skipped.join(', ')}`,
    );
  if (files.length === 0)
    throw new PalmError('E_NOT_FOUND', `skill ${entity.name}: no files in ${absPath}`);
  for (const f of files)
    job.plan.write(path.join(dest, ...f.rel.split('/')), await fs.readFile(f.abs), f.mode);
  return false;
}

async function planAgent(job: Job): Promise<boolean> {
  const { agent } = defOf(job.input.entity, 'agent');
  const r = renderAgent({ ...agent, name: job.input.entity.name }, job.target.id);
  const dest = path.join(job.layout.agentsDir, r.fileName);
  job.plan.write(dest, r.content);
  if (r.dropped.length)
    job.plan.note(
      `${job.paths.lockForm(dest)}: dropped ${r.dropped.join(', ')} (not supported by ${job.target.displayName})`,
    );
  for (const n of r.notes ?? []) job.plan.note(`${job.paths.lockForm(dest)}: ${n}`);
  return false;
}

/** A layout's gap note with the entity's name in place of `<name>`. */
function skipNote(note: string, job: Job): string {
  return note.replaceAll('<name>', job.input.entity.name);
}

/** A palm-managed block in a shared markdown file (Codex AGENTS.md, Gemini GEMINI.md). */
async function planInstructionBlock(job: Job, file: string, content: string): Promise<void> {
  const id = `instruction:${job.input.entity.name}`;
  const edit = {
    file,
    id,
    content,
    onConflict: job.owner.onConflict(file, `block:${id}`),
    displayFile: job.paths.lockForm(file),
  };
  await planMerge(job.plan, file, (text) => upsertBlockText(text, edit));
  job.plan.addMerged({ type: 'md-block', file, id, content });
}

async function planInstruction(job: Job): Promise<boolean> {
  const { instruction } = defOf(job.input.entity, 'instruction');
  const where = job.layout.instructions;
  if ('skip' in where) {
    job.plan.note(skipNote(where.skip, job));
    return true;
  }
  const r = renderInstruction({ ...instruction, name: job.input.entity.name }, job.target.id);
  if ('managedBlock' in r) {
    if (!('blockFile' in where))
      throw new PalmError('E_INTERNAL', `${job.target.id}: no file for instruction blocks`);
    await planInstructionBlock(job, where.blockFile, r.managedBlock);
    return false;
  }
  if (!('dir' in where))
    throw new PalmError('E_INTERNAL', `${job.target.id}: no instruction directory`);
  const dest = path.join(where.dir, r.fileName);
  job.plan.write(dest, r.content);
  if (where.list) await planInstructionListing(job, where.list, dest);
  return false;
}

/** List the instruction file in a JSON array (OpenCode `instructions`), recorded as one item. */
async function planInstructionListing(
  job: Job,
  list: InstructionList,
  dest: string,
): Promise<void> {
  const edit = { file: list.json, path: list.path, value: job.paths.lockForm(dest) };
  await planMerge(job.plan, list.json, (text) => appendItemText(text, edit));
  job.plan.addMerged({ type: 'json-item', ...edit, path: [...edit.path] });
}

async function planCommand(job: Job): Promise<boolean> {
  const { command } = defOf(job.input.entity, 'command');
  const { commands } = job.layout;
  if ('skip' in commands) {
    job.plan.note(skipNote(commands.skip, job));
    return true;
  }
  const r = renderCommand({ ...command, name: job.input.entity.name }, job.target.id);
  const dest = path.join(commands.dir, r.fileName);
  job.plan.write(dest, r.content);
  for (const n of r.notes ?? []) job.plan.note(`${job.paths.lockForm(dest)}: ${n}`);
  return false;
}

/** The plugin root a hook's commands reference and the origin boundary it must lie in. */
function hookPluginRoot(input: DeployInput, hooks: HookSet): { src: string; boundary: string } {
  const { entity, originRoot, absPath } = input;
  const src =
    hooks.pluginRootRel !== undefined
      ? path.resolve(originRoot, hooks.pluginRootRel)
      : path.dirname(absPath);
  const boundary = isWithin(absPath, originRoot) ? originRoot : path.dirname(absPath);
  if (!isWithin(src, boundary)) {
    throw new PalmError(
      'E_PARSE',
      `hooks ${entity.name}: plugin root ${src} lies outside the origin ${boundary}`,
    );
  }
  return { src, boundary };
}

/**
 * Copy the plugin root a hook's commands reference into `assetDir` (the whole root: scripts
 * may read sibling files such as skills/<name>/SKILL.md), minus documentation, tests and CI
 * material that no hook runs.
 */
async function planHookAssets(job: Job, hooks: HookSet, assetDir: string): Promise<void> {
  const { entity } = job.input;
  const { src, boundary } = hookPluginRoot(job.input, hooks);
  if (!(await pathExists(src))) {
    job.plan.note(`hooks ${entity.name}: plugin root ${src} not found; commands may fail`);
    return;
  }
  const { files, skipped } = await listCopyFiles(src, { skipTop: HOOK_ASSET_SKIP_TOP, boundary });
  for (const f of files) {
    if (!f.rel.includes('/') && HOOK_ASSET_SKIP_FILE.test(f.rel)) continue;
    job.plan.write(path.join(assetDir, ...f.rel.split('/')), await fs.readFile(f.abs), f.mode);
  }
  if (skipped.length)
    job.plan.note(
      `hooks ${entity.name}: not copied (symlink leaving the origin, or broken): ${skipped.join(', ')}`,
    );
  job.plan.note(`hook scripts copied to ${job.paths.lockForm(assetDir)}`);
}

/** Append every converted hook entry to the shared hooks file, one record per entry. */
async function planHookMerges(
  job: Job,
  hooks: { mergeFile: string; versioned?: boolean },
  events: Record<string, unknown[]>,
): Promise<void> {
  const file = hooks.mergeFile;
  if (hooks.versioned) {
    const version = { file, path: ['version'], value: 1 };
    await planMerge(job.plan, file, (text) => ensureKeyText(text, version));
  }
  for (const [event, items] of Object.entries(events)) {
    for (const value of items) {
      const edit = { file, path: ['hooks', event], value };
      await planMerge(job.plan, file, (text) => appendItemText(text, edit));
      job.plan.addMerged({ type: 'json-item', ...edit, path: [...edit.path] });
    }
  }
}

async function planHook(job: Job): Promise<boolean> {
  const { hooks } = defOf(job.input.entity, 'hook');
  const { entity } = job.input;
  const { layout, plan, target } = job;
  if ('skip' in layout.hooks) {
    plan.note(skipNote(layout.hooks.skip, job));
    return true;
  }
  const assetDir = job.paths.hooksAssetDir(entity.name);
  const converted = convertHooks(hooks, target.id, assetDir, job.paths);
  if (converted.dropped.length)
    plan.note(
      `hooks ${entity.name}: dropped for ${target.displayName}: ${converted.dropped.join('; ')}`,
    );
  const events = (converted.hooks as { hooks: Record<string, unknown[]> }).hooks;
  if (Object.values(events).every((items) => items.length === 0)) {
    plan.note(`hooks ${entity.name}: nothing ${target.displayName} can run`);
    return true;
  }
  if (referencesPluginRoot(hooks.raw)) await planHookAssets(job, hooks, assetDir);
  if ('dir' in layout.hooks)
    plan.write(path.join(layout.hooks.dir, `${entity.name}.json`), stringifyJson(converted.hooks));
  else await planHookMerges(job, layout.hooks, events);
  return false;
}

/** The MCP server's key in a JSON object or its `[mcp_servers.<name>]` TOML table. */
async function planMcpEntry(
  job: Job,
  key: string,
  entry: Record<string, unknown>,
): Promise<PlannedEdit> {
  const { mcp } = job.layout;
  const toml = 'toml' in mcp;
  const file = toml ? mcp.toml : mcp.json;
  const keyPath = toml ? ['mcp_servers', key] : [...mcp.path, key];
  const edit = {
    file,
    path: keyPath,
    value: entry,
    onConflict: job.owner.onConflict(file, formatPointer(keyPath)),
    displayFile: job.paths.lockForm(file),
  };
  const planned = await planMerge(job.plan, file, (text) =>
    toml ? mergeTableText(text, edit) : setKeyText(text, edit),
  );
  // The lockfile (and --json output) records placeholders, never literal secret values.
  const value = redactSecrets(entry, job.input.secretValues);
  job.plan.addMerged({ type: toml ? 'toml-table' : 'json-key', file, path: keyPath, value });
  return planned;
}

async function planMcp(job: Job): Promise<boolean> {
  const { mcp } = defOf(job.input.entity, 'mcp');
  const { secretPolicy, secretValues, scope } = job.input;
  const { plan, target } = job;
  const key = mcp.name || job.input.entity.name;
  const values = secretValues ?? {};
  const r = renderMcp({ ...mcp, name: key }, target.id, secretPolicy, { values, scope });
  for (const n of r.notes) plan.note(n);
  if (!r.entry) return true;
  const planned = await planMcpEntry(job, key, r.entry);
  // User-level MCP configs and anything holding literal secrets: private to the user when palm creates them.
  const literal = secretPolicy === 'literal' && Object.keys(values).length > 0;
  if (scope === 'global' || literal) planned.createMode = 0o600;
  if (r.envRefs.length)
    plan.note(
      `MCP ${key}: export ${r.envRefs.join(', ')} in the environment ${target.displayName} runs in`,
    );
  return false;
}

async function planPlugin(job: Job): Promise<boolean> {
  job.plan.note(`plugin ${job.input.entity.name}: members are installed individually`);
  return true;
}

export const PLANNERS: Record<Kind, Planner> = {
  skill: planSkill,
  agent: planAgent,
  instruction: planInstruction,
  command: planCommand,
  hook: planHook,
  mcp: planMcp,
  plugin: planPlugin,
};
