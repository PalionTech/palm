/**
 * Agents that answer to one name in a harness's agents directory (ruling Y14): a harness picks
 * one of them, so `check` warns. Cursor, Claude Code and OpenCode read the frontmatter `name`
 * (the file stem when there is none), Codex the TOML `name`, Copilot the `.agent.md` stem.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { isRecord } from '../lib/object.js';

/** One name several agent files claim, with their absolute paths (sorted). */
export interface AgentNameClash {
  name: string;
  files: string[];
}

const AGENT_FILE = /\.(md|toml)$/i;

function stemOf(file: string): string {
  return path.basename(file).replace(/\.agent\.md$|\.md$|\.toml$/i, '');
}

/** The name a harness knows the agent file by. */
function nameIn(file: string, text: string): string {
  try {
    if (/\.toml$/i.test(file)) {
      const data = parseToml(text);
      return typeof data.name === 'string' && data.name !== '' ? data.name : stemOf(file);
    }
    if (/\.agent\.md$/i.test(file)) return stemOf(file);
    const { data } = parseFrontmatter(text);
    return isRecord(data) && typeof data.name === 'string' && data.name !== ''
      ? data.name
      : stemOf(file);
  } catch {
    return stemOf(file);
  }
}

/** Names that more than one agent file directly inside `dir` answers to; [] when `dir` is absent. */
export async function agentNameClashes(dir: string): Promise<AgentNameClash[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const byName = new Map<string, string[]>();
  for (const e of entries) {
    if (!e.isFile() || !AGENT_FILE.test(e.name)) continue;
    const abs = path.join(dir, e.name);
    const text = await fs.readFile(abs, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const name = nameIn(abs, text);
    byName.set(name, [...(byName.get(name) ?? []), abs]);
  }
  return [...byName]
    .filter(([, files]) => files.length > 1)
    .map(([name, files]) => ({ name, files: files.sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}
