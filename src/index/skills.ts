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
  const issues: SkillIssue[] = [];
  const fmName = asString(data.name);
  const dirSlug = isSlug(dirName) ? dirName : slugify(dirName);

  let name: string;
  if (opts.nameFrom === 'dirname') {
    name = toSlug(dirName, fmName);
  } else if (fmName === undefined) {
    name = toSlug(dirName);
    issues.push({
      code: 'name-missing',
      message: `missing frontmatter name; using directory name "${name}"`,
    });
  } else if (isSlug(fmName)) {
    name = fmName;
    if (fmName !== dirName) {
      issues.push({
        code: 'name-mismatch',
        message: `frontmatter name "${fmName}" differs from directory "${dirName}"; keeping "${fmName}"`,
      });
    }
  } else {
    name = dirSlug !== '' ? dirSlug : toSlug(fmName);
    issues.push({
      code: 'name-invalid',
      message: `frontmatter name "${fmName}" is not a valid slug; using "${name}"`,
    });
  }

  const description = asString(data.description);
  if (description === undefined)
    issues.push({ code: 'description-missing', message: 'missing frontmatter description' });

  const metadataRaw = data.metadata;
  let metadata: Record<string, string> | undefined;
  if (isRecord(metadataRaw)) {
    metadata = {};
    for (const [k, v] of Object.entries(metadataRaw)) {
      if (v === undefined || v === null) continue;
      metadata[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }

  const version =
    asString(isRecord(metadataRaw) ? metadataRaw.version : undefined) ?? asString(data.version);
  const allowedTools = asList(data['allowed-tools'] ?? data.allowedTools, { whitespace: true });

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!SPEC_KEYS.has(k)) extra[k] = v;

  const def: SkillDefinition = withoutUndefined({
    name,
    description: description ?? '',
    version,
    license: asString(data.license),
    compatibility: asString(data.compatibility),
    metadata,
    allowedTools,
    dirName: name !== dirName ? dirName : undefined,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  });
  return { def, issues, frontmatterName: fmName, body: split.body };
}
