import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGISTRY_URL,
  type FetchLike,
  GITHUB_REGISTRY_URL,
  registryApiBase,
  resolveRegistry,
  searchRegistry,
} from '../../src/mcp/registry.js';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}

const OFFICIAL = 'io.modelcontextprotocol.registry/official';

/** Wrap a server.json the way the registry returns it. */
function item(
  server: Record<string, unknown>,
  meta: { isLatest?: boolean; status?: string } = {},
): unknown {
  return {
    server,
    _meta: { [OFFICIAL]: { status: meta.status ?? 'active', isLatest: meta.isLatest ?? true } },
  };
}

function list(servers: unknown[], nextCursor?: string): unknown {
  return {
    servers,
    metadata: nextCursor ? { nextCursor, count: servers.length } : { count: servers.length },
  };
}

type Reply = { status?: number; body?: unknown; text?: string };

/** Fake fetch routed by URL; unmatched URLs get the official registry's 404 body. */
function fakeFetch(route: (url: URL) => Reply | undefined): { fetchImpl: FetchLike; calls: URL[] } {
  const calls: URL[] = [];
  const fetchImpl: FetchLike = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const r = route(u) ?? {
      status: 404,
      body: { title: 'Not Found', status: 404, detail: 'Server not found' },
    };
    return new Response(r.text ?? JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const brave = fixture('npm-stdio-env-secret');
const github = fixture('packages-and-remotes');
const netdata = fixture('remote-http-header-secret');
const mcpbOnly = {
  name: 'io.example/bundle',
  description: 'bundle',
  version: '1.0.0',
  packages: [
    { registryType: 'mcpb', identifier: 'https://x/b.mcpb', transport: { type: 'stdio' } },
  ],
};
const otherGithub = {
  name: 'com.thenextgennexus/github-mcp-server',
  description: 'proxy',
  version: '1.0.0',
  remotes: [{ type: 'streamable-http', url: 'https://proxy.example/mcp' }],
};

describe('registryApiBase', () => {
  it.each([
    [undefined, 'https://registry.modelcontextprotocol.io/v0.1'],
    [DEFAULT_REGISTRY_URL + '/', 'https://registry.modelcontextprotocol.io/v0.1'],
    ['https://registry.modelcontextprotocol.io/v0', 'https://registry.modelcontextprotocol.io/v0'],
    [
      'https://registry.modelcontextprotocol.io/v0.1/servers',
      'https://registry.modelcontextprotocol.io/v0.1',
    ],
    [GITHUB_REGISTRY_URL, 'https://api.mcp.github.com/v0.1'],
    ['https://api.mcp.github.com/v0', 'https://api.mcp.github.com/v0.1'],
    ['https://mirror.example.com/mcp/', 'https://mirror.example.com/mcp/v0.1'],
  ])('%s → %s', (input, out) => {
    expect(registryApiBase(input)).toBe(out);
  });

  it('rejects non-http URLs', () => {
    expect(() => registryApiBase('ftp://x')).toThrow(expect.objectContaining({ code: 'E_USAGE' }));
    expect(() => registryApiBase('not a url')).toThrow(
      expect.objectContaining({ code: 'E_USAGE' }),
    );
  });
});

describe('searchRegistry', () => {
  it('queries latest versions by substring and maps candidates', async () => {
    const { fetchImpl, calls } = fakeFetch((u) =>
      u.pathname === '/v0.1/servers'
        ? { body: list([item(otherGithub), item(github)]) }
        : undefined,
    );
    const res = await searchRegistry('github', { fetchImpl });
    expect(calls).toHaveLength(1);
    const u = calls[0]!;
    expect(u.origin).toBe('https://registry.modelcontextprotocol.io');
    expect(u.searchParams.get('search')).toBe('github');
    expect(u.searchParams.get('version')).toBe('latest');
    expect(u.searchParams.get('limit')).toBe('30');
    expect(res.map((c) => c.name)).toEqual([
      'com.thenextgennexus/github-mcp-server',
      'io.github.github/github-mcp-server',
    ]);
    expect(res[1]).toMatchObject({
      description: github['description'],
      version: '1.12.2',
      config: {
        name: 'github-mcp-server',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
      },
    });
  });

  it('ranks exact short-name matches first, skips uninstallable and deleted servers, dedupes by name', async () => {
    const { fetchImpl } = fakeFetch(() => ({
      body: list([
        item(mcpbOnly),
        item({ ...brave, name: 'io.example/brave-search-mcp-server-fork' }),
        item({ ...brave, version: '2.1.2' }, { isLatest: false }),
        item(brave),
        item({ ...netdata, name: 'io.example/gone' }, { status: 'deleted' }),
      ]),
    }));
    const res = await searchRegistry('brave-search-mcp-server', { fetchImpl });
    expect(res.map((c) => `${c.name}@${c.version}`)).toEqual([
      'io.github.brave/brave-search-mcp-server@2.1.3',
      'io.example/brave-search-mcp-server-fork@2.1.3',
    ]);
  });

  it('follows nextCursor (and legacy next_cursor) until the limit is reached', async () => {
    const page = (n: number) =>
      Array.from({ length: 2 }, (_, i) => item({ ...netdata, name: `io.example/s${n}-${i}` }));
    const { fetchImpl, calls } = fakeFetch((u) => {
      const cursor = u.searchParams.get('cursor');
      if (!cursor) return { body: list(page(0), 'c1') };
      if (cursor === 'c1') return { body: { servers: page(1), metadata: { next_cursor: 'c2' } } };
      return { body: list(page(2)) };
    });
    const res = await searchRegistry('io.example', { fetchImpl, limit: 5 });
    expect(calls.map((u) => u.searchParams.get('cursor'))).toEqual([null, 'c1', 'c2']);
    expect(calls[0]!.searchParams.get('limit')).toBe('5');
    expect(res).toHaveLength(5);
  });

  it('uses GitHub registry hosts with the same API', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      body: { ...(list([item(github)]) as object), metadata: { count: 1, total: 1, per_page: 30 } },
    }));
    const res = await searchRegistry('github-mcp-server', {
      fetchImpl,
      registryUrl: GITHUB_REGISTRY_URL,
    });
    expect(calls[0]!.href.startsWith('https://api.mcp.github.com/v0.1/servers?')).toBe(true);
    expect(res).toHaveLength(1);
  });
});

