import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completionModel } from '../../src/commands/completion.js';
import { buildProgram } from '../../src/commands/program.js';
import { runPalm } from '../support/cli.js';
import { removeDir, tempDir } from '../support/sandbox.js';

const env = { NO_COLOR: '1', CI: '1', PALM_HOME: '/nonexistent-palm-home-completion-test' };

async function has(bin: string): Promise<boolean> {
  const r = await execa('sh', ['-c', `command -v ${bin}`], { reject: false });
  return r.exitCode === 0;
}

describe('palm completion', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await tempDir('palm-completion-');
  });
  afterAll(async () => removeDir(dir));

  it('the model holds verbs, aliases, utilities, kinds with short names and flags per verb', () => {
    const m = completionModel(buildProgram({ dispatch: async () => {} }));
    const install = m.commands.find((c) => c.name === 'install');
    expect(install?.aliases).toEqual(['add', 'i']);
    expect(install?.words).toEqual(
      expect.arrayContaining(['skill', 'skills', 'sk', 'origin', 'orig']),
    );
    expect(install?.words).not.toContain('target');
    expect(install?.options.flatMap((o) => o.flags)).toEqual(
      expect.arrayContaining(['--from', '--url', '--alias', '--layout']),
    );
    expect(m.commands.find((c) => c.name === 'get')?.words).toEqual(
      expect.arrayContaining(['target', 'tg', 'all']),
    );
    expect(m.commands.find((c) => c.name === 'cache')?.words).toEqual(['info', 'clean']);
    expect(m.commands.find((c) => c.name === 'why')?.words).toEqual(
      expect.arrayContaining(['skill', 'sk', 'plugins']),
    );
    expect(m.commands.find((c) => c.name === 'find')?.words).toEqual([]);
    expect(m.commands.map((c) => c.name)).not.toContain('origin'); // hidden alias
    expect(m.global.flatMap((o) => o.flags)).toEqual(
      expect.arrayContaining(['-g', '--json', '--no-color']),
    );
  });

  it.each([
    ['bash', ['-n']],
    ['zsh', ['-n']],
    ['fish', ['--no-execute']],
  ])('palm completion %s prints a script %s accepts', async (shell, check) => {
    const r = await runPalm(['completion', shell], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('install');
    expect(r.stdout).toContain('--from');
    const file = join(dir, `palm.${shell}`);
    await writeFile(file, r.stdout);
    if (!(await has(shell))) return; // e.g. fish is not installed everywhere
    const parsed = await execa(shell, [...check, file], { reject: false });
    expect(parsed.stderr).toBe('');
    expect(parsed.exitCode).toBe(0);
  });

  it('bash completes verbs, then kinds', async () => {
    if (!(await has('bash'))) return;
    const r = await runPalm(['completion', 'bash'], { env });
    const script = join(dir, 'complete.bash');
    await writeFile(
      script,
      `${r.stdout}
COMP_WORDS=(palm ins); COMP_CWORD=1; _palm; echo "\${COMPREPLY[*]}"
COMP_WORDS=(palm install s); COMP_CWORD=2; _palm; echo "\${COMPREPLY[*]}"
COMP_WORDS=(palm get --); COMP_CWORD=2; _palm; echo "\${COMPREPLY[*]}"
`,
    );
    const out = (await execa('bash', [script])).stdout.split('\n');
    expect(out[0]?.split(' ')).toEqual(['install']);
    expect(out[1]?.split(' ')).toEqual(expect.arrayContaining(['skill', 'skills', 'sk']));
    expect(out[2]?.split(' ')).toEqual(
      expect.arrayContaining(['--available', '--origin', '--json']),
    );
  });

  it('an unknown shell is a usage error', async () => {
    const r = await runPalm(['completion', 'tcsh'], { env });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('palm completion bash');
  });
});
