/**
 * `palm create` as a template writer (DESIGN.md §10, PLAN.md §4.4): write a skill, agent,
 * instruction or hook into the project's in-repo source (`./agent-kit`, or `~/.palm/kit` under
 * `-g`), declare that source in palm.yaml when it is new, and install the entity. No prompts,
 * no editor; an existing file is `E_CONFLICT`.
 *
 * Everything that can refuse is checked before a byte is written (checks.ts), the template lands
 * where the source's layout indexes it (place.ts), and a run that installs nothing takes its
 * template back, so a failed or declined create leaves the source as it was (rulings K13, B6,
 * J6, C27).
 */
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { PalmError } from '../core/errors.js';
import type { InstallResult, LayoutDescriptor, PalmContext, Scope } from '../core/types.js';
import { removeEmptyParents } from '../lib/fs.js';
import {
  assertDirAllowed,
  assertName,
  assertNoOverlap,
  assertNotIndexed,
  assertTargets,
} from './checks.js';
import { type CliDeps, engineDepsOf, engineOf, type ScopeState, type SourceRef } from './engine.js';
import { placeMainFile } from './place.js';

export type CreatableKind = 'skill' | 'agent' | 'instruction' | 'hook';

export const CREATABLE: readonly CreatableKind[] = ['skill', 'agent', 'instruction', 'hook'];

export interface CreateOptions {
  kind: CreatableKind;
  name: string;
  /** The source directory (default `./agent-kit`; `~/.palm/kit` under `-g`). */
  dir?: string;
  description?: string;
  scope: Scope;
}

export interface TemplateFile {
  /** Path inside the source directory. */
  rel: string;
  content: string;
  mode?: number;
}

export interface CreateResult {
  /** The source directory (absolute). */
  dir: string;
  /** The main file written (absolute). */
  file: string;
  /** Every file written (absolute). */
  files: string[];
  /** The source the entity was installed from (absent after a dry run or a failed install). */
  source?: SourceRef;
  /** True when this call declared the source in palm.yaml. */
  declared: boolean;
  result: InstallResult;
  before: ScopeState;
  after: ScopeState;
}

const NEEDS_QUOTES = /[:#"'\\[\]{}]|^[\s\-?!&*|>%@`]|\s$/;

/** A YAML scalar: plain when it can be, else double-quoted. */
function yamlValue(text: string): string {
  return NEEDS_QUOTES.test(text) ? JSON.stringify(text) : text;
}

function titleOf(name: string): string {
  const words = name.replace(/[-_.]+/g, ' ').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function frontmatter(fields: Array<[string, string]>): string {
  return ['---', ...fields.map(([k, v]) => `${k}: ${yamlValue(v)}`), '---', ''].join('\n');
}

function skillMd(name: string, description: string): string {
  return `${frontmatter([
    ['name', name],
    ['description', description],
  ])}
# ${titleOf(name)}

Write the steps the agent follows when this skill applies.
`;
}

function agentMd(name: string, description: string): string {
  return `${frontmatter([
    ['name', name],
    ['description', description],
  ])}
You are ${titleOf(name)}. Describe the role, the steps to take and what to report back.
`;
}

/** An always-on instruction; a Cursor `.mdc` says so with `alwaysApply: true`. */
function instructionMd(name: string, description: string, mdc: boolean): string {
  const fields: Array<[string, string]> = [['description', description]];
  if (mdc) fields.push(['alwaysApply', 'true']);
  return `${frontmatter(fields)}
# ${titleOf(name)}

Write the rules the agent follows in this project.
`;
}

/**
 * The directory the index takes as a hooks file's plugin root: the owner of a `hooks/` folder
 * holding `hooks.json`, else the file's own directory (index exec-adders `hookIdentity`).
 */
function hookRootOf(file: string): string {
  const dir = posix.dirname(file);
  return posix.basename(file) === 'hooks.json' && posix.basename(dir) === 'hooks'
    ? posix.dirname(dir)
    : dir;
}

/** `hooks/<name>/hooks.json` with one SessionStart command, and the script it runs (mode 755). */
function hookFiles(name: string, description: string, file: string): TemplateFile[] {
  const script = posix.join(posix.dirname(file), 'scripts', `${name}.sh`);
  // The command names the script from the plugin root the index gives the hooks file.
  const fromRoot = posix.relative(hookRootOf(file), script);
  const command = `bash "\${CLAUDE_PLUGIN_ROOT}/${fromRoot}"`;
  const hooks = {
    description,
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] },
  };
  const body = `#!/usr/bin/env bash
# ${name}: runs when a Claude Code session starts. What it prints reaches the agent.
set -euo pipefail
echo "${name}: session started"
`;
  return [
    { rel: file, content: `${JSON.stringify(hooks, null, 2)}\n` },
    { rel: script, content: body, mode: 0o755 },
  ];
}

