/**
 * The project's ignore lines (DESIGN §2): `.palm/local/` and `palm.local.yaml` are the only
 * ignored palm paths. A 0.1 `.palm/` line would hide `.palm/assets/` from teammates, so it is
 * replaced by `.palm/local/`.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/fs.js';

const IGNORE_LINES = ['.palm/local/', 'palm.local.yaml'] as const;

const LEGACY_LINES = new Set(['.palm', '.palm/', '/.palm', '/.palm/']);

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** The new text of `.gitignore`, or undefined when it already has both lines and no `.palm/`. */
function ignoreText(text: string | undefined): string | undefined {
  const lines = (text ?? '').split('\n');
  const legacy = lines.some((l) => LEGACY_LINES.has(l.trim()));
  const kept = lines.filter((l) => !LEGACY_LINES.has(l.trim()));
  const missing = IGNORE_LINES.filter((l) => !kept.some((k) => k.trim() === l));
  if (!legacy && missing.length === 0) return undefined;
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return `${[...kept, ...missing].join('\n')}\n`;
}

/**
 * Adds the ignore lines to `<root>/.gitignore` once (and replaces a `.palm/` line). Returns the
 * info line to print, or undefined when nothing changed.
 */
export async function ensureIgnoreLines(
  root: string,
  dryRun: boolean,
): Promise<string | undefined> {
  const file = join(root, '.gitignore');
  const before = await readText(file);
  const after = ignoreText(before);
  if (after === undefined) return undefined;
  if (!dryRun) await writeFileAtomic(file, after);
  const legacy = before?.split('\n').some((l) => LEGACY_LINES.has(l.trim()));
  return legacy
    ? '.gitignore: .palm/ is now .palm/local/, so .palm/assets/ is committed'
    : `.gitignore: added ${IGNORE_LINES.join(' and ')}`;
}
