/**
 * The second persona-rerun rulings for src/secrets (scratchpad FINDINGS-v3.md), one test per
 * id. Secret-shaped values are built at runtime; none is ever a literal of this file.
 */
import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../../src/core/types.js';
import { scanText, urlSecret } from '../../src/secrets/scan.js';
import {
  plainLine,
  redactTypedArgs,
  referenceTyped,
  typedValues,
} from '../../src/secrets/typed.js';

const fill = (n: number) => 'Zx8kQ2mN7pL4vR9tW3yB6cF1'.repeat(4).slice(0, n);
/** A short typed key no shape rule knows, as Raj typed it. */
const SHORT_KEY = ['sk', 'raj', 'fake', '1234'].join('-');

function flags(cfg: Omit<McpServerConfig, 'from'>): McpServerConfig {
  return { ...cfg, from: { type: 'flags' } };
}

describe("J1' typed --arg values", () => {
  it("J1' an --arg after a flag named like a secret becomes a reference, even when short", () => {
    const args = ['server.js', '--api-key', SHORT_KEY, '--port', '8080', `--token=${SHORT_KEY}`];
    const { cfg, references } = referenceTyped(
      flags({ name: 'docs', transport: 'stdio', command: 'node', args }),
    );
    expect(cfg.args).toEqual([
      'server.js',
      '--api-key',
      '${DOCS_API_KEY}',
      '--port',
      '8080',
      '--token=${DOCS_TOKEN}',
    ]);
    expect(JSON.stringify(cfg)).not.toContain(SHORT_KEY);
    expect(typedValues(references)).toEqual({ DOCS_API_KEY: SHORT_KEY, DOCS_TOKEN: SHORT_KEY });
  });

  it("J1' a flag after a secret-named flag is not taken for its value", () => {
    const args = ['--api-key', '--verbose'];
    const { cfg } = referenceTyped(
      flags({ name: 'docs', transport: 'stdio', command: 'node', args }),
    );
    expect(cfg.args).toEqual(args);
  });

  it("J1' the hint that repeats the command writes the --arg as its reference", () => {
    const argv = ['install', 'mcp', 'docs', '--command', 'node', '--arg', '--api-key'];
    const out = redactTypedArgs([...argv, '--arg', SHORT_KEY, '--arg=--port', '--arg=8080']);
    expect(out).toEqual([...argv, '--arg', '${DOCS_API_KEY}', '--arg=--port', '--arg=8080']);
  });
});

describe("J2' plain typed values stay as typed", () => {
  it("J2' LOG_LEVEL=debug is written as typed with a note; a secret key or value is a reference", () => {
    const token = `ghp_${fill(36)}`;
    const { cfg, references, plain } = referenceTyped(
      flags({
        name: 'docs',
        transport: 'stdio',
        command: 'node',
        env: { LOG_LEVEL: 'debug', DOCS_API_KEY: SHORT_KEY, REGION_VALUE: token },
        headers: { 'X-Region': 'eu-west-1' },
      }),
    );
    expect(cfg.env).toEqual({
      LOG_LEVEL: 'debug',
      DOCS_API_KEY: '${DOCS_API_KEY}',
      REGION_VALUE: '${REGION_VALUE}',
    });
    expect(cfg.headers).toEqual({ 'X-Region': 'eu-west-1' });
    expect(references.map((r) => r.where)).toEqual(['env.DOCS_API_KEY', 'env.REGION_VALUE']);
    expect(plain).toEqual([{ where: 'env.LOG_LEVEL' }, { where: 'headers.X-Region' }]);
    expect(plainLine('docs', { where: 'env.LOG_LEVEL' })).toBe(
      'docs: env.LOG_LEVEL is written as you typed it (not a secret); a key or value that looks like a secret becomes a ${VAR} reference',
    );
  });

  it("J2' the repeated command keeps a plain --env value and references a secret one", () => {
    const out = redactTypedArgs([
      'install',
      'mcp',
      'docs',
      '--env',
      'LOG_LEVEL=debug',
      `--env=DOCS_API_KEY=${SHORT_KEY}`,
    ]);
    expect(out.slice(3)).toEqual([
      '--env',
      'LOG_LEVEL=debug',
      '--env=DOCS_API_KEY=${DOCS_API_KEY}',
    ]);
  });
});

describe('S10 a secret in a URL keeps the host', () => {
  it('S10 only the ?key= parameter becomes the reference, named after the parameter', () => {
    const key = `${['AI', 'za'].join('')}${fill(35)}`;
    const url = `https://mcp.example.com/v1?key=${key}&region=eu`;
    expect(urlSecret(url)).toEqual({ secret: key, param: 'key' });
    const { cfg, references } = referenceTyped(flags({ name: 'remote', transport: 'http', url }));
    expect(cfg.url).toBe('https://mcp.example.com/v1?key=${REMOTE_KEY}&region=eu');
    expect(references).toEqual([
      { where: 'url', variable: 'REMOTE_KEY', value: key, why: 'secret' },
    ]);
  });
});

describe("S12 X7 T13 Q2 B10 Y5' code expressions and identifiers are not values", () => {
  it.each([
    ['scripts/server.cjs', 'const TOKEN_FILE = process.env.BRAINSTORM_TOKEN_FILE || null;'],
    ['scripts/server.cjs', '  const jsonKey = JSON.stringify(String(key));'],
    ['references/hooks.md', 'const token = React.useContext(TokenContext);'],
    ['src/auth.ts', '    accessToken: process.env.POLAR_ACCESS_TOKEN!,'],
    ['src/auth.ts', '            secret: process.env.POLAR_WEBHOOK_SECRET!,'],
    ['rules/api.md', 'const queryKey = crpc.http.todos.list.queryKey();'],
    ['src/env.ts', '  RESEND_API_KEY: z.string().optional(),'],
    ['rules/api.md', "const serviceApiKey = process.env.SERVICE_API_KEY || '';"],
    ['app/main.py', 'API_KEY = os.environ["INBOUND_SERVICE_API_KEY"]'],
    ['src/client.ts', 'const apiKey = someLongIdentifierForTheClientSecretValue;'],
  ])('S12 %s: %s is no secret', (file, line) => {
    expect(scanText(line, file)).toEqual([]);
  });

  it('S12 a quoted random literal in code, an unquoted one in a config and a JWT still count', () => {
    const random = `${fill(16)}Bq3Wc5Yh${fill(16)}`;
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', `eyJ${fill(24)}`, fill(30)].join('.');
    expect(scanText(`const apiKey = "${random}";`, 'src/client.ts')).toHaveLength(1);
    expect(scanText(`API_KEY=${random}`, '.env.example')).toHaveLength(1);
    expect(scanText(`TOKEN=${jwt}`, 'notes.md')).toHaveLength(1);
  });
});
