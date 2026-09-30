import { describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../../src/core/types.js';
import { resolveSecrets } from '../../src/secrets/resolve.js';
import { fakeContext } from '../exec/fakes.js';

vi.mock('../../src/core/hash.js', async (real) =>
  (await import('../exec/shims.js')).shim(real, 'core/hash'),
);
vi.mock('../../src/lib/text.js', async (real) =>
  (await import('../exec/shims.js')).shim(real, 'lib/text'),
);

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

describe('resolveSecrets: env-ref', () => {
  it('returns no values and lists unset names; set names only get a debug line', async () => {
    const { ctx, secrets, logs } = fakeContext({ env: { DOCS_TOKEN: 'sekret-value' } });
    const res = await resolveSecrets(
      ctx,
      { ...docs, secrets: [{ name: 'EXTRA', in: 'env', required: false }] },
      'env-ref',
    );
    expect(res).toEqual({ values: {}, envRefs: ['EXTRA', 'DOCS_TEAM'] });
    expect(secrets).toEqual([]);
    expect(logs).toEqual(['debug: docs: DOCS_TOKEN is set in the environment']);
    expect(logs.join('\n')).not.toContain('sekret-value');
  });
});

describe('resolveSecrets: literal', () => {
  it('takes values from the environment without prompting', async () => {
    const { ctx, secrets, logs } = fakeContext({ env: { BRAVE_API_KEY: 'bsk-123' } });
    expect(await resolveSecrets(ctx, brave, 'literal')).toEqual({
      values: { BRAVE_API_KEY: 'bsk-123' },
      envRefs: [],
    });
    expect(secrets).toEqual([]);
    expect(logs.join('\n')).not.toContain('bsk-123');
  });

  it('prompts (masked) for missing secrets; an empty answer skips an optional one', async () => {
    const { ctx, secrets, logs } = fakeContext({ secret: ['  tok-1  ', ''] });
    const res = await resolveSecrets(ctx, docs, 'literal');
    expect(secrets).toEqual(['DOCS_TOKEN', 'DOCS_TEAM']);
    expect(res).toEqual({ values: { DOCS_TOKEN: 'tok-1' }, envRefs: ['DOCS_TEAM'] });
    expect(logs.join('\n')).not.toContain('tok-1');
  });

  it('uses "<name> (<description>)" as the prompt label', async () => {
    const { ctx, secrets } = fakeContext({ secret: ['v'] });
    await resolveSecrets(ctx, brave, 'literal');
    expect(secrets).toEqual(['BRAVE_API_KEY (Your API key for the service)']);
  });

  it('an empty answer for a required secret → E_USAGE', async () => {
    const { ctx } = fakeContext({ secret: [''] });
    await expect(resolveSecrets(ctx, brave, 'literal')).rejects.toMatchObject({ code: 'E_USAGE' });
  });

  it('non-interactive: missing required → E_NON_INTERACTIVE with export hint', async () => {
    const { ctx, secrets } = fakeContext({ interactive: false });
    await expect(resolveSecrets(ctx, brave, 'literal')).rejects.toMatchObject({
      code: 'E_NON_INTERACTIVE',
      message: expect.stringContaining('BRAVE_API_KEY'),
      hint: 'export BRAVE_API_KEY=<value> and run the same command again, or keep a reference to the variable instead of its value',
      retryWith: '--secrets env-ref',
    });
    expect(secrets).toEqual([]);
  });

  it('non-interactive: missing optional secrets are left as env refs', async () => {
    const cfg: McpServerConfig = {
      name: 'nr',
      transport: 'stdio',
      command: 'uvx',
      env: { NR_TOKEN: '${NR_TOKEN}' },
      secrets: [{ name: 'NR_TOKEN', in: 'env', required: false }],
    };
    const { ctx } = fakeContext({ interactive: false });
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
    const { ctx, secrets } = fakeContext({ secret: ['a', 'b'] });
    expect(await resolveSecrets(ctx, cfg, 'literal')).toEqual({
      values: { BRAVE_API_KEY: 'a', OTHER_KEY: 'b' },
      envRefs: [],
    });
    expect(secrets).toEqual(['BRAVE_API_KEY (Your API key for the service)', 'OTHER_KEY']);
  });

  it('does not mutate cfg.secrets', async () => {
    const cfg: McpServerConfig = {
      ...brave,
      secrets: [{ name: 'BRAVE_API_KEY', in: 'env', required: false }],
      env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' },
    };
    const { ctx } = fakeContext({ env: { BRAVE_API_KEY: 'x' } });
    await resolveSecrets(ctx, cfg, 'literal');
    expect(cfg.secrets).toEqual([{ name: 'BRAVE_API_KEY', in: 'env', required: false }]);
  });
});
