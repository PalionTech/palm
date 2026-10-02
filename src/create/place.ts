/**
 * Where a template lands in its source (rulings K13, B6): at the convention path, or, when the
 * source's layout names globs (a descriptor, which replaces detection), at the first glob of the
 * kind with its first `*` replaced by the entity's name (`packages/*` → `packages/notes/SKILL.md`,
 * `people/*.md` → `people/notes.md`). A layout that names no place for the kind is refused
 * before anything is written: the entity would not be indexed there.
 */
import { posix } from 'node:path';
import { PalmError } from '../core/errors.js';
import type { LayoutDescriptor } from '../core/types.js';

export type PlaceableKind = 'skill' | 'agent' | 'instruction' | 'hook';

type KindKey = 'skills' | 'agents' | 'instructions' | 'hooks';

const KEY: Readonly<Record<PlaceableKind, KindKey>> = {
  skill: 'skills',
  agent: 'agents',
  instruction: 'instructions',
  hook: 'hooks',
};

/** Layout keys that make a descriptor (the ones that replace detection). */
const GLOB_KEYS = ['skills', 'agents', 'commands', 'instructions', 'hooks', 'mcp'] as const;

/** The convention path of the kind's main file, and the glob that indexes it. */
const CONVENTION: Readonly<Record<PlaceableKind, { path: string; glob: string }>> = {
  skill: { path: 'skills/<name>/SKILL.md', glob: 'skills/*' },
  agent: { path: 'agents/<name>.md', glob: 'agents/*.md' },
  instruction: { path: 'instructions/<name>.md', glob: 'instructions/*.md' },
  hook: { path: 'hooks/<name>/hooks.json', glob: 'hooks/*/hooks.json' },
};

/** The extension the main file of each kind needs when a glob names none. */
const FILE_EXT: Readonly<Record<PlaceableKind, RegExp>> = {
  skill: /\/SKILL\.md$/,
  agent: /\.md$/i,
  instruction: /\.(md|mdc)$/i,
  hook: /\.json$/i,
};

const SUFFIX: Readonly<Record<PlaceableKind, string>> = {
  skill: '/SKILL.md',
  agent: '.md',
  instruction: '.md',
  hook: '/hooks.json',
};

function globsOf(layout: LayoutDescriptor, key: (typeof GLOB_KEYS)[number]): string[] {
  const v = layout[key] ?? [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((g) => g.trim()).filter((g) => g !== '');
}

function isDescriptor(layout: LayoutDescriptor | undefined): layout is LayoutDescriptor {
  return layout !== undefined && GLOB_KEYS.some((k) => globsOf(layout, k).length > 0);
}

/** Every glob a layout indexes with (`exclude` aside); none when it is no descriptor. */
export function layoutGlobs(layout: LayoutDescriptor | undefined): string[] {
  if (!isDescriptor(layout)) return [];
  return GLOB_KEYS.flatMap((k) => globsOf(layout, k));
}

/**
 * `glob` with its first wildcard segment naming the entity, or undefined when that cannot be
 * done plainly (character classes, braces, a second wildcard segment).
 */
function fillGlob(glob: string, name: string): string | undefined {
  if (/[?[\]{}!]/.test(glob)) return undefined;
  const segs = posix.normalize(glob.replace(/^\.\//, '')).split('/');
  const at = segs.findIndex((s) => s.includes('*'));
  if (at < 0) return undefined;
  const rest = segs.slice(at + 1).filter((s) => s !== '**');
  if (rest.some((s) => s.includes('*'))) return undefined;
  const seg = segs[at] === '**' ? name : (segs[at] ?? '').replace(/\*+/, name);
  if (seg.includes('*')) return undefined;
  return [...segs.slice(0, at), seg, ...rest].join('/');
}

/** The main file a glob gives the kind (`packages/*` → `packages/<name>/SKILL.md`). */
function mainFileIn(kind: PlaceableKind, glob: string, name: string): string | undefined {
  const filled = fillGlob(glob, name);
  if (!filled || filled.startsWith('../')) return undefined;
  if (kind === 'skill' && posix.basename(filled) === 'SKILL.md') return filled;
  return FILE_EXT[kind].test(filled) ? filled : `${filled}${SUFFIX[kind]}`;
}

/**
 * The main file of a new `kind` named `name` in a source with `layout` (source-relative): the
 * convention path, or the first layout glob of the kind that can hold it. E_USAGE when the layout
 * replaces detection and has no such glob.
 */
export function placeMainFile(
  kind: PlaceableKind,
  name: string,
  layout: LayoutDescriptor | undefined,
): string {
  const conv = CONVENTION[kind];
  if (!isDescriptor(layout)) return conv.path.replace('<name>', name);
  const key = KEY[kind];
  const globs = globsOf(layout, key);
  for (const g of globs) {
    const file = mainFileIn(kind, g, name);
    if (file) return file;
  }
  const had = globs.length ? ` (${globs.join(', ')} names no place for "${name}")` : '';
  throw new PalmError(
    'E_USAGE',
    `the source's layout lists no ${key} glob a new ${kind} fits${had}`,
    `add one to layout in palm.yaml, for example ${key}: [${conv.glob}]`,
  );
}
