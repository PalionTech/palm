/**
 * A synthetic cursor/plugins-sized source (~4k files): `plugins` Cursor plugins, each with
 * 5 skills (plus references and scripts), 3 agents, an MCP server, a rule and junk files,
 * listed in one marketplace. Shared by test/index/scan-fs.test.ts and `npm run bench`.
 */
import { putFile } from './sandbox.js';

const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`;

/** Entities scanSource must find in a tree written by writeSyntheticSource(root, plugins). */
export function syntheticCounts(plugins = 100) {
  return { plugins, skills: plugins * 5, agents: plugins * 3, mcp: plugins, rules: plugins };
}

function pluginFiles(p: number): Array<[string, string | object]> {
  const dir = `plugin-${p}`;
  const files: Array<[string, string | object]> = [
    [
      `${dir}/.cursor-plugin/plugin.json`,
      { name: `plugin-${p}`, version: '1.0.0', skills: './skills/', agents: './agents/' },
    ],
    [
      `${dir}/mcp.json`,
      { mcpServers: { [`server-${p}`]: { type: 'http', url: `https://s${p}.example.com/mcp` } } },
    ],
    [`${dir}/README.md`, '# readme\n'],
    [`${dir}/rules/rule-${p}.mdc`, '---\nalwaysApply: true\n---\nrule\n'],
    [`${dir}/assets/logo.svg`, '<svg/>'],
  ];
  for (let s = 0; s < 5; s++) {
    const sd = `${dir}/skills/skill-${p}-${s}`;
    files.push([`${sd}/SKILL.md`, skillMd(`skill-${p}-${s}`)]);
    for (let f = 0; f < 5; f++) files.push([`${sd}/references/ref-${f}.md`, `# ref ${f}\n`]);
    files.push([`${sd}/scripts/run.py`, 'print(1)\n']);
  }
  for (let a = 0; a < 3; a++) {
    const agent = `agent-${p}-${a}`;
    files.push([`${dir}/agents/${agent}.md`, `---\nname: ${agent}\ndescription: d\n---\nbody\n`]);
  }
  return files;
}

/** Writes the synthetic source below `root`; returns the number of files written. */
export async function writeSyntheticSource(root: string, plugins = 100): Promise<number> {
  const files: Array<[string, string | object]> = [];
  for (let p = 0; p < plugins; p++) files.push(...pluginFiles(p));
  const entries = Array.from({ length: plugins }, (_, p) => ({
    name: `plugin-${p}`,
    source: `plugin-${p}`,
  }));
  files.push(['.cursor-plugin/marketplace.json', { name: 'big', plugins: entries }]);
  await Promise.all(files.map(([rel, content]) => putFile(root, rel, content)));
  return files.length;
}
