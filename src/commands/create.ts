import type { Command } from 'commander';
import { PalmError } from '../core/errors.js';
import type { Kind } from '../core/types.js';
import {
  type GlobalOptions,
  makeContext,
  parseTargetList,
  requireKind,
  scopeOf,
} from './shared.js';

const CREATABLE: readonly Kind[] = ['agent', 'skill', 'instruction', 'command'];

interface CreateCliOptions extends GlobalOptions {
  install?: boolean;
}

export function registerCreate(program: Command): void {
  program
    .command('create')
    .alias('new')
    .summary('write a new agent, skill, instruction or command, then install it')
    .description(
      'Interactive wizard that writes a new entity into your local "mine" origin, then offers to install it.',
    )
    .argument('<kind>', CREATABLE.join(' | '))
    .argument('[name]', 'slug for the new entity')
    .option('--no-install', 'only write the file; do not install it')
    .action(async (kindArg: string, name: string | undefined, _opts: unknown, cmd: Command) => {
      const o = cmd.optsWithGlobals<CreateCliOptions>();
      const kind = requireKind(kindArg, CREATABLE);
      const targets = parseTargetList(o.target);
      const ctx = await makeContext(o);
      if (!ctx.ui.isInteractive) {
        throw new PalmError(
          'E_NON_INTERACTIVE',
          `palm create ${kind} is an interactive wizard and needs a terminal`,
          `write the file into ${ctx.paths.palmHome}/mine/ yourself, then run palm install ${kind} <name>@mine`,
        );
      }
      const opts = {
        name,
        scope: scopeOf(o),
        install: o.install === false ? false : undefined,
        targets,
      };
      switch (kind) {
        case 'agent': {
          const { createAgent } = await import('../create/agent.js');
          return createAgent(ctx, opts);
        }
        case 'skill': {
          const { createSkill } = await import('../create/skill.js');
          return createSkill(ctx, opts);
        }
        case 'instruction': {
          const { createInstruction } = await import('../create/instruction.js');
          return createInstruction(ctx, opts);
        }
        default: {
          const { createCommand } = await import('../create/command.js');
          return createCommand(ctx, opts);
        }
      }
    });
}
