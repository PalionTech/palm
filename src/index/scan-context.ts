/**
 * State shared by the scan passes of one source: the file index, cached reads, the entity
 * registry and the warnings list. Rule modules receive it; nothing outside src/index sees it.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { messageOf } from '../core/errors.js';
import type { Entity, LayoutDescriptor, Source } from '../core/types.js';
import { isScanIgnoredRel } from '../domain/ignore.js';
import { parseJson } from '../lib/json.js';
import { EntityRegistry } from './entity-registry.js';
import { buildFileIndex, type FileIndex } from './files.js';
import { globIndex } from './glob.js';
import { defaultIgnoreGlobs, minimalIgnoreGlobs } from './ignore.js';
import type { PluginManifestFormat } from './plugin-manifest.js';
import type { ParsedSkill } from './skills.js';
import { baseOf, joinRel, normRel, toSlug, versionFromTag } from './util.js';

/** fast-glob `deep` for the source listing (files up to 9 directories below the root). */
const LIST_DEEP = 10;

/** The plugin an entity is indexed for; its version is the fallback for members without one. */
export interface PluginContext {
  /** Plugin name; undefined when members are indexed standalone (duplicate plugin). */
  name?: string;
  version?: string;
  rootRel: string;
  format?: PluginManifestFormat | 'apm';
}

export class ScanContext {
  readonly rootAbs: string;
  readonly source: Source;
  /** The source's name (the manifest key), recorded on every entity. */
  readonly sourceName: string;
  /** Slug for a nameless plugin or hook set at the root: the last segment of the source name. */
  readonly fallbackName: string;
  readonly layout: LayoutDescriptor | undefined;
  readonly tagVersion: string | undefined;
  readonly warnings: string[] = [];
  readonly registry: EntityRegistry;
  /** Parsed SKILL.md per skill directory (null: skipped with a warning). */
  readonly skillCache = new Map<string, Promise<ParsedSkill | null>>();
  /** Source files of an entity beyond `entity.path` (hook files merged into one set). */
  readonly extraSources = new WeakMap<Entity, string[]>();
  descriptorMode = false;
  private index: FileIndex | undefined;
  private readonly textCache = new Map<string, Promise<string | undefined>>();
  /** Ignored directories already brought into the index by `ensureIndexed`. */
  private readonly indexedRoots = new Set<string>();

  constructor(root: string, source: Source) {
    this.rootAbs = resolve(root);
    this.source = source;
    this.sourceName = source.name;
    this.fallbackName = toSlug(baseOf(normRel(source.name)), baseOf(this.rootAbs));
    this.layout = source.layout;
    this.tagVersion = versionFromTag(source.ref);
    this.registry = new EntityRegistry(this.warnings, (rel) => this.files.realPathOf(rel));
  }

  get files(): FileIndex {
    if (!this.index) throw new Error('scan: file index used before it was built');
    return this.index;
  }

  /** Walk the source once (descriptor scans keep test/example directories). */
  async buildIndex(descriptorMode: boolean): Promise<void> {
    this.descriptorMode = descriptorMode;
    const exclude = this.layout?.exclude ?? [];
    this.index = await buildFileIndex(this.rootAbs, {
      ignore: descriptorMode ? minimalIgnoreGlobs(exclude) : defaultIgnoreGlobs(exclude),
      deep: LIST_DEEP,
      ignoreDirNames: !descriptorMode,
    });
    this.warnings.push(...this.index.warnings);
  }

  read(rel: string): Promise<string | undefined> {
    let p = this.textCache.get(rel);
    if (!p) {
      p = readFile(join(this.rootAbs, rel), 'utf8').catch(() => undefined);
      this.textCache.set(rel, p);
    }
    return p;
  }

  async readJson(rel: string): Promise<{ json?: unknown; error?: string }> {
    const text = await this.read(rel);
    if (text === undefined) return { error: 'cannot read file' };
    try {
      return { json: parseJson(text) };
    } catch (e) {
      return { error: `invalid JSON (${messageOf(e)})` };
    }
  }

  async fsKind(rel: string): Promise<'file' | 'dir' | undefined> {
    if (this.files.hasFile(rel)) return 'file';
    if (this.files.hasDir(rel)) return 'dir';
    try {
      const st = await stat(join(this.rootAbs, rel));
      if (st.isFile()) return 'file';
      return st.isDirectory() ? 'dir' : undefined;
    } catch {
      return undefined;
    }
  }

  /** fast-glob options shared by every glob of this scan (ignore rules of the scan mode). */
  globOptions(cwdRel: string, ignore: string[]): { cwd: string; dot: true; ignore: string[] } {
    return { cwd: join(this.rootAbs, cwdRel), dot: true, ignore };
  }

  /** Glob relative to a plugin root over the index; results are source-relative and sorted. */
  async globIn(baseRel: string, pattern: string): Promise<string[]> {
    const ignore = this.descriptorMode ? minimalIgnoreGlobs() : defaultIgnoreGlobs();
    const matches = await globIndex(this.files, normRel(pattern) || '*', {
      ...this.globOptions(baseRel, ignore),
      onlyFiles: false,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
    return matches.map((m) => joinRel(baseRel, m)).sort();
  }

  /** Bring a plugin directory that lives in an ignored area (e.g. `examples/x`) into the index. */
  async ensureIndexed(rootRel: string): Promise<void> {
    if (rootRel === '' || this.descriptorMode || !isScanIgnoredRel(rootRel)) return;
    if (this.files.hasDir(rootRel) || this.indexedRoots.has(rootRel)) return;
    this.indexedRoots.add(rootRel);
    const sub = await buildFileIndex(join(this.rootAbs, rootRel), {
      ignore: defaultIgnoreGlobs(),
      deep: LIST_DEEP,
      ignoreDirNames: true,
    });
    this.files.merge(rootRel, sub);
  }

  /** Version fallback chain: the entity's own, then its plugin's, then the source tag's. */
  versionOf(own: string | undefined, plugin: PluginContext | undefined): string | undefined {
    return own ?? plugin?.version ?? this.tagVersion;
  }
}
