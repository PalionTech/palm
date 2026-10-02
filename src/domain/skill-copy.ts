/**
 * What a skill directory copy leaves out, and how big a skill may be before it needs `--force`
 * (DESIGN.md section 2 "Safety rules", rulings Y2, X1 and T2). A root `SKILL.md` makes a whole
 * repository the skill; its harness directories, palm's files and environment files must never
 * land inside `.claude/skills/<name>/`. A skill's own `AGENTS.md`, `CLAUDE.md` or `GEMINI.md` is
 * skill content (skills point at them) and is copied. Tests and fixtures stay in the source.
 * The index scans exactly these files for secrets and hidden Unicode, the targets copy exactly
 * these files, and the content hash walks the same list.
 */
import { COPY_SKIP, matchesSkip } from './ignore.js';

/**
 * Entry names never copied into a skill, at any depth, beyond the copy skip list: harness
 * directories, palm's own files and environment files (ruling X1).
 */
const HARNESS_PALM_ENV: readonly string[] = [
  '.agents',
  '.apm',
  '.claude',
  '.codex',
  '.cursor',
  '.gemini',
  '.github',
  '.opencode',
  '.vscode',
  '.palm',
  'palm.yaml',
  'palm.lock.yaml',
  'palm.local.yaml',
  '.env',
  '.env.*',
];

/** Test directories a skill copy leaves out at any depth (ruling T2); `*.test.*` files too. */
const TEST_DIRS: readonly string[] = ['tests', 'test', 'fixtures', '__tests__'];

/** A skill above this many files needs `--force`. */
export const SKILL_MAX_FILES = 200;
/** A skill above this many bytes needs `--force` (5 MB). */
export const SKILL_MAX_BYTES = 5 * 1024 * 1024;

/** True for a test directory or a `*.test.*` file (ruling T2). */
function isTestEntry(name: string): boolean {
  return matchesSkip(TEST_DIRS, name) || /\.test\./i.test(name);
}

/** True for an entry name a skill copy leaves out, at any depth. */
export function isSkillCopySkipped(name: string): boolean {
  return matchesSkip(COPY_SKIP, name) || skillLeftOutReason(name) !== undefined;
}

/** Why a copy leaves `name` out, for the note naming it; undefined when the plain skip list does. */
export function skillLeftOutReason(name: string): 'harness' | 'test' | undefined {
  if (matchesSkip(COPY_SKIP, name)) return undefined;
  if (matchesSkip(HARNESS_PALM_ENV, name)) return 'harness';
  return isTestEntry(name) ? 'test' : undefined;
}
