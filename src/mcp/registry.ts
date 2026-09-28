/**
 * Client for MCP registries that implement the official Registry API.
 *
 * Verified live (2026-09) against both:
 *   - https://registry.modelcontextprotocol.io  (official; serves /v0 and /v0.1, identical shapes)
 *   - https://api.mcp.github.com               (GitHub; /v0.1 matches the official shape, /v0 is a
 *                                                lossy legacy snake_case API keyed by id)
 *
 *   GET {base}/v0.1/servers?search=<substr>&version=latest&limit=<1..100>&cursor=<c>
 *       → { servers: [{ server: <server.json>, _meta: { "io.modelcontextprotocol.registry/official":
 *             { status, isLatest, publishedAt, updatedAt } } }], metadata: { nextCursor?, count } }
 *   GET {base}/v0.1/servers/{urlencoded name}/versions/{version|latest}
 *       → { server, _meta }   (404 when unknown)
 */
import { PalmError } from '../core/errors.js';
import type { RegistryCandidate } from '../core/types.js';
import { isRecord } from '../lib/object.js';
import {
  normalizeServerJson,
  registryConfigName,
  registryShortName,
  type ServerJson,
  serverJsonToConfig,
} from './serverjson.js';

export const DEFAULT_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';
/** GitHub's MCP registry (the default of Microsoft's APM). Same /v0.1 API as the official one. */
export const GITHUB_REGISTRY_URL = 'https://api.mcp.github.com';
export const REGISTRY_API_VERSION = 'v0.1';

const DEFAULT_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const DEFAULT_SEARCH_LIMIT = 30;
const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';
const LEGACY_META = 'x-io.modelcontextprotocol.registry';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Options shared by `searchRegistry` and `resolveRegistry`. */
export interface RegistryClientOptions {
  registryUrl?: string;
  /** Injected fetch (tests). Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Per-request timeout. Default 10s. */
  timeoutMs?: number;
}

export interface SearchRegistryOptions extends RegistryClientOptions {
  limit?: number;
}

export interface ResolveRegistryOptions extends RegistryClientOptions {
  version?: string;
}

interface Client {
  base: string;
  host: string;
  fetch: FetchLike;
  timeoutMs: number;
}

interface RegistryEntry {
  server: ServerJson;
  isLatest?: boolean;
  status?: string;
}

/**
 * API base for a registry URL. A bare host gets `/v0.1`; an explicit version path is kept, except
 * GitHub's legacy `/v0`, which drops header names and ignores `search`, so it is upgraded to `/v0.1`.
 */
export function registryApiBase(registryUrl: string = DEFAULT_REGISTRY_URL): string {
  let u: URL;
  try {
    u = new URL(registryUrl.trim());
  } catch {
    throw new PalmError(
      'E_USAGE',
      `Invalid MCP registry URL: ${registryUrl}`,
      `Use an http(s) URL such as ${DEFAULT_REGISTRY_URL}`,
    );
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new PalmError(
      'E_USAGE',
      `Invalid MCP registry URL: ${registryUrl}`,
      `Use an http(s) URL such as ${DEFAULT_REGISTRY_URL}`,
    );
  }
  let path = u.pathname.replace(/\/+$/, '').replace(/\/servers$/, '');
  const m = /\/v\d+(?:\.\d+)*$/.exec(path);
  if (!m) path = `${path}/${REGISTRY_API_VERSION}`;
  else if (u.host === new URL(GITHUB_REGISTRY_URL).host && m[0] === '/v0')
    path = `${path.slice(0, -3)}/${REGISTRY_API_VERSION}`;
  return `${u.origin}${path}`;
}

function client(opts: RegistryClientOptions): Client {
  const base = registryApiBase(opts.registryUrl ?? DEFAULT_REGISTRY_URL);
  return {
    base,
    host: new URL(base).host,
    fetch: opts.fetchImpl ?? ((url, init) => fetch(url, init)),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function errorDetail(text: string): string {
  try {
    const j: unknown = JSON.parse(text);
    if (isRecord(j)) {
      const d = j.detail ?? j.error ?? j.title ?? j.message;
      if (typeof d === 'string') return d;
    }
  } catch {
    // not JSON
  }
  return text.slice(0, 200).trim();
}

function timeoutLabel(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

/** GET `url`: status and body, or E_NETWORK when the registry cannot be reached in time. */
async function fetchText(c: Client, url: string): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeoutMs);
  try {
    const res = await c.fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'palm (MCP registry client)' },
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    const hint = `Check your network connection, or use another registry: palm config set mcpRegistryUrl <url>`;
    if (controller.signal.aborted) {
      const within = timeoutLabel(c.timeoutMs);
      throw new PalmError(
        'E_NETWORK',
        `MCP registry ${c.host} did not respond within ${within}`,
        hint,
      );
    }
    const err = e as { message?: string; cause?: { code?: string; message?: string } };
    const reason = err.cause?.code ?? err.cause?.message ?? err.message ?? String(e);
    throw new PalmError('E_NETWORK', `Could not reach MCP registry ${c.host}: ${reason}`, hint);
  } finally {
    clearTimeout(timer);
  }
}

