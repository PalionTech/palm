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
import { PLACEHOLDER_MARK } from '../index/placeholder-description.js';
import { errnoCode, isEnoent, removeEmptyParents } from '../lib/fs.js';
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

/**
 * The description without `--description` (ruling M21): a marked placeholder (`TODO: describe
 * …`) that `palm check` warns about, since harnesses list it as written. The hook template's
 * text is true as written (it runs at session start), so it is no placeholder.
 */
const DEFAULT_DESCRIPTION: Readonly<Record<CreatableKind, (name: string) => string>> = {
  skill: (n) => `${PLACEHOLDER_MARK} what ${n} does and when the agent should use it.`,
  agent: (n) => `${PLACEHOLDER_MARK} when to hand a task to ${n}.`,
  instruction: (n) => `${PLACEHOLDER_MARK} what ${n} covers.`,
  hook: (n) => `${n}: runs when a session starts.`,
};

/** M21: the warning a create without `--description` prints, naming the file to edit. */
function placeholderWarning(ctx: PalmContext, opts: CreateOptions, file: string): string[] {
  if (opts.description?.trim() || opts.kind === 'hook') return [];
  const inHome = relativeInside(ctx.paths.home, file);
  const home = inHome === undefined ? file : `~/${inHome}`;
  const shown =
    opts.scope === 'global' ? home : (relativeInside(ctx.paths.projectRoot, file) ?? home);
  return [
    `${opts.kind} ${opts.name}: the description is a placeholder (${PLACEHOLDER_MARK} …) that every harness lists; write one in ${shown}, or pass --description`,
  ];
}

