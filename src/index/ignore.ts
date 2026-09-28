/**
 * Scan ignore globs (DESIGN §5 rule 0). The lists themselves live in domain/ignore; this module
 * turns them into fast-glob patterns for the scanner.
 */
import {
  ALWAYS_SKIP_DIRS,
  INSTALL_OUTPUT_DIRS,
  ROOT_IGNORED_FILES,
  SCAN_IGNORE_DIRS,
} from '../domain/ignore.js';

/** fast-glob ignore patterns for auto-detected scans. */
export function defaultIgnoreGlobs(extra: string[] = []): string[] {
  return [
    ...SCAN_IGNORE_DIRS.map((d) => `**/${d}/**`),
    ...INSTALL_OUTPUT_DIRS.map((d) => `**/${d}/**`),
    ...ROOT_IGNORED_FILES,
    ...expandExcludes(extra),
  ];
}

/** fast-glob ignore patterns for descriptor scans: only VCS/dependency dirs plus the descriptor's `exclude`. */
export function minimalIgnoreGlobs(extra: string[] = []): string[] {
  return [...ALWAYS_SKIP_DIRS.map((d) => `**/${d}/**`), ...expandExcludes(extra)];
}

/** `skills/.system` → both `skills/.system` and `skills/.system/**` so directories are pruned. */
export function expandExcludes(patterns: string[]): string[] {
  const out: string[] = [];
  for (const raw of patterns) {
    const p = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    if (p === '') continue;
    out.push(p);
    if (!p.endsWith('/**')) out.push(`${p}/**`);
  }
  return out;
}

/**
 * Rewrite ignore patterns for a walk rooted at `prefix` (a followed symlink): keep `**`-anchored
 * patterns, re-anchor patterns that start with the prefix, drop the rest.
 */
export function rebaseIgnore(patterns: string[], prefix: string): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    if (p.startsWith('**/')) out.push(p);
    else if (p.startsWith(`${prefix}/`)) out.push(p.slice(prefix.length + 1));
  }
  return out;
}
