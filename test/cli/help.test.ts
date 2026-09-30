import { describe, expect, it, vi } from 'vitest';
import { VERBS } from '../../src/commands/grammar.js';
import { runCli } from '../../src/commands/main.js';

vi.mock('../../src/commands/ports.js', () => import('./contract.js'));

async function help(...argv: string[]): Promise<string> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    version: '0.2.0',
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    env: { NO_COLOR: '1' },
  });
  expect(code).toBe(0);
  expect(stderr).toBe('');
  return stdout;
}

/** A terminal screen: 80 columns, 50 rows. */
const SCREEN_ROWS = 50;

describe('palm --help', () => {
  it('bare palm prints the root help', async () => {
    const text = await help();
    expect(text).toBe(await help('--help'));
    expect(text).toMatchSnapshot();
  });

  it('fits one screen, lists the eight verbs then the utilities, and no exit codes', async () => {
    const text = await help('--help');
    const lines = text.trimEnd().split('\n');
    expect(lines.length).toBeLessThanOrEqual(SCREEN_ROWS);
    const verbs = text.slice(text.indexOf('Verbs:'), text.indexOf('Utilities:'));
    const listed = verbs.split('\n').filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().split(/\s/)[0]);
    expect(listed).toEqual(VERBS.map((v) => v.name));
    const utilities = text.slice(text.indexOf('Utilities:'), text.indexOf('Options:'));
    for (const u of ['migrate', 'completion <shell>', 'cache clean', 'help [command]'])
      expect(utilities).toContain(u);
    expect(text).not.toMatch(/exit code/i);
    expect(text).not.toMatch(/origin/i);
    expect(text).not.toContain('--local');
    for (const hidden of ['doctor', 'audit', 'outdated', 'why', 'find', 'search', 'config'])
      expect(text).not.toMatch(new RegExp(`^ {2}${hidden}\\b`, 'm'));
  });

  it.each(VERBS.map((v) => v.name))('palm %s --help', async (verb) => {
    const text = await help(verb, '--help');
    expect(text).toMatchSnapshot();
    expect(text.split('\n').length).toBeLessThanOrEqual(SCREEN_ROWS + 10);
    expect(text).not.toMatch(/origin/i);
    const examples = text.slice(text.indexOf('Examples:')).split('\n');
    expect(examples.filter((l) => /^ {2}(palm|pbpaste)/.test(l)).length).toBeGreaterThanOrEqual(3);
  });

  it.each([['migrate'], ['completion'], ['cache']])('palm %s --help', async (utility) => {
    expect(await help(utility, '--help')).toMatchSnapshot();
  });

  it('aliases show the same help', async () => {
    expect(await help('add', '--help')).toBe(await help('install', '--help'));
    expect(await help('rm', '--help')).toBe(await help('remove', '--help'));
    expect(await help('ls', '--help')).toBe(await help('get', '--help'));
    expect(await help('info', '--help')).toBe(await help('describe', '--help'));
    expect(await help('new', '--help')).toBe(await help('create', '--help'));
    expect(await help('up', '--help')).toBe(await help('update', '--help'));
  });

  it('palm help <verb> is the verb help', async () => {
    expect(await help('help', 'install')).toBe(await help('install', '--help'));
  });

  it('--version prints the version', async () => {
    expect(await help('--version')).toBe('0.2.0\n');
  });
});
