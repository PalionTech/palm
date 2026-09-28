/** SKILL.md parsing (Agent Skills spec, https://agentskills.io) with non-spec keys passed through. */

import { PalmError } from '../core/errors.js';
import type { SkillDefinition } from '../core/types.js';
import { parseFrontmatterYaml, splitFrontmatter } from '../lib/frontmatter.js';
import { isSlug, slugify } from '../lib/names.js';
import { isRecord, withoutUndefined } from '../lib/object.js';
import { asList, asString, toSlug } from './util.js';

const SPEC_KEYS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
  'allowedTools',
  'version',
]);

export interface ParsedSkill {
  def: SkillDefinition;
  /** Problems worth a warning (name mismatch, invalid name, missing description). */
  issues: SkillIssue[];
  /** The frontmatter `name` as written, if any. */
  frontmatterName?: string;
  body: string;
}

export interface SkillIssue {
  code: 'name-mismatch' | 'name-missing' | 'name-invalid' | 'description-missing';
  message: string;
}

export interface ParseSkillOptions {
  /** Canonical name from the directory instead of the frontmatter (layout `nameFrom: dirname`). */
  nameFrom?: 'frontmatter' | 'dirname';
}

/** Parse SKILL.md. Throws PalmError(E_PARSE) when the file has no frontmatter. */
export function parseSkillMd(dirName: string, text: string): SkillDefinition {
  return parseSkillMdDetailed(dirName, text).def;
}

/** Canonical name: frontmatter `name` when it is a valid slug, else derived from the directory. */
function resolveSkillName(
  dirName: string,
  fmName: string | undefined,
  opts: ParseSkillOptions,
): { name: string; issue?: SkillIssue } {
  if (opts.nameFrom === 'dirname') return { name: toSlug(dirName, fmName) };
  if (fmName === undefined) {
    const name = toSlug(dirName);
    const message = `missing frontmatter name; using directory name "${name}"`;
    return { name, issue: { code: 'name-missing', message } };
  }
  if (isSlug(fmName)) {
    if (fmName === dirName) return { name: fmName };
    const message = `frontmatter name "${fmName}" differs from directory "${dirName}"; keeping "${fmName}"`;
    return { name: fmName, issue: { code: 'name-mismatch', message } };
  }
  const dirSlug = isSlug(dirName) ? dirName : slugify(dirName);
  const name = dirSlug !== '' ? dirSlug : toSlug(fmName);
  const message = `frontmatter name "${fmName}" is not a valid slug; using "${name}"`;
  return { name, issue: { code: 'name-invalid', message } };
}

/** `metadata` as a string map (objects JSON-encoded, null/undefined values dropped). */
function metadataOf(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    metadata[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return metadata;
}

export function parseSkillMdDetailed(
  dirName: string,
  text: string,
  opts: ParseSkillOptions = {},
): ParsedSkill {
  const split = splitFrontmatter(text);
  if (!split.hasFrontmatter) {
    throw new PalmError('E_PARSE', `SKILL.md in "${dirName}" has no YAML frontmatter`);
  }
  const data = parseFrontmatterYaml(split.raw);
  const fmName = asString(data.name);
  const { name, issue } = resolveSkillName(dirName, fmName, opts);
  const issues: SkillIssue[] = issue ? [issue] : [];
  const description = asString(data.description);
  if (description === undefined)
    issues.push({ code: 'description-missing', message: 'missing frontmatter description' });
  const version =
    asString(isRecord(data.metadata) ? data.metadata.version : undefined) ?? asString(data.version);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!SPEC_KEYS.has(k)) extra[k] = v;
  const def: SkillDefinition = withoutUndefined({
    name,
    description: description ?? '',
    version,
    license: asString(data.license),
    compatibility: asString(data.compatibility),
    metadata: metadataOf(data.metadata),
    allowedTools: asList(data['allowed-tools'] ?? data.allowedTools, { whitespace: true }),
    dirName: name !== dirName ? dirName : undefined,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  });
  return { def, issues, frontmatterName: fmName, body: split.body };
}
