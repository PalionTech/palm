import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  looksLikeSecret,
  redact,
  SECRET_KEY_RE,
  SECRET_PREFIXES,
  scanSecrets,
  scanText,
} from '../../src/secrets/scan.js';

vi.mock('../../src/core/hash.js', async (real) =>
  (await import('../exec/shims.js')).shim(real, 'core/hash'),
);
vi.mock('../../src/lib/text.js', async (real) =>
  (await import('../exec/shims.js')).shim(real, 'lib/text'),
);

/** 24 distinct characters: log2(24) ≈ 4.58 bits per character. */
const RANDOM = 'Zx8kQ2mN7pL4vR9tW3yB6cF1';
/** 24 characters over three symbols: about 1.5 bits per character. */
const REPETITIVE = 'aaaaaaaabbbbbbbbcccccccc';

describe('looksLikeSecret', () => {
  it.each([
    ['sk-', 'sk-proj-4f9Qa7Lm2Zx8kQ2mN7pL4v', undefined, 'prefix'],
    ['ghp_', 'ghp_16C7e42F292c6912E7710c838347Ae178B4a', undefined, 'prefix'],
    ['github_pat_', 'github_pat_11ABCDEFG0123456789_abcdefghij', undefined, 'prefix'],
    ['gho_', 'gho_16C7e42F292c6912E7710c838347Ae178B4a', undefined, 'prefix'],
    ['xoxa-', 'xoxa-2-1234567890-abcdefghij', undefined, 'prefix'],
    ['xoxb-', 'xoxb-1234567890-0987654321-abcdefghij', undefined, 'prefix'],
    ['xoxp-', 'xoxp-1234567890-0987654321-abcdefghij', undefined, 'prefix'],
    ['AKIA', 'AKIAIOSFODNN7EXAMPLE', undefined, 'prefix'],
    ['AIza', 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY', undefined, 'prefix'],
    ['glpat-', 'glpat-xxxxxxxxxxxxxxxxxxxx', undefined, 'prefix'],
    [
      '-----BEGIN',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA',
      undefined,
      'private-key',
    ],
    [
      'a prefixed token inside an argument',
      '--api-key=sk-ant-api03-Zx8kQ2mN7pL4vR9t',
      undefined,
      'prefix',
    ],
    ['a Bearer token', 'Bearer abcdef0123456789abcdef', undefined, 'bearer'],
    [
      'a password in a URL',
      'https://deploy:hunter2secret@example.com/r.git',
      undefined,
      'url-userinfo',
    ],
    [
      'a token parameter in a URL',
      'https://api.example.com/mcp?token=abcd1234efgh',
      undefined,
      'url-token',
    ],
    ['entropy above 3.5 under API_KEY', RANDOM, 'API_KEY', 'high-entropy'],
    ['entropy above 3.5 under Authorization', `Basic ${RANDOM}`, 'Authorization', 'high-entropy'],
    ['entropy below 3.5 under API_KEY', REPETITIVE, 'API_KEY', undefined],
    ['entropy above 3.5 under a plain key', RANDOM, 'DESCRIPTION', undefined],
    ['entropy above 3.5 without a key', RANDOM, undefined, undefined],
    ['a ${VAR} reference', '${API_KEY}', 'API_KEY', undefined],
    ['a ${env:VAR} reference', '${env:API_TOKEN}', 'API_TOKEN', undefined],
    ['a Bearer ${VAR} reference', 'Bearer ${DOCS_TOKEN}', 'Authorization', undefined],
    ['a prefix before a reference', 'sk-${OPENAI_KEY}', 'OPENAI_KEY', undefined],
    ['a URL password reference', 'https://${USER}:${PASS}@example.com', undefined, undefined],
    [
      'a runtime variable path',
      `\${CLAUDE_PLUGIN_ROOT}/servers/${RANDOM}`,
      'TOKEN_PATH',
      undefined,
    ],
    ['a shell runtime variable', `$CLAUDE_PROJECT_DIR/${RANDOM}`, 'SECRET_DIR', undefined],
    ['a short prefixed value', 'sk-abc', undefined, undefined],
    ['a short Bearer token', 'Bearer abc123', undefined, undefined],
    ['a short random value', 'Zx8kQ2mN7p', 'TOKEN', undefined],
    ['a fill-in value', '<your-api-key>', 'API_KEY', undefined],
    ['a prefix inside a word', 'task-management-system-version-two', 'TASK', undefined],
  ] as const)('%s', (_label, value, key, shape) => {
    expect(looksLikeSecret(value, key)).toBe(shape);
  });

  it('lists the DESIGN section 8 prefixes and key names', () => {
    expect(SECRET_PREFIXES).toEqual(
      expect.arrayContaining([
        'sk-',
        'ghp_',
        'github_pat_',
        'gho_',
        'AKIA',
        'AIza',
        'glpat-',
        '-----BEGIN',
      ]),
    );
    for (const key of ['api_key', 'GITHUB_TOKEN', 'clientSecret', 'PASSWORD', 'Authorization'])
      expect(SECRET_KEY_RE.test(key)).toBe(true);
    expect(SECRET_KEY_RE.test('MODE')).toBe(false);
  });

  it('never calls a ${VAR} reference a secret, whatever the key', () => {
    const name = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,30}$/);
    fc.assert(
      fc.property(
        name,
        fc.constantFrom('', 'env:'),
        fc.constantFrom('TOKEN', 'API_KEY', 'x'),
        (n, p, key) => {
          expect(looksLikeSecret(`\${${p}${n}}`, key)).toBeUndefined();
        },
      ),
    );
  });
});

