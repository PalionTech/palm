/**
 * A rendered `SKILL.md` names its skill (ruling T5, contract F147): Codex and the Agent Skills
 * spec read `name:`, and a source may leave it out. When the frontmatter has no `name`, the line
 * `name: <indexed name>` is added right after the opening fence, in the file's own line ends;
 * every other byte stays as the source wrote it, so a skill that already names itself is copied
 * byte for byte.
 */
import { parseFrontmatter, splitFrontmatter } from '../lib/frontmatter.js';
import { stringifyYaml } from '../lib/yaml.js';

const BOM = '﻿';
const OPEN_FENCE = /^---[ \t]*(\r?\n)/;

/** `name: <name>` as YAML (quoted when the name needs it), without a line end. */
function nameLine(name: string): string {
  return stringifyYaml({ name }).trimEnd();
}

/** The SKILL.md text with `name:` added when its frontmatter lacks one; the bytes otherwise. */
export function withSkillName(bytes: Uint8Array, name: string): Uint8Array {
  const text = Buffer.from(bytes).toString('utf8');
  const bom = text.startsWith(BOM) ? BOM : '';
  const rest = text.slice(bom.length);
  const open = OPEN_FENCE.exec(rest);
  if (open && splitFrontmatter(rest).hasFrontmatter) {
    if ('name' in parseFrontmatter(rest).data) return bytes;
    const eol = open[1] as string;
    const after = rest.slice(open[0].length);
    return Buffer.from(`${bom}${open[0]}${nameLine(name)}${eol}${after}`, 'utf8');
  }
  const eol = rest.includes('\r\n') ? '\r\n' : '\n';
  return Buffer.from(`${bom}---${eol}${nameLine(name)}${eol}---${eol}${eol}${rest}`, 'utf8');
}