/** GET a JSON document. Returns `undefined` for the statuses listed in `missing` (e.g. 404). */
async function getJson(c: Client, url: string, missing: number[] = []): Promise<unknown> {
  const { status, text } = await fetchText(c, url);
  if (missing.includes(status)) return undefined;
  if (status < 200 || status >= 300) {
    const detail = errorDetail(text);
    throw new PalmError(
      'E_NETWORK',
      `MCP registry ${c.host} returned HTTP ${status}${detail ? `: ${detail}` : ''}`,
      status >= 500
        ? 'The registry may be having problems; try again later.'
        : `Request: GET ${url}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PalmError(
      'E_PARSE',
      `MCP registry ${c.host} returned invalid JSON`,
      `Is ${c.base} an MCP registry API?`,
    );
  }
}

/** `isLatest` and `status` from the official `_meta` (or the legacy keys), first value wins. */
function applyMeta(entry: RegistryEntry, meta: unknown): void {
  if (!isRecord(meta)) return;
  const latest = meta.isLatest ?? meta.is_latest;
  if (typeof latest === 'boolean' && entry.isLatest === undefined) entry.isLatest = latest;
  if (typeof meta.status === 'string' && entry.status === undefined) entry.status = meta.status;
}

function parseEntry(item: unknown): RegistryEntry | undefined {
  if (!isRecord(item)) return undefined;
  let server: ServerJson;
  try {
    server = normalizeServerJson(item);
  } catch {
    return undefined;
  }
  const entry: RegistryEntry = { server };
  const metaRoot = isRecord(item._meta) ? item._meta : undefined;
  applyMeta(entry, metaRoot?.[OFFICIAL_META] ?? item[LEGACY_META]);
  applyMeta(entry, (server as unknown as Record<string, unknown>).versionDetail);
  return entry;
}

function parseList(body: unknown): { entries: RegistryEntry[]; nextCursor?: string } {
  if (!isRecord(body) || !Array.isArray(body.servers)) {
    throw new PalmError('E_PARSE', 'Unexpected MCP registry response: missing "servers" array');
  }
  const entries = body.servers.map(parseEntry).filter((e): e is RegistryEntry => e !== undefined);
  const meta = isRecord(body.metadata) ? body.metadata : {};
  const cursor = meta.nextCursor ?? meta.next_cursor;
  return typeof cursor === 'string' && cursor !== ''
    ? { entries, nextCursor: cursor }
    : { entries };
}

/** Latest version of every server whose name contains `search`, deduplicated by name. */
async function listLatest(c: Client, search: string, max: number): Promise<RegistryEntry[]> {
  const byName = new Map<string, RegistryEntry>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES && byName.size < max; page++) {
    const params = new URLSearchParams({
      version: 'latest',
      limit: String(Math.min(PAGE_SIZE, Math.max(1, max))),
    });
    if (search) params.set('search', search);
    if (cursor) params.set('cursor', cursor);
    const { entries, nextCursor } = parseList(
      await getJson(c, `${c.base}/servers?${params.toString()}`),
    );
    for (const e of entries) {
      if (e.status === 'deleted') continue;
      const prev = byName.get(e.server.name);
      if (!prev || (e.isLatest && !prev.isLatest)) byName.set(e.server.name, e);
    }
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return [...byName.values()];
}

/** Scan `/servers/{name}/versions` for one version (GitHub only serves the latest at /versions/{v}). */
async function findInVersionList(
  c: Client,
  name: string,
  version: string,
): Promise<RegistryEntry | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor) params.set('cursor', cursor);
    const body = await getJson(
      c,
      `${c.base}/servers/${encodeURIComponent(name)}/versions?${params.toString()}`,
      [400, 404],
    );
    if (body === undefined) return undefined;
    const { entries, nextCursor } = parseList(body);
    const hit = entries.find((e) => e.server.name === name && e.server.version === version);
    if (hit) return hit;
    if (!nextCursor || nextCursor === cursor) return undefined;
    cursor = nextCursor;
  }
  return undefined;
}

async function getServer(
  c: Client,
  name: string,
  version: string,
): Promise<RegistryEntry | undefined> {
  const url = `${c.base}/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
  // 400: GitHub's legacy /v0 rejects names (it is keyed by id); treat like "not found".
  const body = await getJson(c, url, [400, 404]);
  let entry: RegistryEntry | undefined;
  if (body !== undefined) {
    entry = parseEntry(body);
    if (!entry) throw new PalmError('E_PARSE', `Unexpected MCP registry response for ${name}`);
  } else if (version !== 'latest') {
    entry = await findInVersionList(c, name, version);
  }
  return entry && entry.status !== 'deleted' ? entry : undefined;
}

function toCandidate(server: ServerJson): RegistryCandidate {
  const cand: RegistryCandidate = { name: server.name, config: serverJsonToConfig(server) };
  if (server.description) cand.description = server.description;
  if (server.version) cand.version = server.version;
  return cand;
}

function nameMatches(query: string, registryName: string): boolean {
  const q = query.toLowerCase();
  const n = registryName.toLowerCase();
  if (q.includes('/')) return n === q || n.endsWith(`.${q}`);
  return (
    registryShortName(registryName).toLowerCase() === q ||
    registryConfigName(registryName).toLowerCase() === q
  );
}

/**
 * Search the registry (substring match on server name, latest versions only). Servers that palm
 * cannot install (mcpb-only, local HTTP packages) are left out.
 */
export async function searchRegistry(
  query: string,
  opts: SearchRegistryOptions = {},
): Promise<RegistryCandidate[]> {
  const c = client(opts);
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_SEARCH_LIMIT, PAGE_SIZE * MAX_PAGES));
  const entries = await listLatest(c, query.trim(), limit);
  const out: RegistryCandidate[] = [];
  for (const e of entries) {
    try {
      out.push(toCandidate(e.server));
    } catch {
      // not installable by palm; skip in search results
    }
  }
  const q = query.trim();
  const exact = q ? out.filter((cand) => nameMatches(q, cand.name)) : [];
  const rest = out.filter((cand) => !exact.includes(cand));
  return [...exact, ...rest].slice(0, limit);
}

