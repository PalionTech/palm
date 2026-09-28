import { describe, expect, it } from 'vitest';
import type { McpServerConfig, PalmContext, UI } from '../../src/core/types.js';
import { OriginSet } from '../../src/domain/origin-set.js';
import { detectSecrets as domainDetectSecrets } from '../../src/domain/secrets.js';
import { detectSecrets, resolveSecrets } from '../../src/mcp/secrets.js';

interface FakeCtx {
  ctx: PalmContext;
  prompts: string[];
  logs: string[];
}

/** Fake context: env map, scripted secret answers, recorded prompts and log lines. */
function fakeCtx(
  opts: { env?: Record<string, string>; interactive?: boolean; answers?: string[] } = {},
): FakeCtx {
  const prompts: string[] = [];
  const logs: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const fail = (): never => {
    throw new Error('unexpected prompt');
  };
  const ui: UI = {
    isInteractive: opts.interactive ?? false,
    pick: async () => fail(),
    pickMany: async () => fail(),
    confirm: async () => fail(),
    text: async () => fail(),
    secret: async (message: string) => {
      prompts.push(message);
      return answers.shift() ?? '';
    },
    spinner: () => ({ stop() {}, message() {} }),
  };
  const log = (level: string) => (msg: string) => logs.push(`${level}: ${msg}`);
  const ctx: PalmContext = {
    paths: {
      palmHome: '/tmp/palm-test-home',
      home: '/tmp/palm-test-user',
      projectRoot: '/tmp/palm-test-proj',
      cwd: '/tmp/palm-test-proj',
    },
    config: { origins: [] },
    origins: OriginSet.of(),
    ui,
    log: { info: log('info'), warn: log('warn'), debug: log('debug'), success: log('success') },
    env: { ...(opts.env ?? {}) },
    flags: { yes: false, dryRun: false, force: false, offline: false, verbose: true },
  };
  return { ctx, prompts, logs };
}

const brave: McpServerConfig = {
  name: 'brave',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@brave/brave-search-mcp-server@2.1.3'],
  env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' },
  secrets: [
    {
      name: 'BRAVE_API_KEY',
      in: 'env',
      required: true,
      description: 'Your API key for the service',
    },
  ],
};

const docs: McpServerConfig = {
  name: 'docs',
  transport: 'http',
  url: 'https://docs.example.com/mcp',
  headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Team': '${env:DOCS_TEAM:-core}' },
};

describe('detectSecrets', () => {
  it('is re-exported from domain/secrets (tested there)', () => {
    expect(detectSecrets).toBe(domainDetectSecrets);
  });
});

describe('resolveSecrets: env-ref', () => {
  it('returns no values and lists unset names; set names only get a debug line', async () => {
    const { ctx, prompts, logs } = fakeCtx({
      env: { DOCS_TOKEN: 'sekret-value' },
      interactive: true,
    });
    const res = await resolveSecrets(
      ctx,
      { ...docs, secrets: [{ name: 'EXTRA', in: 'env', required: false }] },
      'env-ref',
    );
    expect(res).toEqual({ values: {}, envRefs: ['EXTRA', 'DOCS_TEAM'] });
    expect(prompts).toEqual([]);
    expect(logs).toEqual(['debug: docs: DOCS_TOKEN is set in the environment']);
    expect(logs.join('\n')).not.toContain('sekret-value');
  });
});

describe('resolveSecrets: literal', () => {
  it('takes values from the environment without prompting', async () => {
    const { ctx, prompts, logs } = fakeCtx({
      env: { BRAVE_API_KEY: 'bsk-123' },
      interactive: true,
    });
    expect(await resolveSecrets(ctx, brave, 'literal')).toEqual({
      values: { BRAVE_API_KEY: 'bsk-123' },
      envRefs: [],
    });
    expect(prompts).toEqual([]);
    expect(logs.join('\n')).not.toContain('bsk-123');
  });

  it('prompts (masked) for missing secrets; an empty answer skips an optional one', async () => {
    const { ctx, prompts, logs } = fakeCtx({ interactive: true, answers: ['  tok-1  ', ''] });
    const res = await resolveSecrets(ctx, docs, 'literal');
    expect(prompts).toEqual(['DOCS_TOKEN', 'DOCS_TEAM']);
    expect(res).toEqual({ values: { DOCS_TOKEN: 'tok-1' }, envRefs: ['DOCS_TEAM'] });
    expect(logs.join('\n')).not.toContain('tok-1');
  });

  it('uses "<name> (<description>)" as the prompt label', async () => {
    const { ctx, prompts } = fakeCtx({ interactive: true, answers: ['v'] });
    await resolveSecrets(ctx, brave, 'literal');
    expect(prompts).toEqual(['BRAVE_API_KEY (Your API key for the service)']);
  });

  it('an empty answer for a required secret → E_USAGE', async () => {
    const { ctx } = fakeCtx({ interactive: true, answers: [''] });
    await expect(resolveSecrets(ctx, brave, 'literal')).rejects.toMatchObject({ code: 'E_USAGE' });
  });

  it('non-interactive: missing required → E_NON_INTERACTIVE with export hint', async () => {
    const { ctx, prompts } = fakeCtx({ interactive: false });
    await expect(resolveSecrets(ctx, brave, 'literal')).rejects.toMatchObject({
      code: 'E_NON_INTERACTIVE',
      message: expect.stringContaining('BRAVE_API_KEY'),
      hint: 'export BRAVE_API_KEY=<value> and run the same command again, or keep a reference to the variable instead of its value',
      retryWith: '--secrets env-ref',
    });
    expect(prompts).toEqual([]);
  });

  it('non-interactive: missing optional secrets are left as env refs', async () => {
    const cfg: McpServerConfig = {
      name: 'nr',
      transport: 'stdio',
      command: 'uvx',
      env: { NR_TOKEN: '${NR_TOKEN}' },
      secrets: [{ name: 'NR_TOKEN', in: 'env', required: false }],
    };
    const { ctx } = fakeCtx({ interactive: false });
    expect(await resolveSecrets(ctx, cfg, 'literal')).toEqual({
      values: {},
      envRefs: ['NR_TOKEN'],
    });
  });

  it('declared secrets and detected placeholders are unioned by name', async () => {
    const cfg: McpServerConfig = {
      ...brave,
      env: { BRAVE_API_KEY: '${BRAVE_API_KEY}', OTHER: '${OTHER_KEY}' },
    };
    const { ctx, prompts } = fakeCtx({ interactive: true, answers: ['a', 'b'] });
    expect(await resolveSecrets(ctx, cfg, 'literal')).toEqual({
      values: { BRAVE_API_KEY: 'a', OTHER_KEY: 'b' },
      envRefs: [],
    });
    expect(prompts).toEqual(['BRAVE_API_KEY (Your API key for the service)', 'OTHER_KEY']);
  });

  it('does not mutate cfg.secrets', async () => {
    const cfg: McpServerConfig = {
      ...brave,
      secrets: [{ name: 'BRAVE_API_KEY', in: 'env', required: false }],
      env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' },
    };
    const { ctx } = fakeCtx({ env: { BRAVE_API_KEY: 'x' } });
    await resolveSecrets(ctx, cfg, 'literal');
    expect(cfg.secrets).toEqual([{ name: 'BRAVE_API_KEY', in: 'env', required: false }]);
  });
});
