/** Scan ignore rules (DESIGN §5 rule 0). */

/** Directory names skipped anywhere in the tree. */
export const IGNORED_DIR_NAMES = [
  'node_modules',
  '.git',
  'test',
  'tests',
  'fixture',
  'fixtures',
  'eval',
  'evals',
  'example',
  'examples',
  'template',
  'templates',
  'docs',
  'website',
  'dist',
  'build',
] as const;

/**
 * Harness install outputs committed to repos (`palm` or other installers wrote them) and editor
 * config. They mirror real sources elsewhere in the repo or configure the repo's own development.
 */
export const INSTALL_OUTPUT_DIRS = [
  '.agents/skills',
  '.claude/skills',
  '.claude/agents',
  '.claude/commands',
  '.claude/rules',
  '.github/skills',
  '.github/agents',
  '.github/instructions',
  '.github/prompts',
  '.github/hooks',
  '.cursor/rules',
  '.cursor/agents',
  '.cursor/commands',
  '.codex/agents',
  '.codex/prompts',
  '.vscode',
] as const;

/** Repository-level files (contributor guidance / dev config), matched at the origin root only. */
export const ROOT_IGNORED_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.mcp.json.example', '.cursor/mcp.json', '.cursor/hooks.json'] as const;

/** fast-glob ignore patterns for auto-detected scans. */
export function defaultIgnoreGlobs(extra: string[] = []): string[] {
  return [
    ...IGNORED_DIR_NAMES.map((d) => `**/${d}/**`),
    ...INSTALL_OUTPUT_DIRS.map((d) => `**/${d}/**`),
    ...ROOT_IGNORED_FILES,
    ...expandExcludes(extra),
  ];
}

/** fast-glob ignore patterns for descriptor scans: only VCS/dependency dirs plus the descriptor's `exclude`. */
export function minimalIgnoreGlobs(extra: string[] = []): string[] {
  return ['**/.git/**', '**/node_modules/**', ...expandExcludes(extra)];
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
    else if (p.startsWith(prefix + '/')) out.push(p.slice(prefix.length + 1));
  }
  return out;
}

/** True when any path segment of `rel` is an ignored directory name or an install-output dir. */
export function isIgnoredRel(rel: string): boolean {
  const segs = rel.split('/');
  if (segs.some((s) => (IGNORED_DIR_NAMES as readonly string[]).includes(s))) return true;
  const padded = `/${rel}/`;
  return INSTALL_OUTPUT_DIRS.some((d) => padded.includes(`/${d}/`));
}