const DEFAULT_DESCRIPTION: Readonly<Record<CreatableKind, (name: string) => string>> = {
  skill: (n) => `Describe what ${n} does and when the agent should use it.`,
  agent: (n) => `Describe when to hand a task to ${n}.`,
  instruction: (n) => `Describe what ${n} covers.`,
  hook: (n) => `${n}: runs when a session starts.`,
};

/**
 * The files a template writes, paths relative to the source directory: the main file where the
 * source's layout indexes the kind (the convention path without a layout), then the others.
 */
export function templateFor(
  kind: CreatableKind,
  name: string,
  description?: string,
  layout?: LayoutDescriptor,
): TemplateFile[] {
  const text = description?.trim() || DEFAULT_DESCRIPTION[kind](name);
  const main = placeMainFile(kind, name, layout);
  if (kind === 'skill') return [{ rel: main, content: skillMd(name, text) }];
  if (kind === 'agent') return [{ rel: main, content: agentMd(name, text) }];
  if (kind === 'instruction')
    return [{ rel: main, content: instructionMd(name, text, main.endsWith('.mdc')) }];
  return hookFiles(name, text, main);
}

/** The index path of the template's entity: a skill's directory, else its main file. */
function entityPathOf(kind: CreatableKind, files: readonly TemplateFile[]): string {
  const main = files[0]?.rel ?? '';
  return kind === 'skill' ? posix.dirname(main) : main;
}

/** The source directory: `--in` (from the cwd; `~/` is home), else the scope's default. */
function sourceDirOf(ctx: PalmContext, opts: Pick<CreateOptions, 'dir' | 'scope'>): string {
  if (opts.dir) {
    const dir = opts.dir.startsWith('~/') ? join(ctx.paths.home, opts.dir.slice(2)) : opts.dir;
    return resolve(ctx.paths.cwd, dir);
  }
  if (opts.scope === 'global') return join(ctx.paths.palmHome, 'kit');
  return join(ctx.paths.projectRoot, 'agent-kit');
}

/** The nearest directory above `abs` that exists: where a rollback stops pruning. */
function existingAncestor(abs: string): string {
  let dir = dirname(abs);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/**
 * Writes each file of the template; one already there (with the same content, see
 * refuseExisting) stays. Returns what it created, with the directory each rollback stops at.
 */
async function writeTemplate(
  dir: string,
  files: TemplateFile[],
): Promise<Array<{ abs: string; stop: string }>> {
  const created: Array<{ abs: string; stop: string }> = [];
  for (const f of files) {
    const abs = join(dir, f.rel);
    if (existsSync(abs)) continue;
    created.push({ abs, stop: existingAncestor(abs) });
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content, { flag: 'wx' });
    if (f.mode !== undefined) await chmod(abs, f.mode);
  }
  return created;
}

/** Takes a template back: the files it created and the directories it made for them. */
async function removeTemplate(created: ReadonlyArray<{ abs: string; stop: string }>) {
  for (const c of [...created].reverse()) {
    await rm(c.abs, { force: true });
    await removeEmptyParents(c.abs, c.stop);
  }
}

/** Statuses that leave the entity installed. */
const INSTALLED = new Set([
  'installed',
  'updated',
  're-rendered',
  'restored',
  'unchanged',
  'partial',
]);

function installedAny(result: InstallResult): boolean {
  return result.outcomes.some((o) => INSTALLED.has(o.status));
}

