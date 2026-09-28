import { join } from 'node:path';
import type { PalmContext } from '../core/types.js';
import {
  type CreateOptions,
  editBody,
  finishCreate,
  mineDir,
  renderFrontmatterFile,
  validateSlug,
  writeNewFile,
} from './shared.js';

export interface InstructionAnswers {
  description?: string;
  globs: string[];
  alwaysApply: boolean;
  body: string;
}

export function parseGlobList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Frontmatter: description, `paths` when globs are given, and `alwaysApply` only when it differs
 * from what the globs imply (no globs → always on; globs → path-scoped).
 */
export function renderInstructionFile(a: InstructionAnswers): string {
  const impliedAlways = a.globs.length === 0;
  return renderFrontmatterFile(
    {
      description: a.description?.trim() || undefined,
      paths: a.globs.length ? a.globs : undefined,
      alwaysApply: a.alwaysApply === impliedAlways ? undefined : a.alwaysApply,
    },
    a.body,
  );
}

function instructionTemplate(name: string): string {
  return `<!--
  Instruction "${name}". Write the guidance agents should follow, as short imperative rules.
  Everything inside HTML comments is removed. Save and close the editor to continue.
-->

`;
}

export async function createInstruction(ctx: PalmContext, opts: CreateOptions): Promise<void> {
  const ui = ctx.ui;
  const name = (
    await ui.text('Instruction name', {
      initial: opts.name,
      placeholder: 'typescript-style',
      validate: validateSlug,
    })
  ).trim();
  const description = (
    await ui.text('Description (optional)', {
      placeholder: 'TypeScript conventions for this codebase',
    })
  ).trim();
  const globs = parseGlobList(
    await ui.text('Apply to paths (comma-separated globs, empty = everywhere)', {
      placeholder: 'src/**/*.ts, test/**/*.ts',
    }),
  );
  const alwaysApply = await ui.confirm(
    globs.length
      ? 'Also load it for every request, regardless of paths?'
      : 'Always load it into context?',
    globs.length === 0,
  );
  const body = await editBody(ctx, {
    template: instructionTemplate(name),
    message: 'Instruction text (Enter twice or tab to submit)',
    placeholder: '- Prefer …',
  });

  const { mine, dir } = await mineDir(ctx);
  const file = join(dir, 'instructions', `${name}.md`);
  if (
    !(await writeNewFile(
      ctx,
      file,
      renderInstructionFile({ description, globs, alwaysApply, body }),
    ))
  )
    return;
  ctx.log.success(`created ${file}`);
  await finishCreate(ctx, { ...opts, kind: 'instruction', entityName: name, mine });
}
