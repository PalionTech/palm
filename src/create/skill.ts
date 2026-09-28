import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PalmContext } from '../core/types.js';
import {
  type CreateOptions,
  finishCreate,
  mineDir,
  openInEditor,
  renderFrontmatterFile,
  titleCase,
  validateSlug,
  writeNewFile,
} from './shared.js';

export const SKILL_DIRS = ['scripts', 'references', 'assets'] as const;
const MAX_DESCRIPTION = 1024;

export function validateSkillDescription(v: string): string | undefined {
  const t = v.trim();
  if (!t) return 'a description is required (it is how agents decide to load the skill)';
  if (t.length > MAX_DESCRIPTION)
    return `keep it under ${MAX_DESCRIPTION} characters (now ${t.length})`;
  return undefined;
}

export function renderSkillFile(a: { name: string; description: string }): string {
  const body = `# ${titleCase(a.name)}

## When to use

Describe the situations and requests this skill is for, and when not to use it.

## Steps

1. First step.
2. Second step.

## Notes

- Gotchas, constraints, and pointers to files in references/ or scripts/.
`;
  return renderFrontmatterFile({ name: a.name, description: a.description.trim() }, body);
}

export async function createSkill(ctx: PalmContext, opts: CreateOptions): Promise<void> {
  const ui = ctx.ui;
  const name = (
    await ui.text('Skill name', {
      initial: opts.name,
      placeholder: 'release-notes',
      validate: validateSlug,
    })
  ).trim();
  const description = (
    await ui.text('Description', {
      placeholder: 'Use when the user asks to … (what it does + when to load it)',
      validate: validateSkillDescription,
    })
  ).trim();
  const dirs = await ui.pickMany(
    'Add optional directories?',
    SKILL_DIRS.map((d) => ({ value: d, label: `${d}/` })),
    [],
  );

  const { mine, dir } = await mineDir(ctx);
  const skillDir = join(dir, 'skills', name);
  const file = join(skillDir, 'SKILL.md');
  if (!(await writeNewFile(ctx, file, renderSkillFile({ name, description })))) return;
  for (const d of dirs) await mkdir(join(skillDir, d), { recursive: true });
  ctx.log.success(`created ${file}`);
  await openInEditor(ctx, file);

  await finishCreate(ctx, { ...opts, kind: 'skill', entityName: name, mine });
}
