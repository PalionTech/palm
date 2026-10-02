/**
 * The 0.2 persona-rerun rulings for src/secrets (scratchpad FINDINGS-v2.md), one test per id.
 * Secret-shaped values are built at runtime; none is ever a literal of this file.
 */
import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../../src/core/types.js';
import { decideSecret, type GitProbe } from '../../src/secrets/policy.js';
import { isFillIn, isSecretKey, looksLikeSecret, scanSecrets } from '../../src/secrets/scan.js';
import {
  redactTypedArgs,
  referenceTyped,
  typedLine,
  typedValues,
} from '../../src/secrets/typed.js';

const HEX = '0123456789abcdef';
/** A value no detector recognises: a short prefixed key, as Raj typed it. */
const SHORT_KEY = ['sk', 'raj', 'fake', '1234'].join('-');
/** A 16-hex API key, below every length rule. */
const HEX_KEY = [...HEX].reverse().join('');

function flags(cfg: Omit<McpServerConfig, 'from'>): McpServerConfig {
  return { ...cfg, from: { type: 'flags' } };
}

describe('E6 secret keys are whole words', () => {
  it('E6 keywords is not a secret key; API_KEY, x-api-key and clientSecret are', () => {
    for (const key of ['keywords', 'KEYWORDS', 'monkey', 'max_tokens', 'description'])
      expect(isSecretKey(key)).toBe(false);
    for (const key of ['API_KEY', 'BRAVE_API_KEY', 'x-api-key', 'apiKey', 'clientSecret', 'key'])
      expect(isSecretKey(key)).toBe(true);
  });

  it('E6 a plugin keyword with high entropy is not reported as a secret', () => {
    const findings = scanSecrets(
      { keywords: ['skills', 'subagent-driven-development-Zx8kQ2mN7pL4'] },
      'plugin.json',
    );
    expect(findings).toEqual([]);
  });
});

describe('J1 typed values are references under env-ref', () => {
  it('J1 a typed --env value no detector recognises becomes ${K}', () => {
    const { cfg, references } = referenceTyped(
      flags({
        name: 'brave-search',
        transport: 'stdio',
        command: 'npx',
        env: { BRAVE_API_KEY: SHORT_KEY },
      }),
    );
    expect(cfg.env).toEqual({ BRAVE_API_KEY: '${BRAVE_API_KEY}' });
    expect(JSON.stringify(cfg)).not.toContain(SHORT_KEY);
    expect(references).toEqual([
      { where: 'env.BRAVE_API_KEY', variable: 'BRAVE_API_KEY', value: SHORT_KEY, why: 'typed' },
    ]);
    expect(typedValues(references)).toEqual({ BRAVE_API_KEY: SHORT_KEY });
  });

  it('J1 a typed 16-hex --header value becomes the header variable, keeping Bearer', () => {
    const { cfg } = referenceTyped(
      flags({
        name: 'client-docs',
        transport: 'http',
        url: 'https://docs.example/mcp',
        headers: { 'X-Api-Key': HEX_KEY, Authorization: `Bearer ${HEX_KEY}` },
      }),
    );
    expect(cfg.headers).toEqual({
      'X-Api-Key': '${CLIENT_DOCS_API_KEY}',
      Authorization: 'Bearer ${CLIENT_DOCS_TOKEN}',
    });
    expect(cfg.secrets?.map((s) => s.name)).toEqual(['CLIENT_DOCS_API_KEY', 'CLIENT_DOCS_TOKEN']);
  });

  it('J1 a value already written as a reference is kept', () => {
    const input = flags({
      name: 'docs',
      transport: 'stdio',
      command: 'node',
      env: { TOKEN: '${TOKEN}', HOME_DIR: '${HOME}/x' },
    });
    expect(referenceTyped(input)).toEqual({ cfg: input, references: [], plain: [] });
  });

  it('J1 a snippet keeps a plain setting and references a literal under a secret key', () => {
    const { cfg } = referenceTyped({
      name: 'docs',
      transport: 'stdio',
      command: 'node',
      env: { NODE_ENV: 'production', DOCS_API_KEY: HEX_KEY, KEY_FILE: '/etc/docs/key.pem' },
      from: { type: 'snippet' },
    });
    expect(cfg.env).toEqual({
      NODE_ENV: 'production',
      DOCS_API_KEY: '${DOCS_API_KEY}',
      KEY_FILE: '/etc/docs/key.pem',
    });
  });

  it('J1 the line names the variable and the harnesses, never the value', () => {
    const { references } = referenceTyped(
      flags({ name: 'brave-search', transport: 'stdio', env: { BRAVE_API_KEY: SHORT_KEY } }),
    );
    const line = typedLine('brave-search', references[0]!, ['Claude Code', 'Codex', 'Cursor']);
    expect(line).toContain('written as ${BRAVE_API_KEY}');
    expect(line).toContain('export BRAVE_API_KEY=… before starting Claude Code, Codex or Cursor');
    expect(line).not.toContain(SHORT_KEY);
  });

  it('J1 J26 a global literal inside a worktree is refused even with --force', async () => {
    const git: GitProbe = {
      gitToplevel: async () => '/dotfiles',
      isGitIgnored: async () => false,
    };
    const decision = await decideSecret(
      {
        scope: 'global',
        fromSource: false,
        requested: 'literal',
        destinationAbs: '/dotfiles/cursor/mcp.json',
        force: true,
      },
      git,
    );
    expect(decision.action).toBe('refused');
    expect(decision.reason).not.toContain('--force');
  });
});