/** How the source directory is typed on a command line: `./agent-kit`, else its full path. */
function sourceInput(ctx: PalmContext, dir: string): string {
  const rel = relative(ctx.paths.projectRoot, dir);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? `./${rel.split('\\').join('/')}` : dir;
}

/**
 * E_CONFLICT when a file of the template exists with other content. The same content is a rerun
 * (the install asked for consent without a terminal, and its `then:` line repeats the command).
 */
function refuseExisting(ctx: PalmContext, dir: string, files: TemplateFile[], opts: CreateOptions) {
  const differs = (f: TemplateFile) => {
    const abs = join(dir, f.rel);
    return existsSync(abs) && readFileSync(abs, 'utf8') !== f.content;
  };
  const taken = files.find(differs);
  if (!taken) return;
  throw new PalmError(
    'E_CONFLICT',
    `${join(dir, taken.rel)} exists; palm create never overwrites a file`,
    `install the one that is there: palm install ${sourceInput(ctx, dir)} ${opts.kind}:${opts.name}`,
  );
}

const EMPTY: InstallResult = { outcomes: [], failures: [], warnings: [] };

interface Plan {
  dir: string;
  files: TemplateFile[];
  before: ScopeState;
  known: SourceRef | undefined;
}

/**
 * Every check, before anything is written (dry run and real run alike): the name, `--in`, the
 * targets, an overlap with an output directory, the template's place in the source's layout, an
 * existing file and a name the source already indexes.
 */
async function planCreate(ctx: PalmContext, opts: CreateOptions, deps: CliDeps): Promise<Plan> {
  assertName(opts.kind, opts.name);
  const dir = sourceDirOf(ctx, opts);
  assertDirAllowed(ctx, dir, opts);
  const before = await engineOf(deps).openScope(ctx, opts.scope, { readOnly: true });
  assertTargets(before);
  await assertNoOverlap(ctx, deps, before, dir);
  const known = before.sources
    .all()
    .find((s) => s.matches(dir) || s.matches(sourceInput(ctx, dir)));
  const files = templateFor(opts.kind, opts.name, opts.description, known?.source.layout);
  refuseExisting(ctx, dir, files, opts);
  const path = entityPathOf(opts.kind, files);
  const input = known?.name ?? sourceInput(ctx, dir);
  await assertNotIndexed(ctx, deps, { ...opts, input, dir, path });
  return { dir, files, before, known };
}

/** Install the template's entity; a run that installs nothing takes the template back. */
async function installTemplate(
  ctx: PalmContext,
  opts: CreateOptions,
  deps: CliDeps,
  plan: Plan,
): Promise<{ result: InstallResult; kept: boolean }> {
  const created = await writeTemplate(plan.dir, plan.files);
  const req = { source: plan.dir, names: [{ kind: opts.kind, name: opts.name }] };
  const api = engineOf(deps);
  try {
    const result = await api.installFromSource(ctx, req, { scope: opts.scope }, engineDepsOf(deps));
    if (installedAny(result)) return { result, kept: true };
    await removeTemplate(created);
    return { result, kept: false };
  } catch (e) {
    await removeTemplate(created);
    throw e;
  }
}

/**
 * Check everything, write the template, then install the entity from its source, which declares
 * the source in palm.yaml when it is not there yet. Nothing installed: nothing stays written.
 */
export async function createEntity(
  ctx: PalmContext,
  opts: CreateOptions,
  deps: CliDeps = {},
): Promise<CreateResult> {
  const plan = await planCreate(ctx, opts, deps);
  const { dir, before, known } = plan;
  const written = plan.files.map((f) => join(dir, f.rel));
  const base = { dir, file: written[0] ?? dir, files: written, before };
  if (ctx.flags.dryRun) return { ...base, declared: !known, result: EMPTY, after: before };
  const { result, kept } = await installTemplate(ctx, opts, deps, plan);
  const after = await engineOf(deps).openScope(ctx, opts.scope, { readOnly: true });
  const source = after.sources.all().find((s) => s.matches(dir));
  const declared = !known && source !== undefined;
  const files = kept ? written : [];
  return { ...base, files, declared, result, after, ...(source ? { source } : {}) };
}
