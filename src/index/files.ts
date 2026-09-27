/**
 * One-pass file index of an origin: every potentially relevant file (md/mdc/json/toml, apm.yml)
 * under the root, honouring ignore rules, including dot directories, and following symlinks only
 * when they stay inside the origin (with loop protection).
 */

import fg from 'fast-glob';
import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { isIgnoredRel, rebaseIgnore } from './ignore.js';
import { baseOf, dirOf } from './util.js';

export interface FileIndex {
  rootAbs: string;
  realRoot: string;
  /** Relative posix paths, sorted. */
  files: string[];
  fileSet: Set<string>;
  /** Every ancestor directory of a listed file ('' excluded). */
  dirSet: Set<string>;
  /** rel → real absolute path (differs from join(root, rel) under followed symlinks). */
  real: Map<string, string>;
  warnings: string[];
}

export interface FileIndexOptions {
  ignore: string[];
  /** fast-glob `deep`: files up to `deep - 1` directories below the root. */
  deep: number;
  /** Also skip symlinked directories whose path hits the default ignore names. */
  ignoreDirNames: boolean;
}

const RELEVANT_EXT = ['.md', '.mdc', '.json', '.toml'];

export function isRelevantFile(rel: string): boolean {
  const base = baseOf(rel).toLowerCase();
  if (base === 'apm.yml' || base === 'apm.yaml') return true;
  return RELEVANT_EXT.some((e) => base.endsWith(e));
}

function inside(realRoot: string, p: string): boolean {
  return p === realRoot || p.startsWith(realRoot + sep);
}

export async function buildFileIndex(rootAbs: string, opts: FileIndexOptions): Promise<FileIndex> {
  const realRoot = await realpath(rootAbs);
  const index: FileIndex = {
    rootAbs,
    realRoot,
    files: [],
    fileSet: new Set(),
    dirSet: new Set(),
    real: new Map(),
    warnings: [],
  };

  const add = (rel: string, real: string) => {
    if (index.fileSet.has(rel) || !isRelevantFile(rel)) return;
    index.fileSet.add(rel);
    index.files.push(rel);
    index.real.set(rel, real);
  };

  const walk = async (absDir: string, prefix: string, realDir: string, deep: number, chain: Set<string>): Promise<void> => {
    const ignore = prefix === '' ? opts.ignore : rebaseIgnore(opts.ignore, prefix);
    const entries = await fg('**/*', {
      cwd: absDir,
      dot: true,
      deep,
      followSymbolicLinks: false,
      onlyFiles: false,
      objectMode: true,
      ignore,
      suppressErrors: true,
    });
    const links: string[] = [];
    for (const e of entries) {
      const rel = prefix === '' ? e.path : `${prefix}/${e.path}`;
      if (e.dirent.isFile()) add(rel, join(realDir, e.path));
      else if (e.dirent.isSymbolicLink()) links.push(e.path);
    }
    for (const linkPath of links) {
      const rel = prefix === '' ? linkPath : `${prefix}/${linkPath}`;
      let target: string;
      try {
        target = await realpath(join(absDir, linkPath));
      } catch {
        continue; // broken link
      }
      if (!inside(realRoot, target)) {
        index.warnings.push(`skipped symlink ${rel}: points outside the origin`);
        continue;
      }
      let isDir: boolean;
      try {
        const st = await stat(target);
        if (st.isFile()) {
          add(rel, target);
          continue;
        }
        isDir = st.isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (opts.ignoreDirNames && isIgnoredRel(rel)) continue;
      const linkRealParent = join(realDir, dirOf(linkPath));
      // A link to one of its own ancestors (or already on the walk chain) would loop.
      if (inside(target, linkRealParent) || chain.has(target)) continue;
      const remaining = deep - linkPath.split('/').length;
      if (remaining < 1) continue;
      await walk(join(absDir, linkPath), rel, target, remaining, new Set([...chain, target]));
    }
  };

  await walk(rootAbs, '', realRoot, opts.deep, new Set([realRoot]));

  index.files.sort();
  for (const f of index.files) {
    let d = dirOf(f);
    while (d !== '' && !index.dirSet.has(d)) {
      index.dirSet.add(d);
      d = dirOf(d);
    }
  }
  return index;
}

/** Files directly inside `dirRel` ('' = root). */
export function filesIn(index: FileIndex, dirRel: string): string[] {
  return index.files.filter((f) => dirOf(f) === dirRel);
}

/** Files at any depth below `dirRel` ('' = everything), optionally depth-limited (directory levels below dirRel). */
export function filesUnder(index: FileIndex, dirRel: string, maxDirDepth = Infinity): string[] {
  const prefix = dirRel === '' ? '' : dirRel + '/';
  const out: string[] = [];
  for (const f of index.files) {
    if (prefix !== '' && !f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    if (maxDirDepth !== Infinity && rest.split('/').length - 1 > maxDirDepth) continue;
    out.push(f);
  }
  return out;
}

export function realPathOf(index: FileIndex, rel: string): string {
  return index.real.get(rel) ?? join(index.realRoot, rel);
}
