/**
 * A name the source does not offer, found in a near-miss file (ruling N1): `"reviewer" is not in
 * source ./kit` becomes `people/reviewer.md looks like an agent but is not indexed`, with the
 * layout that indexes it. The lookup reads only the files the scan's near-miss notes name, on the
 * error path, so it is synchronous.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { parseJson } from '../lib/json.js';
import { stemOf } from '../lib/names.js';
import { isRecord } from '../lib/object.js';
import { layoutFlagsOf } from './notes.js';
import { baseOf, dirOf } from './util.js';

type Shape = 'agent' | 'hook' | 'MCP';

const NEAR_MISS = /^\d+ (agent|hook|MCP)-shaped files? not indexed: (.*); add layout: (\{.*\})$/;

export interface NearMissHit {
  /** Source-relative path of the file that holds the name. */
  file: string;
  /** `people/reviewer.md looks like an agent but is not indexed`. */
  message: string;
  /** The `--layout kind=glob` arguments that index it (with what the scan found). */
  layoutArgs: string[];
  /** The same layout as palm.yaml's `layout:` value. */
  layout: string;
}

function readText(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/** Server names of an MCP-shaped JSON file. */
function serverNames(text: string): string[] {
  try {
    const json = parseJson(text);
    return isRecord(json) && isRecord(json.mcpServers) ? Object.keys(json.mcpServers) : [];
  } catch {
    return [];
  }
}

function agentName(text: string, file: string): string {
  const { data } = parseFrontmatter(text);
  return typeof data.name === 'string' && data.name !== '' ? data.name : stemOf(file, ['.md']);
}

/** True when the file answers to `name` the way the index would name what it holds. */
function answersTo(shape: Shape, file: string, text: string, name: string): boolean {
  if (shape === 'agent') return agentName(text, file) === name || stemOf(file, ['.md']) === name;
  if (shape === 'MCP') return serverNames(text).includes(name);
  return stemOf(file, ['.json']) === name || baseOf(dirOf(file)) === name;
}

function messageOf(shape: Shape, file: string, name: string): string {
  if (shape === 'agent') return `${file} looks like an agent but is not indexed`;
  if (shape === 'hook') return `${file} looks like a hooks file but is not indexed`;
  return `${file} holds an MCP server named ${name} but is not indexed`;
}

/** The near-miss file that holds `name`, if one of the scan's near-miss notes names it. */
export function nearMissFor(
  index: { root: string; warnings: readonly string[] },
  name: string,
): NearMissHit | undefined {
  for (const line of index.warnings) {
    const m = NEAR_MISS.exec(line);
    if (!m) continue;
    const [, shape, globs = '', layout = ''] = m;
    const files = fg.sync(globs.split(', '), { cwd: index.root, dot: true, onlyFiles: true });
    for (const file of files.sort()) {
      const text = readText(join(index.root, file));
      if (text !== undefined && answersTo(shape as Shape, file, text, name))
        return {
          file,
          message: messageOf(shape as Shape, file, name),
          layoutArgs: layoutFlagsOf(layout),
          layout,
        };
    }
  }
  return undefined;
}
