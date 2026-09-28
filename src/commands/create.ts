/** `palm create <kind> [name]` (alias `new`): the authoring wizards of src/create. */
import { PalmError } from '../core/errors.js';
import type { Kind, PalmContext } from '../core/types.js';
import type { CreateOptions } from '../create/shared.js';
import type { App } from './app.js';
import { CREATABLE, type Invocation, usage } from './grammar.js';
import { entityKind, type GlobalOptions, makeContext, parseTargetList, scopeOf } from './shared.js';

interface CreateCliOptions extends GlobalOptions {
  install?: boolean;
}

async function wizard(
  kind: Kind,
): Promise<(ctx: PalmContext, opts: CreateOptions) => Promise<void>> {
  switch (kind) {
    case 'agent':
      return (await import('../create/agent.js')).createAgent;
    case 'skill':
      return (await import('../create/skill.js')).createSkill;
    case 'instruction':
      return (await import('../create/instruction.js')).createInstruction;
    default:
      return (await import('../create/command.js')).createCommand;
  }
}

export async function run(inv: Invocation, app: App): Promise<void> {
  const o = inv.opts as CreateCliOptions;
  const kind = entityKind(inv.resource, 'create');
  if (!kind || !CREATABLE.includes(kind))
    throw usage(`palm create makes ${CREATABLE.join(', ')}`, 'palm create skill [name]');
  if (inv.names.length > 1)
    throw usage(`create one ${kind} at a time`, `palm create ${kind} ${inv.names[0]}`);
  const targets = parseTargetList(o.target);
  const ctx = await makeContext(app, o);
  if (!ctx.ui.isInteractive)
    throw new PalmError(
      'E_NON_INTERACTIVE',
      `palm create ${kind} is an interactive wizard and needs a terminal`,
      `write the file into ${ctx.paths.palmHome}/mine/ yourself, then run: palm install ${kind} <name>@mine`,
    );
  const create = await wizard(kind);
  await create(ctx, {
    name: inv.names[0],
    scope: scopeOf(o),
    install: o.install === false ? false : undefined,
    targets,
  });
}