describe('J11 hints that repeat the command redact typed values', () => {
  it('J11 --env and --header values become their references; other secrets are redacted', () => {
    const token = `ghp_${'Zx8kQ2mN7pL4vR9tW3yB6cF1'.repeat(2).slice(0, 36)}`;
    const args = [
      'install',
      'mcp',
      'brave-search',
      '--command',
      'npx',
      '--env',
      `BRAVE_API_KEY=${SHORT_KEY}`,
      `--header=X-Api-Key=${HEX_KEY}`,
      '--arg',
      `--token=${token}`,
      '-g',
    ];
    const out = redactTypedArgs(args);
    expect(out).toEqual([
      'install',
      'mcp',
      'brave-search',
      '--command',
      'npx',
      '--env',
      'BRAVE_API_KEY=${BRAVE_API_KEY}',
      '--header=X-Api-Key=${BRAVE_SEARCH_API_KEY}',
      '--arg',
      '--token=${BRAVE_SEARCH_TOKEN}',
      '-g',
    ]);
    expect(out.join(' ')).not.toContain(SHORT_KEY);
    expect(out.join(' ')).not.toContain(HEX_KEY);
    expect(out.join(' ')).not.toContain(token);
  });
});

describe('L3 fill-in placeholders become references', () => {
  it('L3 Q8 Q9 Bearer YOUR_API_KEY in a snippet becomes the optional header reference with a notice', () => {
    const { cfg, references } = referenceTyped({
      name: 'context7',
      transport: 'http',
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: 'Bearer YOUR_API_KEY' },
      from: { type: 'snippet' },
    });
    expect(cfg.headers).toEqual({ Authorization: 'Bearer ${CONTEXT7_TOKEN:-}' });
    expect(references).toEqual([
      {
        where: 'headers.Authorization',
        variable: 'CONTEXT7_TOKEN',
        value: '',
        why: 'fill-in',
        placeholder: 'YOUR_API_KEY',
        optional: true,
      },
    ]);
    expect(typedValues(references)).toEqual({});
    expect(typedLine('context7', references[0]!, ['Cursor'])).toBe(
      'context7: headers.Authorization held the placeholder YOUR_API_KEY; written as ${CONTEXT7_TOKEN:-} (optional: empty until you export CONTEXT7_TOKEN)',
    );
  });

  it('L3 common fill-ins are recognised; real words are not', () => {
    for (const t of ['YOUR_API_KEY', '<your-token>', 'xxxx', 'xxx-xxx', 'changeme', '', '****'])
      expect(isFillIn(t)).toBe(true);
    for (const t of ['production', 'yourself', 'xylophone', HEX_KEY])
      expect(isFillIn(t)).toBe(false);
  });

  it('L3 an env fill-in keeps the env key as the variable', () => {
    const { cfg } = referenceTyped({
      name: 'docs',
      transport: 'stdio',
      command: 'node',
      env: { DOCS_API_KEY: '<your-api-key>', MODE: 'xxx' },
      from: { type: 'snippet' },
    });
    expect(cfg.env).toEqual({ DOCS_API_KEY: '${DOCS_API_KEY}', MODE: 'xxx' });
  });
});

describe('D7 VS Code inputs become references', () => {
  it('D7 ${input:github_mcp_pat} becomes ${GITHUB_MCP_PAT} with a notice', () => {
    const { cfg, references } = referenceTyped({
      name: 'github',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ${input:github_mcp_pat}' },
      from: { type: 'snippet' },
    });
    expect(cfg.headers).toEqual({ Authorization: 'Bearer ${GITHUB_MCP_PAT}' });
    expect(cfg.secrets).toEqual([
      expect.objectContaining({ name: 'GITHUB_MCP_PAT', in: 'header', header: 'Authorization' }),
    ]);
    expect(typedLine('github', references[0]!, ['VS Code'])).toBe(
      'github: ${input:github_mcp_pat} is a VS Code input; written as ${GITHUB_MCP_PAT}; export GITHUB_MCP_PAT=… before starting VS Code',
    );
  });
});

describe('secret shapes a fill-in or a certificate never match (integration of Y2 and L3)', () => {
  it('a -----BEGIN block is a private key only when it says PRIVATE KEY', () => {
    const armour = (what: string) => `-----BEGIN ${what}-----\nMIIBszCCARygAwIBAgIJAK`;
    expect(looksLikeSecret(armour(`RSA PRIVATE ${'KEY'}`))).toBe('private-key');
    expect(looksLikeSecret(armour(`PRIVATE ${'KEY'}`))).toBe('private-key');
    expect(looksLikeSecret(armour('CERTIFICATE'))).toBeUndefined();
    expect(looksLikeSecret(armour('PUBLIC KEY'))).toBeUndefined();
  });

  it('a known prefix followed by a fill-in is no secret', () => {
    expect(looksLikeSecret(`ghp_${'x'.repeat(36)}`)).toBeUndefined();
    expect(looksLikeSecret(`sk-your-key-goes-here-${'x'.repeat(8)}`)).toBeUndefined();
    expect(looksLikeSecret(`ghp_${'Zx8kQ2mN7pL4vR9tW3yB6cF1'.repeat(2).slice(0, 36)}`)).toBe(
      'prefix',
    );
  });
});
