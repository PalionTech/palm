/**
 * What the hints know about a scope (src/commands/hints.ts): the declared sources with the
 * location a person would type, the installed entries, the directories of the project, the 0.1
 * aliases of ~/.palm/config.yaml, and under -g the project's own sources.
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { looksLikeSourceInput } from '../core/source-input.js';
import type { LegacyConfig, PalmContext } from '../core/types.js';
import type { ScopeState, SourceRef } from '../create/engine.js';
import { githubRepoOf } from '../domain/source-url.js';
import { readYamlFile } from '../lib/yaml.js';
import type { App } from './app.js';
import type { GrammarContext, KnownSource } from './hints.js';
import { engine } from './shared.js';

/** `./dir` for a path inside `root`, else the path. */
function pathInput(path: string, root: string): string {
  const rel = relative(root, path);
  if (rel === '') return '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return path;
  return `./${rel.split(sep).join('/')}`;
}

/** What installs from `ref` without palm.yaml: `owner/repo[/root]`, the URL, or `./dir`. */
function locationOf(ref: SourceRef, root: string): string {
  const { source } = ref;
  if (ref.isLocal) return source.path ? pathInput(source.path, root) : ref.name;
  const repo = githubRepoOf(source.url ?? '');
  if (repo) return source.root ? `${repo}/${source.root}` : repo;
  return source.url ?? ref.name;
}

function knownSource(ref: SourceRef, root: string): KnownSource {
  const { owner, repo } = ref.repoParts();
  return {
    name: ref.name,
    ...(ref.alias ? { alias: ref.alias } : {}),
    input: locationOf(ref, root),
    ...(owner ? { owner } : {}),
    repo,
  };
}

function knownSources(state: ScopeState): KnownSource[] {
  return state.sources.all().map((ref) => knownSource(ref, state.paths.root));
}

/** The palm 0.1 aliases of ~/.palm/config.yaml, read only for a 0.1 form (a word with `@`). */
async function legacyAliases(ctx: PalmContext, words: readonly string[]) {
  if (!words.some((w) => w.includes('@'))) return undefined;
  const file = join(ctx.paths.palmHome, 'config.yaml');
  const config = await readYamlFile<LegacyConfig>(file).catch(() => undefined);
  const aliases: Record<string, string> = {};
  for (const o of config?.origins ?? []) {
    const repo = o.url ? githubRepoOf(o.url) : undefined;
    const where = repo ? [repo, o.root].filter(Boolean).join('/') : (o.url ?? o.path);
    if (o.alias && where) aliases[o.alias] = where;
  }
  return aliases;
}

/** `./<word>` for a word that names a directory of the project (not already a path). */
function localDirOf(state: ScopeState) {
  return (word: string): string | undefined => {
    if (state.paths.scope !== 'project' || /^[./~]/.test(word) || word.includes(':'))
      return undefined;
    const abs = join(state.paths.root, word);
    return existsSync(abs) && statSync(abs).isDirectory() ? `./${word}` : undefined;
  };
}

/** Under -g, the sources of the project here; none when there is no project. */
async function projectSources(ctx: PalmContext, app: App): Promise<KnownSource[] | undefined> {
  try {
    return knownSources(await engine(app).openScope(ctx, 'project', { readOnly: true }));
  } catch {
    return undefined;
  }
}

/**
 * The grammar's view of a scope for `words`. The project is read under -g only when the first
 * word is no source of the global scope (the one case its sources explain).
 */
export async function grammarContext(
  ctx: PalmContext,
  app: App,
  state: ScopeState,
  words: readonly string[],
): Promise<GrammarContext> {
  const isDeclared = (word: string) => state.sources.byName(word) !== undefined;
  const [first = ''] = words;
  const unknown = first !== '' && !isDeclared(first) && !looksLikeSourceInput(first);
  const global = state.paths.scope === 'global';
  const project = global && unknown ? await projectSources(ctx, app) : undefined;
  const legacy = await legacyAliases(ctx, words);
  return {
    isDeclared,
    scope: state.paths.scope,
    sources: knownSources(state),
    entries: state.lock.entries.map((e) => ({ kind: e.kind, name: e.name, source: e.source })),
    localDir: localDirOf(state),
    ...(legacy ? { legacyAliases: legacy } : {}),
    ...(project ? { projectSources: project } : {}),
  };
}