/** `abs` relative to `base` with `/` separators, when it lies inside it ('' for `base`). */
function relativeInside(base: string, abs: string): string | undefined {
  const rel = relative(base, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split('\\').join('/');
}

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

/** Creates `abs` with `content`; false when a file is already there (`wx`: no check first). */
async function writeNew(abs: string, content: string): Promise<boolean> {
  try {
    await writeFile(abs, content, { flag: 'wx' });
    return true;
  } catch (e) {
    if (errnoCode(e) === 'EEXIST') return false;
    throw e;
  }
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
    const stop = existingAncestor(abs);
    await mkdir(dirname(abs), { recursive: true });
    if (!(await writeNew(abs, f.content))) continue;
    created.push({ abs, stop });
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

/** How the source directory is typed on a command line: `./agent-kit`, `.`, else its full path. */
function sourceInput(ctx: PalmContext, dir: string): string {
  const rel = relativeInside(ctx.paths.projectRoot, dir);
  if (rel === undefined) return dir;
  return rel === '' ? '.' : `./${rel}`;
}

/** UTF-8 content of `abs`, or undefined when it does not exist (read, not checked first). */
function readTextSyncIfExists(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8');
  } catch (e) {
    if (isEnoent(e)) return undefined;
    throw e;
  }
}

/**
 * E_CONFLICT when a file of the template exists with other content. The same content is a rerun
 * (the install asked for consent without a terminal, and its `then:` line repeats the command).
 */
function refuseExisting(ctx: PalmContext, dir: string, files: TemplateFile[], opts: CreateOptions) {
  const differs = (f: TemplateFile) => {
    const text = readTextSyncIfExists(join(dir, f.rel));
    return text !== undefined && text !== f.content;
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
  /** What the install is asked for: the source key after `name@source`, else the directory. */
  input: string;
}

/** `hotfix@acme` → the name and the declared source it goes into (ruling N8). */
function splitSource(name: string): { name: string; source?: string } {
  const at = name.lastIndexOf('@');
  if (at <= 0 || at === name.length - 1) return { name };
  return { name: name.slice(0, at), source: name.slice(at + 1) };
}

/** E_USAGE for `name@key` where `key` is no declared in-repo source, naming one that is. */
function notInRepoSource(before: ScopeState, key: string, opts: CreateOptions): PalmError {
  const g = opts.scope === 'global' ? ' -g' : '';
  const local = before.sources.all().find((s) => s.isLocal);
  const declared = before.sources.byName(key);
  const why = declared ? `${declared.name} is a git source` : `palm.yaml declares no source ${key}`;
  return new PalmError(
    'E_USAGE',
    `${opts.name}@${key}: ${why}; palm create writes into an in-repo source`,
    local
      ? `palm create ${opts.kind} ${opts.name}@${local.name}${g}`
      : `palm create ${opts.kind} ${opts.name} --in ${g ? '~/.palm/kit' : './agent-kit'}${g}`,
  );
}

/**
 * The directory `name@key` writes into: the declared local source `key` (its root inside it
 * when it has one). `--in` beside it must name the same directory.
 */
function declaredDir(ctx: PalmContext, before: ScopeState, key: string, opts: CreateOptions) {
  const ref = before.sources.byName(key);
  if (!ref?.isLocal || !ref.source.path) throw notInRepoSource(before, key, opts);
  const { path, root } = ref.source;
  const dir = root ? join(path, root) : path;
  if (opts.dir && resolve(sourceDirOf(ctx, opts)) !== resolve(dir))
    throw new PalmError(
      'E_USAGE',
      `--in ${opts.dir} and @${key} name two directories; give one`,
      `palm create ${opts.kind} ${opts.name}@${key}${opts.scope === 'global' ? ' -g' : ''}`,
    );
  return { dir, known: ref };
}

/** J8': the one in-repo source the scope declares, when there is exactly one. */
function onlyLocalSource(before: ScopeState): SourceRef | undefined {
  const local = before.sources.all().filter((s) => s.isLocal && s.source.path);
  return local.length === 1 ? local[0] : undefined;
}

/**
 * The source directory and the declared source it is, from `name@key`, `--in`, else the single
 * in-repo source the scope declares (J8'), else the scope's default directory.
 */
function whereTo(ctx: PalmContext, before: ScopeState, opts: CreateOptions, key?: string) {
  if (key) return declaredDir(ctx, before, key, opts);
  const only = opts.dir ? undefined : onlyLocalSource(before);
  if (only) return declaredDir(ctx, before, only.name, opts);
  const dir = sourceDirOf(ctx, opts);
  const known = before.sources
    .all()
    .find((s) => s.matches(dir) || s.matches(sourceInput(ctx, dir)));
  return { dir, known };
}

/**
 * Every check, before anything is written (dry run and real run alike): the name, `--in` or
 * `@source`, the targets, an overlap with an output directory, the template's place in the
 * source's layout, an existing file and a name the source already indexes.
 */
async function planCreate(
  ctx: PalmContext,
  opts: CreateOptions,
  deps: CliDeps,
  key?: string,
): Promise<Plan> {
  assertName(opts.kind, opts.name);
  const before = await engineOf(deps).openScope(ctx, opts.scope, { readOnly: true });
  const { dir, known } = whereTo(ctx, before, opts, key);
  assertDirAllowed(ctx, dir, opts);
  assertTargets(before);
  const layout = known?.source.layout;
  await assertNoOverlap(ctx, deps, before, { dir, ...(layout ? { layout } : {}) });
  const files = templateFor(opts.kind, opts.name, opts.description, layout);
  refuseExisting(ctx, dir, files, opts);
  const path = entityPathOf(opts.kind, files);
  const input = known?.name ?? sourceInput(ctx, dir);
  await assertNotIndexed(ctx, deps, { ...opts, input, dir, path });
  return { dir, files, before, known, input: key && known ? known.name : dir };
}

/** Install the template's entity; a run that installs nothing takes the template back. */
async function installTemplate(
  ctx: PalmContext,
  opts: CreateOptions,
  deps: CliDeps,
  plan: Plan,
): Promise<{ result: InstallResult; kept: boolean }> {
  const created = await writeTemplate(plan.dir, plan.files);
  const req = { source: plan.input, names: [{ kind: opts.kind, name: opts.name }] };
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
 * `name@source` writes into that declared in-repo source (N8); without `--description` the
 * template's placeholder description comes with a warning (M21).
 */
export async function createEntity(
  ctx: PalmContext,
  options: CreateOptions,
  deps: CliDeps = {},
): Promise<CreateResult> {
  const { name, source: key } = splitSource(options.name);
  const opts = { ...options, name };
  const plan = await planCreate(ctx, opts, deps, key);
  const { dir, before, known } = plan;
  const written = plan.files.map((f) => join(dir, f.rel));
  const base = { dir, file: written[0] ?? dir, files: written, before };
  const placeholder = placeholderWarning(ctx, opts, base.file);
  if (ctx.flags.dryRun) {
    const result = { ...EMPTY, warnings: placeholder };
    return { ...base, declared: !known, result, after: before };
  }
  const installed = await installTemplate(ctx, opts, deps, plan);
  const warnings = [...installed.result.warnings, ...(installed.kept ? placeholder : [])];
  const result = { ...installed.result, warnings };
  const after = await engineOf(deps).openScope(ctx, opts.scope, { readOnly: true });
  const source = after.sources.all().find((s) => s.matches(plan.input));
  const declared = !known && source !== undefined;
  const files = installed.kept ? written : [];
  return { ...base, files, declared, result, after, ...(source ? { source } : {}) };
}