describe('resolveRegistry', () => {
  it('exact name → single candidate from /versions/latest (name URL-encoded)', async () => {
    const { fetchImpl, calls } = fakeFetch((u) =>
      u.pathname === '/v0.1/servers/io.github.brave%2Fbrave-search-mcp-server/versions/latest'
        ? { body: item(brave) }
        : undefined,
    );
    const res = await resolveRegistry('io.github.brave/brave-search-mcp-server', { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(res).toEqual([
      expect.objectContaining({
        name: 'io.github.brave/brave-search-mcp-server',
        version: '2.1.3',
        config: expect.objectContaining({ command: 'npx' }),
      }),
    ]);
  });

  it('pinned version uses /versions/<v>, falling back to the versions list (GitHub serves only latest there)', async () => {
    const old = { ...github, version: '1.12.1' };
    const { fetchImpl, calls } = fakeFetch((u) => {
      if (u.pathname.endsWith('/versions')) {
        return u.searchParams.get('cursor')
          ? { body: list([item(old, { isLatest: false })]) }
          : { body: list([item(github)], 'next') };
      }
      return undefined; // /versions/1.12.1 → 404
    });
    const res = await resolveRegistry('io.github.github/github-mcp-server', {
      fetchImpl,
      version: '1.12.1',
      registryUrl: GITHUB_REGISTRY_URL,
    });
    expect(calls.map((u) => u.pathname)).toEqual([
      '/v0.1/servers/io.github.github%2Fgithub-mcp-server/versions/1.12.1',
      '/v0.1/servers/io.github.github%2Fgithub-mcp-server/versions',
      '/v0.1/servers/io.github.github%2Fgithub-mcp-server/versions',
    ]);
    expect(res.map((c) => c.version)).toEqual(['1.12.1']);
  });

  it('bare short name → all servers whose last segment matches (no exact lookup)', async () => {
    const fork = { ...brave, name: 'io.example/brave-search-mcp-server' };
    const { fetchImpl, calls } = fakeFetch((u) =>
      u.pathname === '/v0.1/servers'
        ? {
            body: list([
              item(brave),
              item(fork),
              item({ ...brave, name: 'io.example/brave-search-mcp-server-v2' }),
            ]),
          }
        : undefined,
    );
    const res = await resolveRegistry('brave-search-mcp-server', { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.searchParams.get('search')).toBe('brave-search-mcp-server');
    expect(res.map((c) => c.name)).toEqual([
      'io.github.brave/brave-search-mcp-server',
      'io.example/brave-search-mcp-server',
    ]);
  });

  it('bare name also matches the config name of generic servers (notion → com.notion/mcp)', async () => {
    const notion = fixture('remote-oauth-no-headers');
    const { fetchImpl } = fakeFetch(() => ({ body: list([item(notion)]) }));
    const res = await resolveRegistry('notion', { fetchImpl });
    expect(res.map((c) => c.name)).toEqual(['com.notion/mcp']);
  });

  it('partial namespaced name falls back to suffix match', async () => {
    const { fetchImpl, calls } = fakeFetch((u) =>
      u.pathname === '/v0.1/servers'
        ? { body: list([item(otherGithub), item(github)]) }
        : undefined,
    );
    const res = await resolveRegistry('github/github-mcp-server', { fetchImpl });
    expect(calls.map((u) => u.pathname)).toEqual([
      '/v0.1/servers/github%2Fgithub-mcp-server/versions/latest',
      '/v0.1/servers',
    ]);
    expect(calls[1]!.searchParams.get('search')).toBe('github-mcp-server');
    expect(res.map((c) => c.name)).toEqual(['io.github.github/github-mcp-server']);
  });

  it('dotted name without a slash resolves to nothing without a request', async () => {
    const { fetchImpl, calls } = fakeFetch(() => undefined);
    expect(await resolveRegistry('io.github.foo', { fetchImpl })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('unknown name → []', async () => {
    const { fetchImpl } = fakeFetch((u) =>
      u.pathname === '/v0.1/servers' ? { body: list([]) } : undefined,
    );
    expect(await resolveRegistry('io.example/nope', { fetchImpl })).toEqual([]);
  });

  it('exact match that palm cannot install surfaces the E_USAGE error', async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: item(mcpbOnly) }));
    await expect(resolveRegistry('io.example/bundle', { fetchImpl })).rejects.toMatchObject({
      code: 'E_USAGE',
    });
  });

  it('empty name → E_USAGE', async () => {
    await expect(resolveRegistry('  ', {})).rejects.toMatchObject({ code: 'E_USAGE' });
  });
});

describe('registry errors', () => {
  it('network failure → E_NETWORK with hint', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    };
    await expect(searchRegistry('x', { fetchImpl })).rejects.toMatchObject({
      code: 'E_NETWORK',
      message: expect.stringContaining('ENOTFOUND'),
      hint: expect.stringContaining('mcpRegistryUrl'),
    });
  });

  it('times out via AbortController → E_NETWORK', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    await expect(searchRegistry('x', { fetchImpl, timeoutMs: 20 })).rejects.toMatchObject({
      code: 'E_NETWORK',
      message: expect.stringContaining('did not respond within 20ms'),
    });
  });

  it('HTTP errors → E_NETWORK with the registry detail (official and GitHub bodies)', async () => {
    const official = fakeFetch(() => ({
      status: 503,
      body: { title: 'Service Unavailable', status: 503, detail: 'maintenance' },
    }));
    await expect(searchRegistry('x', { fetchImpl: official.fetchImpl })).rejects.toMatchObject({
      code: 'E_NETWORK',
      message: expect.stringMatching(/HTTP 503: maintenance/),
    });
    const gh = fakeFetch(() => ({ status: 422, body: { error: 'bad cursor' } }));
    await expect(
      searchRegistry('x', { fetchImpl: gh.fetchImpl, registryUrl: GITHUB_REGISTRY_URL }),
    ).rejects.toMatchObject({
      code: 'E_NETWORK',
      message: expect.stringMatching(/api\.mcp\.github\.com returned HTTP 422: bad cursor/),
    });
  });

  it('invalid JSON → E_PARSE; wrong envelope → E_PARSE', async () => {
    const bad = fakeFetch(() => ({ text: '<html>' }));
    await expect(searchRegistry('x', { fetchImpl: bad.fetchImpl })).rejects.toMatchObject({
      code: 'E_PARSE',
    });
    const wrong = fakeFetch(() => ({ body: { items: [] } }));
    await expect(searchRegistry('x', { fetchImpl: wrong.fetchImpl })).rejects.toMatchObject({
      code: 'E_PARSE',
    });
  });
});
