import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PalmError } from '../../src/core/errors.js';
import type { McpServerConfig } from '../../src/core/types.js';
import {
  normalizeServerJson,
  registryConfigName,
  registryShortName,
  serverJsonToConfig,
  upperSnake,
} from '../../src/mcp/serverjson.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

// Fixtures are real server.json documents captured from registry.modelcontextprotocol.io (2026-09).
const fixtureCases: Array<{ fixture: string; expected: McpServerConfig }> = [
  {
    fixture: 'npm-stdio-env-secret',
    expected: {
      name: 'brave-search-mcp-server',
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
      source: {
        type: 'registry',
        ref: 'io.github.brave/brave-search-mcp-server',
        version: '2.1.3',
      },
    },
  },
  {
    fixture: 'remote-http-header-secret',
    expected: {
      name: 'netdata',
      transport: 'http',
      url: 'https://app.netdata.cloud/api/v1/mcp',
      headers: { Authorization: 'Bearer ${NETDATA_CLOUD_API_TOKEN}' },
      secrets: [
        {
          name: 'NETDATA_CLOUD_API_TOKEN',
          in: 'header',
          header: 'Authorization',
          format: 'Bearer {value}',
          required: true,
          description:
            'Netdata Cloud API token (create at app.netdata.cloud > User Settings > API Tokens with scope:mcp)',
        },
      ],
      source: { type: 'registry', ref: 'io.github.netdata/mcp-server', version: '2.11.1' },
    },
  },
  {
    fixture: 'pypi-stdio-env',
    expected: {
      name: 'nr-mcp',
      transport: 'stdio',
      command: 'uvx',
      args: ['nr-mcp==1.2.2'],
      // NR_URL / NR_USER are optional, non-secret and have no default → omitted.
      env: { NR_TOKEN: '${NR_TOKEN}', NR_PASS: '${NR_PASS}' },
      secrets: [
        {
          name: 'NR_TOKEN',
          in: 'env',
          required: false,
          description: 'Bearer token for Node-RED authentication',
        },
        { name: 'NR_PASS', in: 'env', required: false, description: 'Password for Basic Auth' },
      ],
      source: { type: 'registry', ref: 'io.github.Texan-NXTassist/nr-mcp', version: '1.2.2' },
    },
  },
  {
    fixture: 'pypi-runtime-from',
    expected: {
      name: 'datasentry',
      transport: 'stdio',
      command: 'uvx',
      // `--from` in runtimeArguments names the package, so the identifier is not repeated.
      args: ['--from', 'datasentry-ai==1.0.4', 'datasentry', 'mcp'],
      source: { type: 'registry', ref: 'io.github.Jackxiaozhiren/datasentry', version: '1.0.4' },
    },
  },
  {
    fixture: 'packages-and-remotes',
    expected: {
      name: 'github-mcp-server',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: '${GITHUB_MCP_SERVER_AUTHORIZATION}' },
      secrets: [
        {
          name: 'GITHUB_MCP_SERVER_AUTHORIZATION',
          in: 'header',
          header: 'Authorization',
          required: false,
          description: 'Authorization header with authentication token (PAT or App token)',
        },
      ],
      source: { type: 'registry', ref: 'io.github.github/github-mcp-server', version: '1.12.2' },
    },
  },
  {
    fixture: 'npm-mcpb-remote',
    expected: {
      name: 'context7',
      transport: 'http',
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: '${CONTEXT7_AUTHORIZATION}' },
      secrets: [
        {
          name: 'CONTEXT7_AUTHORIZATION',
          in: 'header',
          header: 'Authorization',
          required: false,
          description: 'API key for authentication. Accepts "Bearer <key>" or the raw key.',
        },
      ],
      source: { type: 'registry', ref: 'io.github.upstash/context7', version: '4.1.1' },
    },
  },
  {
    fixture: 'remote-url-variable',
    expected: {
      name: 'stripe',
      transport: 'http',
      url: 'https://nordicmcp.eu/mcp/stripe/${STRIPE_TOKEN}',
      secrets: [
        {
          name: 'STRIPE_TOKEN',
          in: 'env',
          required: true,
          description:
            'Your NordicMCP API token (36-char UUID) for the Stripe integration — create one at https://nordicmcp.eu after adding your Stripe key',
        },
      ],
      source: { type: 'registry', ref: 'eu.nordicmcp/stripe', version: '1.0.0' },
    },
  },
  {
    fixture: 'remote-oauth-no-headers',
    expected: {
      // Generic short name "mcp" → namespace label; streamable-http preferred over sse.
      name: 'notion',
      transport: 'http',
      url: 'https://mcp.notion.com/mcp',
      source: { type: 'registry', ref: 'com.notion/mcp', version: '1.0.1' },
    },
  },
  {
    fixture: 'github-legacy-v0-item',
    expected: {
      // GitHub's legacy /v0 shape: snake_case, version_detail, header without a name (dropped).
      name: 'github-mcp-server',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      source: { type: 'registry', ref: 'io.github.github/github-mcp-server', version: '1.12.2' },
    },
  },
];

