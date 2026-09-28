import { describe, expect, it } from 'vitest';
import { VERBS } from '../../src/commands/grammar.js';
import { runPalm } from '../support/cli.js';

const env = { NO_COLOR: '1', CI: '1', PALM_HOME: '/nonexistent-palm-home-help-test' };
const help = async (...args: string[]) => {
  const r = await runPalm([...args, '--help'], { env });
  expect(r.exitCode).toBe(0);
  return r.stdout;
};

describe('--help (dist)', () => {
  it('palm --help', async () => {
    expect(await help()).toMatchSnapshot();
  });

  it.each(VERBS.map((v) => v.name))('palm %s --help', async (verb) => {
    const text = await help(verb);
    expect(text).toMatchSnapshot();
    const examples = text
      .slice(text.indexOf('Examples:'))
      .split('\n')
      .filter((l) => l.startsWith('  palm '));
    expect(examples.length).toBeGreaterThanOrEqual(3);
    expect(examples.length).toBeLessThanOrEqual(7);
  });

  it.each([['init'], ['doctor'], ['config'], ['completion'], ['cache']])(
    'palm %s --help',
    async (utility) => {
      expect(await help(utility)).toMatchSnapshot();
    },
  );

  it('palm install mcp --help shows the ad hoc forms and the name grammar', async () => {
    const text = await help('install', 'mcp');
    expect(text).toContain('palm install mcp <name> [--env K=V]... -- <command> [args...]');
    expect(text).toContain('palm install mcp <name> --url <url> [--header K=V]...');
    expect(text).toContain('Names: name[@origin][#ref]');
  });

  it('aliases show the same help', async () => {
    expect(await help('add')).toBe(await help('install'));
    expect(await help('ls')).toBe(await help('get'));
    expect(await help('info')).toBe(await help('describe'));
  });
});