describe('redact', () => {
  it('is the first 8 hex digits of the sha256, never the value', () => {
    const r = redact('ghp_16C7e42F292c6912E7710c838347Ae178B4a');
    expect(r).toMatch(/^<redacted sha256:[0-9a-f]{8}>$/);
    expect(r).not.toContain('ghp_');
    expect(redact('ghp_16C7e42F292c6912E7710c838347Ae178B4a')).toBe(r);
  });
});

describe('scanSecrets', () => {
  const cfg = {
    name: 'docs',
    transport: 'stdio',
    env: { API_KEY: RANDOM, MODE: 'fast', REF: '${DOCS_KEY}' },
    headers: { Authorization: 'Bearer abcdef0123456789abcdef' },
    args: ['--api-key', RANDOM, '--token=ghp_16C7e42F292c6912E7710c838347Ae178B4a', '--verbose'],
    url: 'https://docs.example.com/mcp?token=abcd1234efgh',
  };

  it('finds nested values with their path, shape and key, and redacts them', () => {
    expect(scanSecrets(cfg, 'mcp:docs')).toEqual([
      {
        where: 'mcp:docs.env.API_KEY',
        shape: 'high-entropy',
        key: 'API_KEY',
        redacted: redact(RANDOM),
      },
      {
        where: 'mcp:docs.headers.Authorization',
        shape: 'bearer',
        key: 'Authorization',
        redacted: redact('Bearer abcdef0123456789abcdef'),
      },
      {
        where: 'mcp:docs.args[1]',
        shape: 'high-entropy',
        key: 'api-key',
        redacted: redact(RANDOM),
      },
      {
        where: 'mcp:docs.args[2]',
        shape: 'prefix',
        key: 'token',
        redacted: redact('--token=ghp_16C7e42F292c6912E7710c838347Ae178B4a'),
      },
      {
        where: 'mcp:docs.url',
        shape: 'url-token',
        key: 'token',
        redacted: redact('https://docs.example.com/mcp?token=abcd1234efgh'),
      },
    ]);
  });

  it('joins paths after a `file:` prefix without a dot and walks palm.yaml data', () => {
    const manifest = { mcp: { docs: { headers: { 'X-Api-Key': RANDOM } } }, targets: ['claude'] };
    expect(scanSecrets(manifest, 'palm.yaml:').map((f) => f.where)).toEqual([
      'palm.yaml:mcp.docs.headers.X-Api-Key',
    ]);
  });

  it('finds nothing in references, runtime variables and plain values', () => {
    const clean = {
      env: { A: '${A}', HOME: '${HOME}' },
      args: ['-y', 'pkg@1.2.3'],
      n: 3,
      ok: true,
    };
    expect(scanSecrets(clean, 'mcp:x')).toEqual([]);
  });

  it('never puts a value in a finding', () => {
    expect(JSON.stringify(scanSecrets(cfg, 'mcp:docs'))).not.toMatch(/Zx8k|ghp_|abcdef0123/);
  });
});

describe('scanText', () => {
  it('reports one finding per line with the 1-based line number', () => {
    const text = [
      '#!/bin/sh',
      'export GITHUB_TOKEN="ghp_16C7e42F292c6912E7710c838347Ae178B4a"',
      'echo hello',
      `curl -H "Authorization: Bearer ${'x'.repeat(4)}abcdef0123456789" https://x`,
      `API_SECRET=${RANDOM}`,
      'TOKEN=${TOKEN}',
      '-----BEGIN RSA PRIVATE KEY-----',
    ].join('\r\n');
    const found = scanText(text, '.palm/assets/kit/hooks/run.sh');
    expect(found.map((f) => [f.where, f.shape, f.key])).toEqual([
      ['.palm/assets/kit/hooks/run.sh:2', 'prefix', 'GITHUB_TOKEN'],
      ['.palm/assets/kit/hooks/run.sh:4', 'bearer', undefined],
      ['.palm/assets/kit/hooks/run.sh:5', 'high-entropy', 'API_SECRET'],
      ['.palm/assets/kit/hooks/run.sh:7', 'private-key', undefined],
    ]);
    expect(found[0]?.redacted).toBe(redact('ghp_16C7e42F292c6912E7710c838347Ae178B4a'));
  });
});
