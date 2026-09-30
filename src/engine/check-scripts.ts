/**
 * The files a hook command or a server command line names (X14): a path after the project-dir
 * idiom (`"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh`), a relative or absolute path, or a script by
 * its extension. A command palm did not install that names a missing file is reported with it,
 * so a hand-added hook that can only fail says so. Commands are read, never run.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ScopePaths } from '../domain/scope-paths.js';

const PROJECT_IDIOM = /^\$\{?(?:CLAUDE|CURSOR|GEMINI)_PROJECT_DIR\}?(?=\/)/;
/** Codex and Copilot's project-dir idiom (`relocate.ts`), read as the project root. */
const GIT_TOP_LEVEL = /\$\(\s*git rev-parse --show-toplevel[^)]*\)/g;
const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|go|ps1|php|lua)$/i;
const PATH_START = /^(?:\.{1,2}\/|\/|~\/)/;

/** The command's words with shell quotes removed (`"$CLAUDE_PROJECT_DIR"/x` → `$CLAUDE_PROJECT_DIR/x`). */
function words(command: string): string[] {
  return command
    .replace(GIT_TOP_LEVEL, '$CLAUDE_PROJECT_DIR')
    .split(/[\s;|&()<>]+/)
    .map((w) => w.replace(/["']/g, ''))
    .filter(Boolean);
}

/** The absolute path a word names, when it looks like a file palm can place; undefined otherwise. */
function placed(paths: ScopePaths, word: string): string | undefined {
  if (word.includes('://') || word.startsWith('-') || word.includes('=')) return undefined;
  const rooted = word.replace(PROJECT_IDIOM, paths.root);
  if (rooted !== word) return rooted.includes('$') ? undefined : rooted;
  if (word.includes('$') || word.includes('*')) return undefined;
  if (word.startsWith('~/')) return join(paths.home, word.slice(2));
  if (!PATH_START.test(word) && !(word.includes('/') && SCRIPT_EXTENSION.test(word)))
    return undefined;
  return isAbsolute(word) ? word : join(paths.root, word);
}

/** The first file `command` names that does not exist (lock form), if any. */
export function missingScript(paths: ScopePaths, command: string): string | undefined {
  for (const word of words(command)) {
    const abs = placed(paths, word);
    if (abs !== undefined && !existsSync(abs)) return paths.lockForm(abs);
  }
  return undefined;
}
