/**
 * `palm create <kind> <name> [--in dir] [--description text]` (alias `new`): write a template
 * into the project's own source and install it (src/create/templates.ts). No prompts.
 */
import type { PalmContext } from '../core/types.js';
import {
  CREATABLE,
  type CreatableKind,
  type CreateResult,
  createEntity,
} from '../create/templates.js';
import type { App } from './app.js';
import { type Invocation, usage } from './grammar.js';
import { isCommandWord } from './ports.js';
import { reportInstall } from './report.js';
import { displayPath, type GlobalOptions, makeContext, scopeOf } from './shared.js';

interface CreateFlags extends GlobalOptions {
  in?: string;
  description?: string;
}

function kindOf(inv: Invocation, name: string): CreatableKind {
  const word = inv.words?.[0] ?? '';
  if (isCommandWord(word))
    throw usage(
      'a command installs as a skill; palm create writes skills',
      `palm create skill ${name}`,
    );
  const kind = CREATABLE.find((k) => k === inv.resource);
  if (!kind)
    throw usage(
      `palm create writes a skill, agent, instruction or hook, not "${word}"`,
      `palm create skill ${name}`,
    );
  return kind;
}

function printCreated(app: App, ctx: PalmContext, created: CreateResult): void {
  const out = app.out;
  const dry = ctx.flags.dryRun;
  for (const f of created.files)
    out.mark('+', `${dry ? 'would write' : 'wrote'} ${displayPath(ctx, f)}`);
  if (created.declared && created.source)
    out.mark('+', `source ${created.source.name} → palm.yaml`);
  if (created.declared && dry)
    out.mark('+', `would declare ${displayPath(ctx, created.dir)} in palm.yaml`);
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const flags = inv.opts as CreateFlags;
  const name = inv.names[0]?.name ?? '';
  const kind = kindOf(inv, name || 'release-notes');
  const ctx = await makeContext(app, flags);
  const opts = { kind, name, scope: scopeOf(flags), ...(flags.in ? { dir: flags.in } : {}) };
  const created = await createEntity(ctx, { ...opts, description: flags.description }, app.deps);
  const { files, declared, result } = created;
  const json = { files, source: created.source?.name, declared, ...result };
  if (!app.out.jsonMode) printCreated(app, ctx, created);
  await reportInstall(ctx, app, result, { before: created.before, after: created.after, json });
  if (!app.out.jsonMode && !ctx.flags.dryRun)
    app.out.hint(`edit ${displayPath(ctx, created.file)}; palm install renders the change`);
}
