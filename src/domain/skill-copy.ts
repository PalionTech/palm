/**
 * What a skill directory copy leaves out, and how big a skill may be before it needs `--force`
 * (DESIGN.md section 2 "Safety rules", ruling Y2). A root `SKILL.md` makes a whole repository
 * the skill; its harness configs, palm's files and environment files must never land inside
 * `.claude/skills/<name>/`. The index scans exactly these files for secrets and hidden Unicode,
 * the targets copy exactly these files, and the content hash should walk the same list.
 */
import { COPY_SKIP, matchesSkip } from './ignore.js';

/**
 * Entry names never copied into a skill, at any depth: the copy skip list, harness directories
 * and config files, harness instruction files, palm's own files and environment files.
 */
const SKILL_COPY_SKIP: readonly string[] = [
  ...COPY_SKIP,
  '.agents',
  '.apm',
  '.claude',
  '.codex',
  '.cursor',
  '.gemini',
  '.github',
  '.opencode',
  '.vscode',
  '.mcp.json',
  'opencode.json',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.palm',
  'palm.yaml',
  'palm.lock.yaml',
  'palm.local.yaml',
  '.env',
  '.env.*',
];

/** A skill above this many files needs `--force`. */
export const SKILL_MAX_FILES = 200;
/** A skill above this many bytes needs `--force` (5 MB). */
export const SKILL_MAX_BYTES = 5 * 1024 * 1024;

/** True for an entry name a skill copy leaves out (`SKILL_COPY_SKIP`). */
export function isSkillCopySkipped(name: string): boolean {
  return matchesSkip(SKILL_COPY_SKIP, name);
}

/** True for a name left out beyond the plain copy skip list (worth a note naming it). */
export function isHarnessOrPalmFile(name: string): boolean {
  return isSkillCopySkipped(name) && !matchesSkip(COPY_SKIP, name);
}
