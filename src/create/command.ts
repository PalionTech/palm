import { join } from 'node:path';
import type { PalmContext } from '../core/types.js';
import { editBody, finishCreate, mineDir, renderFrontmatterFile, required, validateSlug, writeNewFile, type CreateOptions } from './shared.js';

export function renderCommandFile(a: { description: string; argumentHint?: string; body: string }): string {
  return renderFrontmatterFile({ description: a.description.trim(), 'argument-hint': a.argumentHint?.trim() || undefined }, a.body);
}

function commandTemplate(name: string): string {
  return `<!--
  Prompt for /${name}. $ARGUMENTS is replaced with everything typed after the command;
  $1, $2 … with individual arguments. Everything inside HTML comments is removed.
-->

$ARGUMENTS
`;
}

export async function createCommand(ctx: PalmContext, opts: CreateOptions): Promise<void> {
  const ui = ctx.ui;
  const name = (await ui.text('Command name (used as /name)', { initial: opts.name, placeholder: 'fix-issue', validate: validateSlug })).trim();
  const description = (await ui.text('Description', { placeholder: 'Fix a GitHub issue by number', validate: required('a description') })).trim();
  const argumentHint = (await ui.text('Argument hint (optional)', { placeholder: '[issue-number]' })).trim();
  const body = await editBody(ctx, { template: commandTemplate(name), message: 'Prompt text (Enter twice or tab to submit)', placeholder: 'Fix issue $ARGUMENTS …' });

  const { mine, dir } = await mineDir(ctx);
  const file = join(dir, 'commands', `${name}.md`);
  if (!(await writeNewFile(ctx, file, renderCommandFile({ description, argumentHint, body })))) return;
  ctx.log.success(`created ${file}`);
  await finishCreate(ctx, { ...opts, kind: 'command', entityName: name, mine });
}