/** Candidates for the servers `matches` names, at `version`; the first non-network error is thrown only when none resolved. */
async function candidatesAt(
  c: Client,
  matches: RegistryEntry[],
  version: string,
): Promise<RegistryCandidate[]> {
  const out: RegistryCandidate[] = [];
  let firstError: unknown;
  for (const m of matches) {
    try {
      const entry = version === 'latest' ? m : await getServer(c, m.server.name, version);
      if (entry) out.push(toCandidate(entry.server));
    } catch (e) {
      if (e instanceof PalmError && e.code === 'E_NETWORK') throw e;
      firstError ??= e;
    }
  }
  if (!out.length && firstError) throw firstError;
  return out;
}

/**
 * Resolve a registry reference to install candidates.
 *
 * 1. `namespace/name` → exact lookup (`version` or latest). Found → that single candidate.
 * 2. No `/` and no `.` → every server whose short name (last path segment) or config name equals it.
 *    With `/` (not found exactly) → servers whose full name ends with `.<query>` (e.g.
 *    `github/github-mcp-server` → `io.github.github/github-mcp-server`) or matches case-insensitively.
 * Multiple results are returned as-is; the engine shows a picker.
 */
export async function resolveRegistry(
  name: string,
  opts: ResolveRegistryOptions = {},
): Promise<RegistryCandidate[]> {
  const query = name.trim();
  if (!query) throw new PalmError('E_USAGE', 'MCP server name is empty');
  const c = client(opts);
  const version = opts.version?.trim() || 'latest';
  const hasSlash = query.includes('/');

  if (hasSlash) {
    const exact = await getServer(c, query, version);
    if (exact) return [toCandidate(exact.server)];
  } else if (query.includes('.')) {
    return [];
  }

  const search = hasSlash ? registryShortName(query) : query;
  const matches = (await listLatest(c, search, PAGE_SIZE * MAX_PAGES)).filter((e) =>
    nameMatches(query, e.server.name),
  );
  return candidatesAt(c, matches, version);
}
