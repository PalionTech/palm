/**
 * Where one read of a closure script lands (rulings E1, Sofia S3): inside the source (a read
 * the closure carries), inside the worktree of an in-place source (hashed where it lies, a
 * source-relative path that may start with `../`), or nowhere palm can place (reported).
 */
import { stat } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { isWithin, toPosix } from '../lib/fs.js';

/** The directory a read marker names when it stands for the project root. */
export const PROJECT_MARK = '\u0003';

/** A read palm could not follow: the script, the text as written and why. */
export interface UnresolvedRead {
  script: string;
  raw: string;
  why: string;
  /** The hook command runs the file rather than a script reading it (O10). */
  runs?: boolean;
}

export interface Placing {
  sourceRoot: string;
  /** The script (or hooks file) the read is in, source-relative. */
  script: string;
  found: { reads: string[]; unresolved: UnresolvedRead[] };
  /** In-place sources: the worktree root reads may reach. */
  worktree?: string;
}

interface ReadForm {
  /** A form that surely reads a file (a marked directory): what palm cannot place is reported. */
  strict: boolean;
  runs?: boolean;
}

async function kindOf(abs: string): Promise<'file' | 'dir' | undefined> {
  const st = await stat(abs).catch(() => undefined);
  if (!st) return undefined;
  return st.isDirectory() ? 'dir' : 'file';
}

function miss(job: Placing, raw: string, why: string, form: ReadForm): void {
  if (!form.strict) return;
  const u: UnresolvedRead = { script: job.script, raw, why };
  if (form.runs) u.runs = true;
  job.found.unresolved.push(u);
}

/** A read outside the source: hashed in place inside the worktree, else reported. */
async function outside(job: Placing, abs: string, raw: string, form: ReadForm): Promise<void> {
  const { worktree } = job;
  if (worktree === undefined || !isWithin(abs, worktree))
    return miss(job, raw, 'outside the source', form);
  const kind = await kindOf(abs);
  if (kind === 'file') job.found.reads.push(toPosix(relative(job.sourceRoot, abs)));
  else if (kind === 'dir') miss(job, raw, 'a directory outside the source', form);
  else miss(job, raw, 'which is not in the project', form);
}

/**
 * Places `rel`: source-relative, or `PROJECT_MARK` + project-relative. A project path of a git
 * source is the project's own file, never part of what the source ships: nothing to place.
 */
export async function placeRead(job: Placing, rel: string, form: ReadForm): Promise<void> {
  const project = rel.startsWith(PROJECT_MARK);
  if (project && job.worktree === undefined) return;
  const tail = project ? rel.slice(PROJECT_MARK.length) : rel;
  const abs = join(project ? (job.worktree as string) : job.sourceRoot, ...tail.split('/'));
  const raw = project ? posix.normalize(tail) : rel;
  if (!isWithin(abs, job.sourceRoot)) return outside(job, abs, raw, form);
  if (await kindOf(abs)) job.found.reads.push(toPosix(relative(job.sourceRoot, abs)));
  else miss(job, raw, 'which is not in the source', form);
}