describe('serverJsonToConfig (live registry fixtures)', () => {
  it.each(fixtureCases)('$fixture', ({ fixture: name, expected }) => {
    expect(serverJsonToConfig(fixture(name))).toEqual(expected);
  });

  it('accepts a registry item wrapper {server, _meta}', () => {
    const item = {
      server: fixture('npm-stdio-env-secret'),
      _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } },
    };
    expect(serverJsonToConfig(item).command).toBe('npx');
  });

  it('rejects a local HTTP package palm cannot start', () => {
    expect(() => serverJsonToConfig(fixture('oci-http-package'))).toThrow(
      expect.objectContaining({
        code: 'E_USAGE',
        message: expect.stringContaining('localhost:8002'),
      }),
    );
  });
});

const base = { name: 'io.example/demo', description: 'd', version: '1.0.0' };

describe('serverJsonToConfig (package rules)', () => {
  const cases: Array<{ title: string; input: unknown; expected: Partial<McpServerConfig> }> = [
    {
      title: 'npm: runtime args before the package, package args after, named/positional/default',
      input: {
        ...base,
        packages: [
          {
            registryType: 'npm',
            identifier: '@scope/demo',
            version: '2.0.0',
            transport: { type: 'stdio' },
            runtimeArguments: [
              { type: 'named', name: '--node-options', value: '--max-old-space-size=512' },
            ],
            packageArguments: [
              { type: 'positional', value: 'serve' },
              { type: 'named', name: 'port', default: '8080' },
              { type: 'named', name: '--verbose' },
              { type: 'positional', valueHint: 'optional_dir' },
            ],
          },
        ],
      },
      expected: {
        name: 'demo',
        command: 'npx',
        args: [
          '-y',
          '--node-options',
          '--max-old-space-size=512',
          '@scope/demo@2.0.0',
          'serve',
          '--port',
          '8080',
        ],
      },
    },
    {
      title: 'npm without version, required positional → placeholder + secret',
      input: {
        ...base,
        packages: [
          {
            registryType: 'npm',
            identifier: 'demo-mcp',
            transport: { type: 'stdio' },
            packageArguments: [
              {
                type: 'positional',
                valueHint: 'root_dir',
                isRequired: true,
                description: 'Directory to serve',
              },
            ],
          },
        ],
      },
      expected: {
        args: ['-y', 'demo-mcp', '${DEMO_ROOT_DIR}'],
        secrets: [
          { name: 'DEMO_ROOT_DIR', in: 'env', required: true, description: 'Directory to serve' },
        ],
      },
    },
    {
      title: 'pypi without version → unpinned uvx',
      input: {
        ...base,
        packages: [{ registryType: 'pypi', identifier: 'demo-mcp', transport: { type: 'stdio' } }],
      },
      expected: { command: 'uvx', args: ['demo-mcp'] },
    },
    {
      title: 'prefers npm over pypi and oci regardless of order',
      input: {
        ...base,
        packages: [
          { registryType: 'oci', identifier: 'ghcr.io/x/demo:1', transport: { type: 'stdio' } },
          { registryType: 'pypi', identifier: 'demo', version: '1', transport: { type: 'stdio' } },
          { registryType: 'npm', identifier: 'demo', version: '1', transport: { type: 'stdio' } },
        ],
      },
      expected: { command: 'npx', args: ['-y', 'demo@1'] },
    },
    {
      title:
        'oci: env passed with -e, templated -e runtime arg → env pass-through, version appended to untagged image',
      input: {
        ...base,
        packages: [
          {
            registryType: 'oci',
            identifier: 'docker.io/acme/demo',
            version: '3.1.0',
            transport: { type: 'stdio' },
            environmentVariables: [
              { name: 'DEMO_API_KEY', isSecret: true, isRequired: true, description: 'API key' },
              { name: 'DEMO_MODE', default: 'fast' },
            ],
            runtimeArguments: [
              { type: 'named', name: '-e', value: 'STATIC=1' },
              {
                type: 'named',
                name: '-e',
                value: 'DEMO_PAT={token}',
                description: 'Optional PAT',
                variables: { token: { isSecret: true } },
              },
            ],
          },
        ],
      },
      expected: {
        command: 'docker',
        args: [
          'run',
          '-i',
          '--rm',
          '-e',
          'DEMO_API_KEY',
          '-e',
          'DEMO_MODE',
          '-e',
          'STATIC=1',
          '-e',
          'DEMO_PAT',
          'docker.io/acme/demo:3.1.0',
        ],
        env: { DEMO_API_KEY: '${DEMO_API_KEY}', DEMO_MODE: 'fast', DEMO_PAT: '${DEMO_PAT}' },
        secrets: [
          { name: 'DEMO_API_KEY', in: 'env', required: true, description: 'API key' },
          { name: 'DEMO_PAT', in: 'env', required: false, description: 'Optional PAT' },
        ],
      },
    },
    {
      title: 'oci: tagged identifier is kept as-is',
      input: {
        ...base,
        packages: [
          {
            registryType: 'oci',
            identifier: 'ghcr.io/acme/demo:1.2.3',
            version: '9',
            transport: { type: 'stdio' },
          },
        ],
      },
      expected: { args: ['run', '-i', '--rm', 'ghcr.io/acme/demo:1.2.3'] },
    },
    {
      title: 'nuget → dnx id@version --yes -- args',
      input: {
        ...base,
        packages: [
          {
            registryType: 'nuget',
            identifier: 'Acme.Demo',
            version: '0.1.0',
            transport: { type: 'stdio' },
            packageArguments: [{ type: 'positional', value: 'stdio' }],
          },
        ],
      },
      expected: { command: 'dnx', args: ['Acme.Demo@0.1.0', '--yes', '--', 'stdio'] },
    },
    {
      title: 'env var with fixed templated value and declared variable',
      input: {
        ...base,
        packages: [
          {
            registryType: 'npm',
            identifier: 'demo',
            version: '1',
            transport: { type: 'stdio' },
            environmentVariables: [
              {
                name: 'DEMO_URL',
                value: 'https://{tenant}.demo.io',
                variables: { tenant: { isRequired: true, description: 'Tenant' } },
              },
            ],
          },
        ],
      },
      expected: {
        env: { DEMO_URL: 'https://${DEMO_TENANT}.demo.io' },
        secrets: [{ name: 'DEMO_TENANT', in: 'env', required: true, description: 'Tenant' }],
      },
    },
    {
      title: 'unknown registry type with runtimeHint uses the hint',
      input: {
        ...base,
        packages: [
          {
            registryType: 'cargo',
            identifier: 'demo',
            runtimeHint: 'cargo-run',
            transport: { type: 'stdio' },
          },
        ],
      },
      expected: { command: 'cargo-run', args: ['demo'] },
    },
    {
      title: 'remote: undeclared {placeholder} in a header value is still templated',
      input: {
        ...base,
        remotes: [
          {
            type: 'sse',
            url: 'https://demo.io/sse',
            headers: [{ name: 'Authorization', value: 'Bearer {api_key}' }],
          },
        ],
      },
      expected: {
        transport: 'sse',
        headers: { Authorization: 'Bearer ${DEMO_API_KEY}' },
        secrets: [
          {
            name: 'DEMO_API_KEY',
            in: 'header',
            header: 'Authorization',
            format: 'Bearer {value}',
            required: false,
          },
        ],
      },
    },
    {
      title: 'remote: literal header and optional non-secret header without value',
      input: {
        ...base,
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://demo.io/mcp',
            headers: [
              { name: 'X-Client', value: 'palm' },
              { name: 'X-Optional', description: 'optional' },
              { name: 'X-Region', default: 'eu' },
            ],
          },
        ],
      },
      expected: { headers: { 'X-Client': 'palm', 'X-Region': 'eu' } },
    },
  ];

  it.each(cases)('$title', ({ input, expected }) => {
    expect(serverJsonToConfig(input)).toMatchObject(expected);
  });

  it('mcpb-only servers are not installable', () => {
    const input = {
      ...base,
      packages: [
        {
          registryType: 'mcpb',
          identifier: 'https://x/demo.mcpb',
          version: '1',
          transport: { type: 'stdio' },
        },
      ],
    };
    expect(() => serverJsonToConfig(input)).toThrow(PalmError);
    expect(() => serverJsonToConfig(input)).toThrow(
      expect.objectContaining({
        code: 'E_USAGE',
        hint: expect.stringContaining('palm install mcp demo --'),
      }),
    );
  });

  it('mcpb is skipped when another package exists', () => {
    const input = {
      ...base,
      packages: [
        { registryType: 'mcpb', identifier: 'https://x/demo.mcpb', transport: { type: 'stdio' } },
        { registryType: 'pypi', identifier: 'demo', transport: { type: 'stdio' } },
      ],
    };
    expect(serverJsonToConfig(input).command).toBe('uvx');
  });

  it('errors on servers with neither remotes nor packages, and on invalid input', () => {
    expect(() => serverJsonToConfig(base)).toThrow(expect.objectContaining({ code: 'E_PARSE' }));
    expect(() => serverJsonToConfig(null)).toThrow(expect.objectContaining({ code: 'E_PARSE' }));
    expect(() => serverJsonToConfig({ description: 'no name' })).toThrow(
      expect.objectContaining({ code: 'E_PARSE' }),
    );
  });
});

