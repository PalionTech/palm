import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PalmError } from './errors.js';

async function listFiles(dir: string, rel: string, out: string[]): Promise<void> {
  const entries = await readdir(join(dir, rel), { withFileTypes: true });
  for (const e of entries) {
    if (e.name === '.git') continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await listFiles(dir, childRel, out);
    else if (e.isFile()) out.push(childRel);
  }
}

/**
 * sha256 of a file's bytes, or of a directory as the sorted list of
 * (relative posix path + NUL + content) for every regular file, skipping `.git`.
 */
export async function hashPath(absPath: string): Promise<string> {
  let st;
  try {
    st = await lstat(absPath);
  } catch {
    throw new PalmError('E_IO', `Cannot hash ${absPath}: no such file or directory`);
  }
  const h = createHash('sha256');
  if (st.isDirectory()) {
    const files: string[] = [];
    await listFiles(absPath, '', files);
    files.sort();
    for (const rel of files) {
      h.update(rel);
      h.update('\0');
      h.update(await readFile(join(absPath, rel)));
      h.update('\0');
    }
  } else {
    h.update(await readFile(absPath));
  }
  return `sha256:${h.digest('hex')}`;
}

/** Deterministic JSON (sorted object keys) for hashing structured values. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}
