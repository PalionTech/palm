/**
 * `palm create <kind> <name> [--in dir] [--description text]` (alias `new`): write a template
 * into the project's own source and install it (src/create/templates.ts). No prompts.
 */

import { PalmError } from '../core/errors.js';
import { isCommandWord } from '../core/kinds.js';
import type { InstallResult, PalmContext, Scope } from '../core/types.js';
import {
  CREATABLE,
  type CreatableKind,
  type CreateResult,
  createEntity,
} from '../create/templates.js';
import { sourceLabel } from '../ui/format.js';
import type { App } from './app.js';
import { type Invocation, usage } from './grammar.js';
import { manifestFile, palmLine, pasteLine, typedOptions } from './hints.js';
import { reportInstall } from './report.js';
import { displayPath, type GlobalOptions, makeContext, scopeOf } from './shared.js';

interface CreateFlags extends GlobalOptions {
  in?: string;
  description?: string;
}

function kindOf(inv: Invocation, name: string): CreatableKind {
  const word = inv.words?.[0] ?? '';
  const line = palmLine('create', ['skill', name], scopeOf(inv.opts as GlobalOptions));
  if (isCommandWord(word)) throw usage('a command installs as a skill; create writes skills', line);
  const kind = CREATABLE.find((k) => k === inv.resource);
  if (!kind) throw usage(`create writes a skill, agent, instruction or hook, not "${word}"`, line);
  return kind;
}

function printCreated(app: App, ctx: PalmContext, created: CreateResult, scope: Scope): void {
  const out = app.out;
  const dry = ctx.flags.dryRun;
  const file = manifestFile(scope);
  for (const f of created.files)
    out.mark('+', `${dry ? 'would write' : 'wrote'} ${displayPath(ctx, f, scope)}`);
  if (created.declared && created.source) out.mark('+', `source ${created.source.name} → ${file}`);
  if (created.declared && dry)
    out.mark('+', `would declare ${displayPath(ctx, created.dir, scope)} in ${file}`);
}

interface Job {
  kind: CreatableKind;
  name: string;
  scope: Scope;
}

/** `pick another name: palm create <kind> <name>-local …` with the options as typed. */
function anotherName(app: App, job: Job): string {
  const words = [job.kind, `${job.name}-local`];
  return `pick another name: ${pasteLine('create', words, typedOptions(app.argv), job.scope)}`;
}

/**
 * N5: a dry run refuses a name another entry of the scope already has, as the real run does,
 * before it says it would write anything.
 */
function refuseTaken(app: App, created: CreateResult, job: Job): void {
  const lower = job.name.toLowerCase();
  const owner = created.before.lock.entries.find(
    (e) => e.kind === job.kind && e.name.toLowerCase() === lower,
  );
  if (!owner) return;
  const what = `${job.kind} ${job.name}`;
  throw new PalmError(
    'E_CONFLICT',
    `${what} is already installed from ${sourceLabel(owner.source)}; a scope holds one ${what}`,
    anotherName(app, job),
  );
}

/** O17, R2': the real run's name clash offers another name, never a remove that loses an edit. */
function withAnotherName(app: App, result: InstallResult, job: Job): InstallResult {
  const failures = result.failures.map((f) =>
    f.code === 'E_CONFLICT' && f.kind === job.kind && /is already installed from/.test(f.message)
      ? { ...f, hint: anotherName(app, job) }
      : f,
  );
  return { ...result, failures };
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as CreateFlags;
  const name = inv.names[0]?.name ?? '';
  const kind = kindOf(inv, name || 'release-notes');
  const ctx = await makeContext(app, flags);
  const opts = { kind, name, scope: scopeOf(flags), ...(flags.in ? { dir: flags.in } : {}) };
  const created = await createEntity(ctx, { ...opts, description: flags.description }, app.deps);
  if (ctx.flags.dryRun) refuseTaken(app, created, opts);
  const { files, declared } = created;
  const result = withAnotherName(app, created.result, opts);
  const json = { files, source: created.source?.name, declared, ...result };
  if (!app.out.jsonMode) printCreated(app, ctx, created, opts.scope);
  const alsoCommit = [`${displayPath(ctx, created.dir)}/`];
  const { before, after } = created;
  const explicit = [{ kind, name }];
  await reportInstall(ctx, app, result, { before, after, json, alsoCommit, explicit });
  if (!app.out.jsonMode && !ctx.flags.dryRun) {
    const install = palmLine('install', [], opts.scope);
    app.out.hint(`edit ${displayPath(ctx, created.file, opts.scope)}, then run: ${install}`);
  }
}
