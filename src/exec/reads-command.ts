/**
 * Project files an in-place (in-repo) hook command or stdio server runs (O10): `go run
 * .agents/hooks/main.go` or `"$CLAUDE_PROJECT_DIR"/tools/check.sh` runs a file of the worktree
 * that may lie outside the source folder; palm hashes it in place with the closure, so an edit
 * to it asks for consent again. Plugin-root references are the index's (already in the
 * closure); other variables are not guessed. Commands are read, never run.
 */
import type { Entity } from '../core/types.js';
import { PLUGIN_ROOT_TOKENS } from '../domain/ignore.js';
import { type Placing, PROJECT_MARK, placeRead } from './reads-place.js';

const COMMAND_KEYS = ['command', 'bash', 'powershell'];
const PROJECT_IDIOM =
  /^(?:\$\{?(?:CLAUDE|CURSOR|GEMINI)_PROJECT_DIR\}?|\$\(\s*git rev-parse --show-toplevel[^)]*\))\//;
const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|go|ps1|php|lua)$/i;

/** Every command string of a hook file's JSON, at any depth. */
function hookCommands(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(hookCommands);
  if (value === null || typeof value !== 'object') return [];
  const rec = value as Record<string, unknown>;
  const own = COMMAND_KEYS.map((k) => rec[k]).filter((v): v is string => typeof v === 'string');
  return [...own, ...Object.values(rec).flatMap(hookCommands)];
}

function commandsOf(entity: Entity): string[] {
  const { def } = entity;
  if (def.kind === 'hook') return hookCommands(def.hooks.raw);
  if (def.kind === 'mcp' && def.mcp.command) return [def.mcp.command, ...(def.mcp.args ?? [])];
  return [];
}

/** The words of a command line with shell quotes removed; the git top-level idiom kept whole. */
function words(command: string): string[] {
  const kept = command.replace(/\$\(\s*git rev-parse --show-toplevel[^)]*\)/g, (m) =>
    m.replace(/\s+/g, '\u0000'),
  );
  return kept
    .split(/[\s;|&<>]+/)
    .map((w) => w.replace(/["']/g, '').replaceAll('\u0000', ' '))
    .filter(Boolean);
}

/** The project-relative path a word names (`PROJECT_MARK` + path), or undefined. */
function projectPath(word: string): string | undefined {
  if (word.search(PLUGIN_ROOT_TOKENS) >= 0) return undefined;
  const rooted = word.replace(PROJECT_IDIOM, '');
  if (rooted !== word) return rooted.includes('$') ? undefined : `${PROJECT_MARK}${rooted}`;
  if (word.includes('$') || word.includes('://') || word.startsWith('-')) return undefined;
  const relative = word.startsWith('./') || word.startsWith('../');
  if (!relative && !(word.includes('/') && SCRIPT_EXTENSION.test(word))) return undefined;
  return word.startsWith('/') ? undefined : `${PROJECT_MARK}${word}`;
}

/**
 * Adds to `found.reads` the worktree files the entity's commands run (source-relative, `../`
 * when outside the source); commands run from the project root.
 */
export async function commandReads(
  entity: Entity,
  at: { sourceRoot: string; worktree: string; found: Placing['found'] },
): Promise<void> {
  const job: Placing = {
    sourceRoot: at.sourceRoot,
    script: entity.path,
    found: at.found,
    worktree: at.worktree,
  };
  for (const command of commandsOf(entity))
    for (const word of words(command)) {
      const rel = projectPath(word);
      if (rel !== undefined) await placeRead(job, rel, { strict: false, runs: true });
    }
}
