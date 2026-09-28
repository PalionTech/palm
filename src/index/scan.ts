/**
 * scanOrigin: turn a checked-out origin directory into an index of entities (DESIGN §5).
 *
 * Rule order: descriptor > apm > marketplace > plugin manifest > convention. Plugin rules are
 * followed by a convention pass over the rest of the tree, so skills on disk that a manifest does
 * not declare are still indexed (standalone, with a warning).
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import fg from 'fast-glob';
import YAML from 'yaml';
import { messageOf, PalmError } from '../core/errors.js';
import type {
  Entity,
  EntityRef,
  Kind,
  LayoutDescriptor,
  OriginSpec,
  ScanResult,
} from '../core/types.js';
import { isDocFile, isScanIgnoredRel } from '../domain/ignore.js';
import { parseJson } from '../lib/json.js';
import { isRecord, withoutUndefined } from '../lib/object.js';
import { parseAgentFileDetailed } from './agents.js';
import { parseCommandFile } from './commands.js';
import { type Detection, detectLayout, type ScanRule } from './detect.js';
import { buildFileIndex, type FileIndex, filesIn, filesUnder, realPathOf } from './files.js';
import {
  detectHookDialect,
  hasHooks,
  mergeHooksRaw,
  normalizeHooksJson,
  parseHooksJson,
} from './hooks.js';
import { defaultIgnoreGlobs, minimalIgnoreGlobs } from './ignore.js';
import { parseInstructionFile } from './instructions.js';
import {
  describeSource,
  isRemoteSource,
  type MarketplaceEntry,
  originHint,
  readMarketplace,
} from './marketplace.js';
import { parseMcpJson } from './mcp.js';
import {
  type ComponentDecls,
  findPluginManifest,
  mergeDecls,
  type PluginManifest,
  type PluginManifestFormat,
} from './plugin-manifest.js';
import { type ParsedSkill, parseSkillMdDetailed } from './skills.js';
import {
  asString,
  baseOf,
  dirDepth,
  dirOf,
  displayRel,
  escapesRoot,
  hasGlobChars,
  isWithinRel,
  joinRel,
  normRel,
  toSlug,
  versionFromTag,
} from './util.js';

/** fast-glob `deep` for the origin listing (files up to 9 directories below the root). */
const LIST_DEEP = 10;
/** Maximum directory depth of a skill directory found by convention (`a/b/c/d/e/SKILL.md`). */
const SKILL_MAX_DEPTH = 5;
/** Maximum directory depth of other convention-scanned files. */
const OTHER_MAX_DEPTH = 6;

interface PluginContext {
  /** Plugin name; undefined when members are indexed standalone (duplicate plugin). */
  name?: string;
  version?: string;
  rootRel: string;
  format?: PluginManifestFormat | 'apm';
}

type ResolveKind = 'agent' | 'command' | 'instruction';

const EXTENSIONS: Record<ResolveKind, string[]> = {
  agent: ['.md', '.toml'],
  command: ['.md', '.toml'],
  instruction: ['.mdc', '.md'],
};

function hasExt(rel: string, exts: string[]): boolean {
  const l = rel.toLowerCase();
  return exts.some((e) => l.endsWith(e));
}

