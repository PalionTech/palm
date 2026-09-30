/**
 * C11: a project holding another tool's list of what it installs (`skills-lock.json` of the
 * `skills` CLI, `apm.yml` of Microsoft APM) and no palm.yaml entries yet gets one hint from
 * `palm init` and `palm check`: an import command arrives in palm 0.3; until then each entry
 * installs by name, and the first one the file lists is the example.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import type { Scope } from '../core/types.js';
import { isRecord } from '../lib/object.js';
import { listJoin } from '../ui/format.js';
import { palmLine } from './hints.js';

/** The files palm 0.3 imports, and the first install each one lists (as `palm install` words). */
const FOREIGN: ReadonlyArray<[string, (text: string) => string[] | undefined]> = [
  ['skills-lock.json', firstSkill],
  ['apm.yml', firstPackage],
];

/** `skills-lock.json`: `{ skills: { <name>: { source: "owner/repo" } } }`. */
function firstSkill(text: string): string[] | undefined {
  const data: unknown = JSON.parse(text);
  const skills = isRecord(data) && isRecord(data.skills) ? Object.entries(data.skills) : [];
  for (const [name, s] of skills)
    if (isRecord(s) && typeof s.source === 'string' && s.source) return [s.source, name];
  return undefined;
}

/** APM's virtual file packages: the file suffix and the kind palm installs it as. */
const VIRTUAL_FILES: ReadonlyArray<[suffix: string, kind: string]> = [
  ['.instructions.md', 'instruction'],
  ['.agent.md', 'agent'],
  ['.chatmode.md', 'agent'],
  ['.prompt.md', 'skill'],
];

/**
 * O5: an APM dependency as `palm install` words. A virtual file path
 * (`owner/repo/instructions/golang.instructions.md#ref`) is its repository and the entity
 * (`owner/repo#ref instruction:golang`); another file lists the repository; a directory or a
 * repository installs whole (programs left out).
 */
export function apmInstallWords(dep: string): string[] {
  const [path = '', ref] = dep.split('#');
  const parts = path.split('/');
  const repo = `${parts.slice(0, 2).join('/')}${ref ? `#${ref}` : ''}`;
  const file = parts.length > 2 ? (parts[parts.length - 1] ?? '') : '';
  const virtual = VIRTUAL_FILES.find(([suffix]) => file.endsWith(suffix));
  if (virtual) return [repo, `${virtual[1]}:${file.slice(0, -virtual[0].length)}`];
  if (/\.[a-z]+$/i.test(file)) return [repo];
  return [dep, '--all'];
}

/** `apm.yml`: `dependencies: { apm: ["owner/repo#ref", …] }`: the first one as install words. */
function firstPackage(text: string): string[] | undefined {
  const data: unknown = YAML.parse(text);
  const deps = isRecord(data) && isRecord(data.dependencies) ? data.dependencies.apm : undefined;
  const first = Array.isArray(deps)
    ? deps.find((d) => typeof d === 'string' && d.trim())
    : undefined;
  return typeof first === 'string' ? apmInstallWords(first.trim()) : undefined;
}

/** X11: what an example from each file installs, when that differs from what the file pinned. */
const AT: Readonly<Record<string, string>> = {
  'skills-lock.json': ' at the current branch (the locked commit needs palm 0.3)',
};

async function example(file: string, pick: (text: string) => string[] | undefined) {
  try {
    return pick(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The hint lines for a project at `root` whose palm.yaml lists nothing, or undefined when it
 * holds neither file or lists entries already (`hasEntries` is asked only when a file is there).
 */
export async function importHint(
  root: string,
  scope: Scope,
  hasEntries: () => Promise<boolean>,
): Promise<string[] | undefined> {
  if (scope !== 'project') return undefined;
  const found = FOREIGN.filter(([name]) => existsSync(join(root, name)));
  if (!found.length || (await hasEntries())) return undefined;
  const names = found.map(([name]) => name);
  const them = names.length === 1 ? 'it' : 'them';
  const lines = [
    `${listJoin(names)} found: palm 0.3 imports ${them}; until then install each entry by name`,
  ];
  for (const [name, pick] of found) {
    const words = await example(join(root, name), pick);
    const at = AT[name] ?? '';
    if (words) lines.push(`  from ${name}${at}, for example: ${palmLine('install', words, scope)}`);
  }
  return lines;
}