describe('naming helpers', () => {
  it.each([
    [
      'io.github.brave/brave-search-mcp-server',
      'brave-search-mcp-server',
      'brave-search-mcp-server',
    ],
    ['com.notion/mcp', 'mcp', 'notion'],
    ['io.github.netdata/mcp-server', 'mcp-server', 'netdata'],
    ['microsoft/markitdown', 'markitdown', 'markitdown'],
    ['plain', 'plain', 'plain'],
  ])('%s → short %s, config %s', (name, short, config) => {
    expect(registryShortName(name)).toBe(short);
    expect(registryConfigName(name)).toBe(config);
  });

  it.each([
    ['brave-search-mcp-server', 'BRAVE_SEARCH_MCP_SERVER'],
    ['apiKey', 'API_KEY'],
    ['x-api-key', 'X_API_KEY'],
    ['1password', 'MCP_1PASSWORD'],
  ])('upperSnake(%s) = %s', (input, out) => {
    expect(upperSnake(input)).toBe(out);
  });

  it('normalizes the legacy snake_case package shape', () => {
    const legacy = {
      name: 'microsoft/markitdown',
      packages: [
        { name: 'markitdown-mcp', registry_name: '', runtime_hint: 'uvx', version: '0.0.1a4' },
      ],
      version_detail: { version: '1.0.0', is_latest: true },
    };
    const sj = normalizeServerJson(legacy);
    expect(sj.version).toBe('1.0.0');
    expect(sj.packages?.[0]).toMatchObject({
      identifier: 'markitdown-mcp',
      registryType: 'pypi',
      runtimeHint: 'uvx',
    });
    expect(serverJsonToConfig(legacy)).toMatchObject({
      name: 'markitdown',
      command: 'uvx',
      args: ['markitdown-mcp==0.0.1a4'],
    });
  });
});