function byDepthThenPath(a: string, b: string): number {
  const d = dirDepth(a) - dirDepth(b);
  return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

class Scanner {
  readonly rootAbs: string;
  readonly spec: OriginSpec;
  readonly alias: string;
  readonly layout: LayoutDescriptor | undefined;
  readonly tagVersion: string | undefined;

  entities: Entity[] = [];
  warnings: string[] = [];
  private index!: FileIndex;
  private skillDirSet = new Set<string>();
  private byName = new Map<string, Entity>();
  private byReal = new Map<string, Entity>();
  private claimed = new Set<string>();
  private skillCache = new Map<string, Promise<ParsedSkill | null>>();
  private textCache = new Map<string, Promise<string | undefined>>();
  private pluginRoots: Array<{ rootRel: string; name: string }> = [];
  private descriptorMode = false;

  constructor(root: string, spec: OriginSpec) {
    this.rootAbs = resolve(root);
    this.spec = spec;
    this.alias = spec.alias;
    this.layout = spec.layout;
    this.tagVersion = versionFromTag(spec.ref);
  }

  async run(): Promise<ScanResult> {
    try {
      if (!(await stat(this.rootAbs)).isDirectory()) throw new Error('not a directory');
    } catch (e) {
      throw new PalmError(
        'E_IO',
        `cannot scan origin "${this.alias}": ${this.rootAbs} is not a readable directory`,
        messageOf(e),
      );
    }
    const detection = await detectLayout(this.rootAbs, this.layout, this.warnings);
    this.descriptorMode = detection.rule === 'descriptor';
    const exclude = this.layout?.exclude ?? [];
    this.index = await buildFileIndex(this.rootAbs, {
      ignore: this.descriptorMode ? minimalIgnoreGlobs(exclude) : defaultIgnoreGlobs(exclude),
      deep: LIST_DEEP,
      ignoreDirNames: !this.descriptorMode,
    });
    this.warnings.push(...this.index.warnings);
    this.refreshSkillDirs();

    let rule = await this.runRule(detection);
    if (rule === undefined) {
      // An apm.yml without primitives: fall back to the remaining rules.
      rule =
        (await this.runRule(
          await detectLayout(this.rootAbs, this.layout, [], { skipApm: true }),
        )) ?? 'convention';
    }

    this.applyInclude();
    this.warnUndeclared();
    return {
      entities: this.entities,
      warnings: this.warnings,
      detected: this.entities.length === 0 ? 'empty' : rule,
    };
  }

  /** Apply one detection rule. Returns the rule to report, or undefined when the rule found nothing to apply. */
  private async runRule(detection: Detection): Promise<ScanRule | undefined> {
    switch (detection.rule) {
      case 'descriptor':
        await this.scanDescriptor(this.layout ?? {});
        return 'descriptor';
      case 'apm':
        return (await this.scanApm(detection.apmFile ?? 'apm.yml')) ? 'apm' : undefined;
      case 'marketplace': {
        if (
          await this.scanMarketplace(detection.marketplaceFile as string, detection.rootManifest)
        ) {
          await this.scanConvention();
          return 'marketplace';
        }
        return this.runRule({
          rule: detection.rootManifest ? 'plugin-manifest' : 'convention',
          rootManifest: detection.rootManifest,
        });
      }
      case 'plugin-manifest':
        await this.scanPlugin({ rootRel: '', manifest: detection.rootManifest });
        await this.scanConvention();
        return 'plugin-manifest';
      case 'convention': {
        const nested = await this.scanNestedPlugins();
        await this.scanConvention();
        return nested > 0 ? 'plugin-manifest' : 'convention';
      }
    }
  }

  // -------------------------------------------------------------------------
  // file helpers
  // -------------------------------------------------------------------------

  private refreshSkillDirs(): void {
    this.skillDirSet = new Set(
      this.index.files.filter((f) => baseOf(f) === 'SKILL.md').map((f) => dirOf(f)),
    );
  }

  private read(rel: string): Promise<string | undefined> {
    let p = this.textCache.get(rel);
    if (!p) {
      p = readFile(join(this.rootAbs, rel), 'utf8').catch(() => undefined);
      this.textCache.set(rel, p);
    }
    return p;
  }

  private async readJson(rel: string): Promise<{ json?: unknown; error?: string }> {
    const text = await this.read(rel);
    if (text === undefined) return { error: 'cannot read file' };
    try {
      return { json: parseJson(text) };
    } catch (e) {
      return { error: `invalid JSON (${messageOf(e)})` };
    }
  }

  private async fsKind(rel: string): Promise<'file' | 'dir' | undefined> {
    if (this.index.fileSet.has(rel)) return 'file';
    if (rel === '' || this.index.dirSet.has(rel)) return 'dir';
    try {
      const st = await stat(join(this.rootAbs, rel));
      return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : undefined;
    } catch {
      return undefined;
    }
  }

  /** Glob relative to a plugin root; results are origin-relative. */
  private async globIn(baseRel: string, pattern: string, onlyFiles: boolean): Promise<string[]> {
    const cwd = join(this.rootAbs, baseRel);
    const matches = await fg(normRel(pattern) || '*', {
      cwd,
      dot: true,
      onlyFiles,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: this.descriptorMode ? minimalIgnoreGlobs() : defaultIgnoreGlobs(),
    });
    return matches.map((m) => joinRel(baseRel, m)).sort();
  }

  /** Bring a plugin directory that lives in an ignored area (e.g. `examples/x`) into the index. */
  private async ensureIndexed(rootRel: string): Promise<void> {
    if (rootRel === '' || this.descriptorMode || !isScanIgnoredRel(rootRel)) return;
    if (this.index.files.some((f) => f.startsWith(rootRel + '/'))) return;
    const sub = await buildFileIndex(join(this.rootAbs, rootRel), {
      ignore: defaultIgnoreGlobs(),
      deep: LIST_DEEP,
      ignoreDirNames: true,
    });
    for (const f of sub.files) {
      const rel = `${rootRel}/${f}`;
      this.index.files.push(rel);
      this.index.fileSet.add(rel);
      this.index.real.set(rel, sub.real.get(f) ?? join(sub.realRoot, f));
      let d = dirOf(rel);
      while (d !== '' && !this.index.dirSet.has(d)) {
        this.index.dirSet.add(d);
        d = dirOf(d);
      }
    }
    this.index.files.sort();
    this.refreshSkillDirs();
  }

  /** True when `rel` was reached through a symlink (its real path differs from its location). */
  private isLinked(rel: string): boolean {
    const real = this.index.real.get(rel);
    return real !== undefined && real !== join(this.index.realRoot, rel);
  }

  private insideSkillDir(rel: string): boolean {
    let d = dirOf(rel);
    for (;;) {
      if (this.skillDirSet.has(d)) return true;
      if (d === '') return false;
      d = dirOf(d);
    }
  }

  private parentSkillDir(dirRel: string): string | undefined {
    if (dirRel === '') return undefined;
    let d = dirOf(dirRel);
    for (;;) {
      if (this.skillDirSet.has(d)) return d;
      if (d === '') return undefined;
      d = dirOf(d);
    }
  }

  /** Skill directories directly inside `dirRel`. */
  private childSkillDirs(dirRel: string): string[] {
    return [...this.skillDirSet]
      .filter((d) => d !== dirRel && dirOf(d) === dirRel && isWithinRel(d, dirRel))
      .sort();
  }

  /** Top-most skill directories below `dirRel` (children first; buckets like `skills/engineering/*`). */
  private skillDirsBelow(dirRel: string, maxDepth = 3): string[] {
    const direct = this.childSkillDirs(dirRel);
    if (direct.length > 0) return direct;
    const base = dirDepth(dirRel === '' ? 'x' : `${dirRel}/x`);
    const below = [...this.skillDirSet]
      .filter(
        (d) => d !== dirRel && isWithinRel(d, dirRel) && dirDepth(`${d}/x`) - base <= maxDepth,
      )
      .sort(byDepthThenPath);
    return below.filter((d) => !below.some((o) => o !== d && isWithinRel(d, o)));
  }

  // -------------------------------------------------------------------------
  // entity registry
  // -------------------------------------------------------------------------

  private realKey(e: Entity): string | undefined {
    const rel = e.path === '.' ? '' : e.path;
    switch (e.kind) {
      case 'plugin':
        return undefined;
      case 'skill':
        return `skill\0${realPathOf(this.index, joinRel(rel, 'SKILL.md'))}`;
      case 'mcp':
        return `mcp\0${realPathOf(this.index, rel)}\0${e.name}`;
      default:
        return `${e.kind}\0${realPathOf(this.index, rel)}`;
    }
  }

  private isClaimed(kind: Kind, path: string): boolean {
    return this.claimed.has(`${kind}\0${path}`);
  }

  /** Register an entity; returns the entity that holds the name (the new one or an earlier one). */
  private add(e: Entity): Entity {
    this.claimed.add(`${e.kind}\0${e.path}`);
    const rk = this.realKey(e);
    const sameFile = rk ? this.byReal.get(rk) : undefined;
    if (sameFile) return sameFile;
    const nk = `${e.kind}\0${e.name}`;
    const existing = this.byName.get(nk);
    if (existing) {
      if (existing.path !== e.path) {
        this.warnings.push(
          `duplicate ${e.kind} "${e.name}" at ${e.path} ignored (already indexed from ${existing.path})`,
        );
      }
      return existing;
    }
    this.entities.push(e);
    this.byName.set(nk, e);
    if (rk) this.byReal.set(rk, e);
    return e;
  }

  // -------------------------------------------------------------------------
  // per-kind adders
  // -------------------------------------------------------------------------

  private parseSkill(dirRel: string): Promise<ParsedSkill | null> {
    let p = this.skillCache.get(dirRel);
    if (!p) {
      p = this.parseSkillUncached(dirRel);
      this.skillCache.set(dirRel, p);
    }
    return p;
  }

  private async parseSkillUncached(dirRel: string): Promise<ParsedSkill | null> {
    const file = joinRel(dirRel, 'SKILL.md');
    const text = await this.read(file);
    if (text === undefined) {
      this.warnings.push(`skipped ${file}: cannot read file`);
      return null;
    }
    const dirName = dirRel === '' ? basename(this.rootAbs) : baseOf(dirRel);
    let parsed: ParsedSkill;
    try {
      parsed = parseSkillMdDetailed(dirName, text, { nameFrom: this.layout?.nameFrom });
    } catch (e) {
      this.warnings.push(`skipped ${file}: ${messageOf(e)}`);
      return null;
    }
    if (parsed.def.name === 'template-skill' || (dirRel !== '' && baseOf(dirRel) === 'template')) {
      this.warnings.push(`skipped ${file}: skill template`);
      return null;
    }
    for (const issue of parsed.issues) {
      if (dirRel === '' && issue.code === 'name-mismatch') continue;
      this.warnings.push(`${file}: ${issue.message}`);
    }
    return parsed;
  }

  private async addSkill(dirRel: string, ctx?: PluginContext): Promise<Entity | undefined> {
    // A symlinked alias of an already indexed skill: reuse it without re-parsing (and re-warning).
    const sameFile = this.byReal.get(
      `skill\0${realPathOf(this.index, joinRel(dirRel, 'SKILL.md'))}`,
    );
    if (sameFile) {
      this.claimed.add(`skill\0${displayRel(dirRel)}`);
      return sameFile;
    }
    const parsed = await this.parseSkill(dirRel);
    if (!parsed) return undefined;
    const parentDir = this.parentSkillDir(dirRel);
    const parent =
      parentDir !== undefined ? (await this.parseSkill(parentDir))?.def.name : undefined;
    const skill = withoutUndefined({ ...parsed.def, parent });
    return this.add(
      withoutUndefined({
        kind: 'skill' as const,
        name: skill.name,
        description: skill.description || undefined,
        version: skill.version ?? ctx?.version ?? this.tagVersion,
        path: displayRel(dirRel),
        origin: this.alias,
        plugin: ctx?.name,
        def: { kind: 'skill' as const, skill },
      }),
    );
  }

  private async addAgent(
    rel: string,
    ctx: PluginContext | undefined,
    declared: boolean,
  ): Promise<Entity | undefined> {
    this.claimed.add(`agent\0${rel}`);
    const text = await this.read(rel);
    if (text === undefined) {
      if (declared) this.warnings.push(`skipped ${rel}: cannot read file`);
      return undefined;
    }
    let parsed;
    try {
      parsed = parseAgentFileDetailed(join(this.rootAbs, rel), text);
    } catch (e) {
      this.warnings.push(`skipped ${rel}: ${messageOf(e)}`);
      return undefined;
    }
    const lower = rel.toLowerCase();
    const def = parsed.def;
    if (!declared) {
      let ok: boolean;
      if (lower.endsWith('.agent.md')) ok = def.description !== '';
      else if (lower.endsWith('.toml')) ok = def.body !== '' || def.description !== '';
      else
        ok = parsed.hasFrontmatter && parsed.declaredName !== undefined && def.description !== '';
      if (!ok) {
        if (parsed.hasFrontmatter)
          this.warnings.push(`skipped ${rel}: agent file without name/description frontmatter`);
        return undefined;
      }
    }
    // Source format from the origin-relative location (the absolute path may contain `.apm` itself).
    if (lower.endsWith('.md')) {
      if (rel.startsWith('.apm/')) def.sourceFormat = 'apm-agent-md';
      else if (lower.endsWith('.agent.md') || lower.endsWith('.chatmode.md'))
        def.sourceFormat = 'copilot-agent-md';
      else if (ctx?.format === 'cursor') def.sourceFormat = 'cursor-md';
      else if (def.sourceFormat === 'apm-agent-md') def.sourceFormat = 'claude-md';
    }
    for (const issue of parsed.issues) this.warnings.push(`${rel}: ${issue}`);
    const version =
      asString(isRecord(def.extra?.metadata) ? def.extra.metadata.version : undefined) ??
      asString(def.extra?.version);
    return this.add(
      withoutUndefined({
        kind: 'agent' as const,
        name: def.name,
        description: def.description || undefined,
        version: version ?? ctx?.version ?? this.tagVersion,
        path: rel,
        origin: this.alias,
        plugin: ctx?.name,
        def: { kind: 'agent' as const, agent: def },
      }),
    );
  }

  private async addCommand(
    rel: string,
    ctx: PluginContext | undefined,
  ): Promise<Entity | undefined> {
    this.claimed.add(`command\0${rel}`);
    const text = await this.read(rel);
    if (text === undefined) return undefined;
    let def;
    try {
      def = parseCommandFile(join(this.rootAbs, rel), text);
    } catch (e) {
      this.warnings.push(`skipped ${rel}: ${messageOf(e)}`);
      return undefined;
    }
    if (def.body.trim() === '') {
      this.warnings.push(`skipped ${rel}: empty command`);
      return undefined;
    }
    return this.add(
      withoutUndefined({
        kind: 'command' as const,
        name: def.name,
        description: def.description,
        version: ctx?.version ?? this.tagVersion,
        path: rel,
        origin: this.alias,
        plugin: ctx?.name,
        def: { kind: 'command' as const, command: def },
      }),
    );
  }

  private async addInstruction(
    rel: string,
    ctx: PluginContext | undefined,
  ): Promise<Entity | undefined> {
    this.claimed.add(`instruction\0${rel}`);
    const text = await this.read(rel);
    if (text === undefined) return undefined;
    const def = parseInstructionFile(join(this.rootAbs, rel), text);
    if (def.body.trim() === '') {
      this.warnings.push(`skipped ${rel}: empty instruction`);
      return undefined;
    }
    return this.add(
      withoutUndefined({
        kind: 'instruction' as const,
        name: def.name,
        description: def.description,
        version: ctx?.version ?? this.tagVersion,
        path: rel,
        origin: this.alias,
        plugin: ctx?.name,
        def: { kind: 'instruction' as const, instruction: def },
      }),
    );
  }

  private addMcpConfigs(json: unknown, pathRel: string, ctx: PluginContext | undefined): Entity[] {
    const out: Entity[] = [];
    for (const cfg of parseMcpJson(json)) {
      const version = ctx?.version ?? this.tagVersion;
      const mcp = {
        ...cfg,
        source: withoutUndefined({ type: 'origin' as const, ref: this.alias, version }),
      };
      out.push(
        this.add(
          withoutUndefined({
            kind: 'mcp' as const,
            name: cfg.name,
            version,
            path: pathRel,
            origin: this.alias,
            plugin: ctx?.name,
            def: { kind: 'mcp' as const, mcp },
          }),
        ),
      );
    }
    return out;
  }

  private async addMcpFile(
    rel: string,
    ctx: PluginContext | undefined,
    declared: boolean,
  ): Promise<Entity[]> {
    this.claimed.add(`mcp\0${rel}`);
    const { json, error } = await this.readJson(rel);
    if (error) {
      this.warnings.push(`skipped ${rel}: ${error}`);
      return [];
    }
    const found = this.addMcpConfigs(json, rel, ctx);
    if (found.length === 0 && declared) this.warnings.push(`${rel}: no MCP servers found`);
    return found;
  }

  /** Hook set name + plugin root for a standalone hooks file. */
  private hookIdentity(rel: string): { name: string; pluginRootRel: string } {
    const dir = dirOf(rel);
    const file = baseOf(rel);
    if (file === 'hooks.json' && baseOf(dir) === 'hooks') {
      const owner = dirOf(dir);
      return {
        name: toSlug(owner === '' ? undefined : baseOf(owner), this.alias),
        pluginRootRel: displayRel(owner),
      };
    }
    if (file === 'hooks.json' && baseOf(dirOf(dir)) === 'hooks') {
      return { name: toSlug(baseOf(dir), this.alias), pluginRootRel: dir };
    }
    const stem = file.replace(/\.json$/i, '');
    return {
      name: toSlug(stem === 'hooks' ? baseOf(dir) : stem, this.alias),
      pluginRootRel: displayRel(dir),
    };
  }

  private async addHookFile(
    rel: string,
    ctx: PluginContext | undefined,
    nameOverride?: string,
  ): Promise<Entity | undefined> {
    this.claimed.add(`hook\0${rel}`);
    const { json, error } = await this.readJson(rel);
    if (error) {
      this.warnings.push(`skipped ${rel}: ${error}`);
      return undefined;
    }
    if (!hasHooks(json)) return undefined;
    const id = this.hookIdentity(rel);
    const set = parseHooksJson(
      nameOverride ?? ctx?.name ?? id.name,
      json,
      ctx ? displayRel(ctx.rootRel) : id.pluginRootRel,
    );
    if (set.dialect === 'unknown') this.warnings.push(`${rel}: unrecognised hooks dialect`);
    return this.add(
      withoutUndefined({
        kind: 'hook' as const,
        name: set.name,
        version: ctx?.version ?? this.tagVersion,
        path: rel,
        origin: this.alias,
        plugin: ctx?.name,
        def: { kind: 'hook' as const, hooks: set },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // plugins
  // -------------------------------------------------------------------------

  /** Resolve declared file/dir/glob paths of a plugin to origin-relative files. */
  private async resolveFiles(
    rootRel: string,
    values: string[],
    kind: ResolveKind,
    pluginName: string,
  ): Promise<string[]> {
    const exts = EXTENSIONS[kind];
    const out: string[] = [];
    const expandDir = (dirRel: string) =>
      (kind === 'agent' ? filesUnder(this.index, dirRel, 2) : filesIn(this.index, dirRel)).filter(
        (f) =>
          hasExt(f, exts) &&
          !isDocFile(baseOf(f)) &&
          (dirRel === rootRel || !this.insideSkillDir(f)),
      );
    for (const v of values) {
      if (hasGlobChars(v)) {
        const matches = await this.globIn(rootRel, v, false);
        for (const m of matches) {
          const k = await this.fsKind(m);
          if (k === 'file' && hasExt(m, exts)) out.push(m);
          else if (k === 'dir') out.push(...expandDir(m));
        }
        continue;
      }
      const rel = joinRel(rootRel, v);
      if (escapesRoot(rel)) {
        this.warnings.push(`plugin ${pluginName}: path "${v}" points outside the origin; ignored`);
        continue;
      }
      const candidates = [rel];
      if (rootRel !== '') candidates.push(normRel(v));
      if (kind === 'agent') {
        for (const c of [...candidates])
          if (c.endsWith('.md') && !c.endsWith('.agent.md'))
            candidates.push(c.replace(/\.md$/, '.agent.md'));
      }
      let found = false;
      for (const c of candidates) {
        if (escapesRoot(c)) continue;
        const k = await this.fsKind(c);
        if (k === 'file') {
          out.push(c);
          found = true;
          break;
        }
        if (k === 'dir') {
          out.push(...expandDir(c));
          found = true;
          break;
        }
      }
      if (!found)
        this.warnings.push(`plugin ${pluginName}: declared ${kind} path "${v}" not found`);
    }
    return [...new Set(out)];
  }

  private async resolveSkillDecl(rootRel: string, v: string): Promise<string[]> {
    if (hasGlobChars(v)) {
      const out: string[] = [];
      for (const m of await this.globIn(rootRel, v, false)) {
        if (this.skillDirSet.has(m)) out.push(m);
        else if (baseOf(m) === 'SKILL.md') out.push(dirOf(m));
        else if (this.index.dirSet.has(m)) out.push(...this.skillDirsBelow(m));
      }
      return [...new Set(out)];
    }
    const rel = joinRel(rootRel, v);
    const candidates = [rel, joinRel(rootRel, 'skills', baseOf(normRel(v)))];
    if (rootRel !== '') candidates.push(normRel(v));
    for (const c of candidates) {
      if (escapesRoot(c)) continue;
      if (this.skillDirSet.has(c)) return [c];
      if (c === '' || this.index.dirSet.has(c)) {
        const below = this.skillDirsBelow(c);
        if (below.length > 0) return below;
      }
    }
    // Some catalogs list skill names rather than paths.
    if (!normRel(v).includes('/')) {
      for (const d of [...this.skillDirSet]
        .filter((x) => isWithinRel(x, rootRel))
        .sort(byDepthThenPath)) {
        if ((await this.parseSkill(d))?.def.name === normRel(v)) return [d];
      }
    }
    return [];
  }

  private async pluginSkillDirs(
    rootRel: string,
    declared: string[] | undefined,
    exact: boolean,
    pluginName: string,
  ): Promise<string[]> {
    const defaults = this.childSkillDirs(joinRel(rootRel, 'skills'));
    if (!declared || declared.length === 0) return defaults;
    const resolved: string[] = [];
    for (const v of declared) {
      const dirs = await this.resolveSkillDecl(rootRel, v);
      if (dirs.length === 0)
        this.warnings.push(`plugin ${pluginName}: declared skill path "${v}" not found`);
      resolved.push(...dirs);
    }
    if (exact) return resolved.length > 0 ? [...new Set(resolved)] : defaults;
    return [...new Set([...defaults, ...resolved])];
  }

  private defaultAgentFiles(rootRel: string): string[] {
    return filesUnder(this.index, joinRel(rootRel, 'agents'), 2).filter(
      (f) => hasExt(f, EXTENSIONS.agent) && !isDocFile(baseOf(f)) && !this.insideSkillDir(f),
    );
  }

  private defaultCommandFiles(rootRel: string): string[] {
    const commands = filesIn(this.index, joinRel(rootRel, 'commands')).filter(
      (f) => hasExt(f, EXTENSIONS.command) && !isDocFile(baseOf(f)),
    );
    const prompts = filesIn(this.index, joinRel(rootRel, 'prompts')).filter((f) =>
      f.endsWith('.prompt.md'),
    );
    // `.md` before `.toml` so Claude commands win over Gemini twins with the same name.
    return [
      ...commands.filter((f) => f.endsWith('.md')),
      ...commands.filter((f) => f.endsWith('.toml')),
      ...prompts,
    ];
  }

  private defaultRuleFiles(rootRel: string): string[] {
    const rules = filesIn(this.index, joinRel(rootRel, 'rules')).filter(
      (f) => hasExt(f, EXTENSIONS.instruction) && !isDocFile(baseOf(f)),
    );
    const instructions = filesIn(this.index, joinRel(rootRel, 'instructions')).filter(
      (f) => f.endsWith('.md') && !isDocFile(baseOf(f)),
    );
    return [...rules, ...instructions];
  }

  private async addPluginHooks(
    rootRel: string,
    decl: ComponentDecls['hooks'],
    ctx: PluginContext,
    manifestRel: string,
    pluginName: string,
  ): Promise<Entity | undefined> {
    const sources: Array<{ path: string; json: unknown }> = [];
    const seen = new Set<string>();
    const addFile = async (rel: string) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      this.claimed.add(`hook\0${rel}`);
      const { json, error } = await this.readJson(rel);
      if (error) this.warnings.push(`skipped ${rel}: ${error}`);
      else sources.push({ path: rel, json });
    };
    for (const p of decl?.paths ?? []) {
      const candidates = [joinRel(rootRel, p)];
      if (rootRel !== '') candidates.push(normRel(p));
      let found = false;
      for (const c of candidates) {
        if (!escapesRoot(c) && (await this.fsKind(c)) === 'file') {
          await addFile(c);
          found = true;
          break;
        }
      }
      if (!found) this.warnings.push(`plugin ${pluginName}: declared hooks path "${p}" not found`);
    }
    for (const inline of decl?.inline ?? []) sources.push({ path: manifestRel, json: inline });
    const defaultFile = joinRel(rootRel, 'hooks/hooks.json');
    // Cursor manifests name their hooks file explicitly; Claude/Codex merge with hooks/hooks.json.
    const useDefault = ctx.format !== 'cursor' || (decl?.paths.length ?? 0) === 0;
    if (useDefault && this.index.fileSet.has(defaultFile)) await addFile(defaultFile);

    const usable = sources.filter((s) => hasHooks(s.json));
    const first = usable[0];
    if (!first) return undefined;
    const primary = detectHookDialect(first.json);
    let raw: unknown = normalizeHooksJson(first.json);
    for (const s of usable.slice(1)) {
      const d = detectHookDialect(s.json);
      if (d !== primary) {
        this.warnings.push(
          `plugin ${pluginName}: hooks in ${s.path} use the ${d} dialect (primary ${primary}); ignored`,
        );
        continue;
      }
      raw = mergeHooksRaw(raw, s.json);
    }
    const name = ctx.name ?? toSlug(baseOf(rootRel), this.alias);
    const set = parseHooksJson(name, raw, displayRel(rootRel));
    if (set.dialect === 'unknown') this.warnings.push(`${first.path}: unrecognised hooks dialect`);
    return this.add(
      withoutUndefined({
        kind: 'hook' as const,
        name,
        version: ctx.version ?? this.tagVersion,
        path: first.path,
        origin: this.alias,
        plugin: ctx.name,
        def: { kind: 'hook' as const, hooks: set },
      }),
    );
  }

  private async addPluginMcp(
    rootRel: string,
    decl: ComponentDecls['mcpServers'],
    ctx: PluginContext,
    manifestRel: string,
    pluginName: string,
  ): Promise<Entity[]> {
    const out: Entity[] = [];
    const seen = new Set<string>();
    for (const p of decl?.paths ?? []) {
      const candidates = [joinRel(rootRel, p)];
      if (rootRel !== '') candidates.push(normRel(p));
      let found = false;
      for (const c of candidates) {
        if (!escapesRoot(c) && (await this.fsKind(c)) === 'file') {
          if (!seen.has(c)) {
            seen.add(c);
            out.push(...(await this.addMcpFile(c, ctx, true)));
          }
          found = true;
          break;
        }
      }
      if (!found)
        this.warnings.push(`plugin ${pluginName}: declared mcpServers path "${p}" not found`);
    }
    for (const inline of decl?.inline ?? [])
      out.push(...this.addMcpConfigs(inline, manifestRel, ctx));
    for (const f of ['.mcp.json', 'mcp.json']) {
      const rel = joinRel(rootRel, f);
      if (seen.has(rel) || !this.index.fileSet.has(rel)) continue;
      seen.add(rel);
      out.push(...(await this.addMcpFile(rel, ctx, false)));
    }
    return out;
  }

  private async scanPlugin(input: {
    rootRel: string;
    manifest?: PluginManifest;
    entry?: MarketplaceEntry;
    /** Entry source is the marketplace root (`./`): a declared skills list is the complete set. */
    sharedRoot?: boolean;
    marketplaceRel?: string;
  }): Promise<void> {
    const { rootRel, manifest, entry } = input;
    await this.ensureIndexed(rootRel);
    const strict = entry ? entry.strict : true;
    const decls: ComponentDecls = strict
      ? mergeDecls(manifest?.components, entry?.components)
      : { ...(entry?.components ?? {}) };
    const rawName =
      manifest?.name ?? entry?.name ?? (rootRel === '' ? this.alias : baseOf(rootRel));
    const name = toSlug(rawName, baseOf(rootRel), this.alias);
    if (name !== rawName)
      this.warnings.push(`plugin name "${rawName}" is not a valid slug; using "${name}"`);
    const version = manifest?.version ?? entry?.version;
    const manifestRel = manifest
      ? joinRel(rootRel, manifest.file)
      : (input.marketplaceRel ?? displayRel(rootRel));
    if (!strict && manifest && Object.keys(manifest.components).length > 0) {
      this.warnings.push(
        `plugin ${name}: strict:false marketplace entry overrides the components declared in ${manifestRel}`,
      );
    }
    const unsupported = [
      ...new Set([...(strict ? (manifest?.unsupported ?? []) : []), ...(entry?.unsupported ?? [])]),
    ];
    if (unsupported.length > 0)
      this.warnings.push(
        `plugin ${name}: ${unsupported.join(', ')} not supported by palm (ignored)`,
      );

    const duplicate = this.byName.has(`plugin\0${name}`);
    if (duplicate) {
      this.warnings.push(
        `duplicate plugin "${name}" at ${displayRel(rootRel)}: its components are indexed standalone`,
      );
    }
    const ctx: PluginContext = withoutUndefined({
      name: duplicate ? undefined : name,
      version,
      rootRel,
      format: manifest?.format,
    });

    const members: EntityRef[] = [];
    const push = (e: Entity | undefined) => {
      if (e && !members.some((m) => m.kind === e.kind && m.name === e.name))
        members.push({ kind: e.kind, name: e.name });
    };

    const exactSkills = !strict || input.sharedRoot === true;
    for (const d of await this.pluginSkillDirs(rootRel, decls.skills, exactSkills, name))
      push(await this.addSkill(d, ctx));

    const agentFiles = decls.agents
      ? await this.resolveFiles(rootRel, decls.agents, 'agent', name)
      : this.defaultAgentFiles(rootRel);
    for (const f of agentFiles) push(await this.addAgent(f, ctx, decls.agents !== undefined));

    const commandFiles = decls.commands
      ? await this.resolveFiles(rootRel, decls.commands, 'command', name)
      : this.defaultCommandFiles(rootRel);
    for (const f of commandFiles) push(await this.addCommand(f, ctx));

    const ruleFiles = decls.rules
      ? await this.resolveFiles(rootRel, decls.rules, 'instruction', name)
      : this.defaultRuleFiles(rootRel);
    for (const f of ruleFiles) push(await this.addInstruction(f, ctx));

    push(await this.addPluginHooks(rootRel, decls.hooks, ctx, manifestRel, name));
    for (const e of await this.addPluginMcp(rootRel, decls.mcpServers, ctx, manifestRel, name))
      push(e);

    if (members.length === 0) {
      this.warnings.push(
        `plugin "${name}" at ${displayRel(rootRel)} has no installable components; skipped`,
      );
      return;
    }
    if (duplicate) return;
    this.add(
      withoutUndefined({
        kind: 'plugin' as const,
        name,
        description: manifest?.description ?? entry?.description,
        version: version ?? this.tagVersion,
        path: displayRel(rootRel),
        origin: this.alias,
        def: withoutUndefined({
          kind: 'plugin' as const,
          members,
          manifestPath: manifest ? manifestRel : input.marketplaceRel,
        }),
      }),
    );
    this.pluginRoots.push({ rootRel, name });
  }

  private async scanMarketplace(
    fileAbs: string,
    rootManifest: PluginManifest | undefined,
  ): Promise<boolean> {
    let mp;
    try {
      mp = await readMarketplace(fileAbs);
    } catch (e) {
      this.warnings.push(`ignored marketplace: ${messageOf(e)}`);
      return false;
    }
    this.warnings.push(...mp.warnings);
    const marketplaceRel = normRel(fileAbs.slice(this.rootAbs.length + 1));
    const mpRootRel = mp.rootDir ? normRel(resolve(mp.rootDir).slice(this.rootAbs.length + 1)) : '';
    let rootCovered = false;
    for (const entry of mp.entries) {
      const s = entry.source;
      if (isRemoteSource(s)) {
        const hint = originHint(s);
        this.warnings.push(
          `remote plugin "${entry.name}" (${describeSource(s)}) not fetched → add it as an origin${hint ? `: palm origin add ${hint}` : ''}`,
        );
        continue;
      }
      if (s.type !== 'local') {
        this.warnings.push(
          `plugin "${entry.name}": unsupported source ${describeSource(s)}; skipped`,
        );
        continue;
      }
      const rootRel = joinRel(mpRootRel, s.path);
      if (escapesRoot(rootRel)) {
        this.warnings.push(
          `plugin "${entry.name}": source ${describeSource(s)} points outside the origin; skipped`,
        );
        continue;
      }
      if ((await this.fsKind(rootRel)) !== 'dir') {
        this.warnings.push(
          `plugin "${entry.name}": source directory ${describeSource(s)} not found; skipped`,
        );
        continue;
      }
      const manifest =
        rootRel === ''
          ? rootManifest
          : await findPluginManifest(join(this.rootAbs, rootRel), this.warnings, rootRel);
      if (rootRel === '') rootCovered = true;
      await this.scanPlugin({
        rootRel,
        manifest,
        entry,
        sharedRoot: rootRel === mpRootRel,
        marketplaceRel,
      });
    }
    if (!rootCovered && rootManifest)
      await this.scanPlugin({ rootRel: '', manifest: rootManifest });
    return true;
  }

  /** Plugin directories below the root that carry their own manifest (convention mode only). */
  private async scanNestedPlugins(): Promise<number> {
    const dirs = new Set<string>();
    for (const f of this.index.files) {
      const base = baseOf(f);
      let dir: string | undefined;
      if (base === 'plugin.json') {
        const parent = baseOf(dirOf(f));
        dir = ['.claude-plugin', '.cursor-plugin', '.codex-plugin'].includes(parent)
          ? dirOf(dirOf(f))
          : dirOf(f);
      } else if (base === 'gemini-extension.json') {
        dir = dirOf(f);
      }
      if (
        dir === undefined ||
        dir === '' ||
        dirDepth(`${dir}/x`) > 3 ||
        this.insideSkillDir(`${dir}/x`)
      )
        continue;
      dirs.add(dir);
    }
    let count = 0;
    for (const dir of [...dirs].sort(byDepthThenPath)) {
      const manifest = await findPluginManifest(join(this.rootAbs, dir), this.warnings, dir);
      if (!manifest) continue;
      const before = this.pluginRoots.length;
      await this.scanPlugin({ rootRel: dir, manifest });
      if (this.pluginRoots.length > before) count++;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // convention, APM, descriptor
  // -------------------------------------------------------------------------

  private classify(rel: string): Exclude<Kind, 'skill' | 'plugin'> | undefined {
    const segs = rel.split('/');
    const base = segs[segs.length - 1] ?? '';
    const lower = base.toLowerCase();
    const parent = segs.length >= 2 ? segs[segs.length - 2] : undefined;
    const grand = segs.length >= 3 ? segs[segs.length - 3] : undefined;
    const dirs = segs.slice(0, -1);
    if (base === 'SKILL.md') return undefined;
    if (lower.endsWith('.agent.md')) return 'agent';
    if (lower.endsWith('.instructions.md')) return 'instruction';
    if (parent === 'prompts' && lower.endsWith('.prompt.md')) return 'command';
    if (
      parent === 'commands' &&
      (lower.endsWith('.md') || lower.endsWith('.toml')) &&
      !isDocFile(base)
    )
      return 'command';
    const agentsAt = dirs.lastIndexOf('agents');
    if (
      agentsAt !== -1 &&
      agentsAt >= dirs.length - 3 &&
      (lower.endsWith('.md') || lower.endsWith('.toml')) &&
      !isDocFile(base)
    )
      return 'agent';
    if (parent === 'rules' && lower.endsWith('.mdc')) return 'instruction';
    if (parent === 'instructions' && lower.endsWith('.md') && !isDocFile(base))
      return 'instruction';
    if (base === 'hooks.json' && (parent === 'hooks' || grand === 'hooks')) return 'hook';
    if (base === '.mcp.json' || base === 'mcp.json') return 'mcp';
    return undefined;
  }

  private async scanConvention(): Promise<void> {
    if (this.skillDirSet.has('')) {
      // The whole origin is one skill; everything else is part of it.
      await this.addSkill('');
      return;
    }
    // Canonical paths before symlinked aliases, then shallowest first.
    const order = (a: string, b: string, fileOf: (x: string) => string) =>
      Number(this.isLinked(fileOf(a))) - Number(this.isLinked(fileOf(b))) || byDepthThenPath(a, b);
    const skillDirs = [...this.skillDirSet]
      .filter((d) => dirDepth(`${d}/SKILL.md`) <= SKILL_MAX_DEPTH && !isScanIgnoredRel(d))
      .sort((a, b) => order(a, b, (d) => joinRel(d, 'SKILL.md')));
    for (const d of skillDirs) {
      if (this.isClaimed('skill', d)) continue;
      await this.addSkill(d);
    }
    const files = this.index.files
      .filter((f) => dirDepth(f) <= OTHER_MAX_DEPTH)
      .sort((a, b) => order(a, b, (f) => f));
    for (const f of files) {
      const kind = this.classify(f);
      if (!kind || this.isClaimed(kind, f) || this.insideSkillDir(f) || isScanIgnoredRel(f))
        continue;
      switch (kind) {
        case 'agent':
          await this.addAgent(f, undefined, false);
          break;
        case 'command':
          await this.addCommand(f, undefined);
          break;
        case 'instruction':
          await this.addInstruction(f, undefined);
          break;
        case 'hook':
          await this.addHookFile(f, undefined);
          break;
        case 'mcp':
          await this.addMcpFile(f, undefined, false);
          break;
      }
    }
  }

  private async scanApm(apmFile: string): Promise<boolean> {
    let data: Record<string, unknown> = {};
    const text = await this.read(apmFile);
    try {
      const parsed: unknown = text === undefined ? {} : YAML.parse(text);
      if (isRecord(parsed)) data = parsed;
    } catch (e) {
      this.warnings.push(`${apmFile}: invalid YAML (${messageOf(e).split('\n')[0]})`);
    }
    const rawName = asString(data.name);
    const name = toSlug(rawName, basename(this.rootAbs), this.alias);
    const version = asString(data.version);
    const ctx: PluginContext = withoutUndefined({
      name,
      version,
      rootRel: '',
      format: 'apm' as const,
    });
    const members: EntityRef[] = [];
    const push = (e: Entity | undefined) => {
      if (e && !members.some((m) => m.kind === e.kind && m.name === e.name))
        members.push({ kind: e.kind, name: e.name });
    };

    const skillDirs = [...this.skillDirSet]
      .filter((d) => isWithinRel(d, '.apm/skills') && d !== '.apm/skills')
      .sort(byDepthThenPath);
    for (const d of skillDirs) {
      const topLevel = this.parentSkillDir(d) === undefined;
      const e = await this.addSkill(d, topLevel ? ctx : undefined);
      if (topLevel) push(e);
    }
    const md = (dir: string) =>
      filesIn(this.index, dir).filter((f) => f.endsWith('.md') && !isDocFile(baseOf(f)));
    for (const f of filesIn(this.index, '.apm/agents').filter(
      (x) => hasExt(x, EXTENSIONS.agent) && !isDocFile(baseOf(x)),
    )) {
      push(await this.addAgent(f, ctx, true));
    }
    for (const f of md('.apm/chatmodes')) push(await this.addAgent(f, ctx, true));
    for (const f of md('.apm/instructions')) push(await this.addInstruction(f, ctx));
    for (const f of [...md('.apm/prompts'), ...md('.apm/commands')])
      push(await this.addCommand(f, ctx));
    const hookFiles = filesUnder(this.index, '.apm/hooks', 1).filter((f) => f.endsWith('.json'));
    for (const f of hookFiles) {
      const stem = baseOf(f).replace(/\.json$/i, '');
      const hookName =
        stem !== 'hooks'
          ? toSlug(stem, name)
          : dirOf(f) === '.apm/hooks'
            ? name
            : toSlug(baseOf(dirOf(f)), name);
      push(await this.addHookFile(f, ctx, hookName));
    }
    if (members.length === 0) {
      this.warnings.push(
        `${apmFile}: APM package has no primitives under .apm/; scanning the repository instead`,
      );
      return false;
    }
    this.add(
      withoutUndefined({
        kind: 'plugin' as const,
        name,
        description: asString(data.description),
        version: version ?? this.tagVersion,
        path: '.',
        origin: this.alias,
        def: { kind: 'plugin' as const, members, manifestPath: apmFile },
      }),
    );
    this.pluginRoots.push({ rootRel: '', name });
    return true;
  }

  private async scanDescriptor(layout: LayoutDescriptor): Promise<void> {
    const ignore = minimalIgnoreGlobs(layout.exclude ?? []);
    const glob = async (v: string | string[] | undefined): Promise<string[]> => {
      const patterns = (Array.isArray(v) ? v : v ? [v] : [])
        .map((p) => normRel(p))
        .filter((p) => p !== '');
      if (patterns.length === 0) return [];
      const matches = await fg(patterns, {
        cwd: this.rootAbs,
        dot: true,
        onlyFiles: false,
        markDirectories: true,
        followSymbolicLinks: false,
        suppressErrors: true,
        unique: true,
        ignore,
      });
      return matches.sort(byDepthThenPath);
    };

    const skillDirs: string[] = [];
    for (const m of await glob(layout.skills)) {
      const p = m.replace(/\/$/, '');
      if (baseOf(p) === 'SKILL.md') skillDirs.push(dirOf(p));
      else if (this.skillDirSet.has(p)) skillDirs.push(p);
    }
    for (const d of [...new Set(skillDirs)].sort(byDepthThenPath)) await this.addSkill(d);
    const files = async (v: string | string[] | undefined) =>
      (await glob(v)).filter((m) => !m.endsWith('/'));
    for (const f of await files(layout.agents)) await this.addAgent(f, undefined, true);
    for (const f of await files(layout.commands)) await this.addCommand(f, undefined);
    for (const f of await files(layout.instructions)) await this.addInstruction(f, undefined);
    for (const f of await files(layout.hooks)) await this.addHookFile(f, undefined);
    for (const f of await files(layout.mcp)) await this.addMcpFile(f, undefined, true);
  }

  // -------------------------------------------------------------------------
  // post-processing
  // -------------------------------------------------------------------------

  private applyInclude(): void {
    const include = this.layout?.include;
    if (!include || include.length === 0) return;
    const keep = new Set(include);
    this.entities = this.entities.filter((e) => keep.has(e.name));
    const present = new Set(this.entities.map((e) => `${e.kind}\0${e.name}`));
    for (const e of this.entities) {
      if (e.def.kind === 'plugin')
        e.def.members = e.def.members.filter((m) => present.has(`${m.kind}\0${m.name}`));
    }
  }

  /** Entities that sit inside a plugin directory without being declared by it. */
  private warnUndeclared(): void {
    const byRoot = new Map<string, string[]>();
    for (const p of this.pluginRoots) {
      const names = byRoot.get(p.rootRel) ?? [];
      names.push(p.name);
      byRoot.set(p.rootRel, names);
    }
    // Most specific plugin root first.
    const roots = [...byRoot.keys()].sort((a, b) => dirDepth(`${b}/x`) - dirDepth(`${a}/x`));
    const found = new Map<string, Map<Kind, string[]>>();
    for (const e of this.entities) {
      if (e.kind === 'plugin' || e.plugin) continue;
      if (e.def.kind === 'skill' && e.def.skill.parent) continue;
      const rel = e.path === '.' ? '' : e.path;
      const root = roots.find((r) => isWithinRel(rel, r));
      if (root === undefined) continue;
      const kinds = found.get(root) ?? new Map<Kind, string[]>();
      kinds.set(e.kind, [...(kinds.get(e.kind) ?? []), e.name]);
      found.set(root, kinds);
    }
    for (const [root, kinds] of found) {
      const names = byRoot.get(root) ?? [];
      const parts = [...kinds].map(([kind, list]) => {
        const shown = list.slice(0, 20).join(', ') + (list.length > 20 ? ', …' : '');
        return `${plural(list.length, kind)} (${shown})`;
      });
      this.warnings.push(
        `${names.length === 1 ? 'plugin' : 'plugins'} ${names.map((n) => `"${n}"`).join(', ')} at ${displayRel(root)} ` +
          `do${names.length === 1 ? 'es' : ''} not declare ${parts.join(', ')}; indexed standalone`,
      );
    }
  }
}

/** Index the checked-out origin at `root` (DESIGN §5). */
export async function scanOrigin(root: string, spec: OriginSpec): Promise<ScanResult> {
  return new Scanner(root, spec).run();
}
