/**
 * Minimal stand-ins for what the index consumes from other areas and what does not exist on this
 * branch yet (API.md): the closure and token exports of `src/domain/ignore.ts`, and the secret
 * shapes of `src/secrets/scan.ts`. Imports nothing from src at runtime, so a `vi.mock` factory can
 * load it:
 *
 *   vi.mock('../../src/domain/ignore.js', async (original) => ({
 *     ...(await original<object>()),
 *     ...(await import('./contract-fakes.js')).domainIgnore,
 *   }));
 */
import { createHash } from 'node:crypto';
import type {
  McpServerConfig,
  SecretFinding,
  SecretRef,
  SecretShape,
} from '../../src/core/types.js';
import type { SecretScanner } from '../../src/index/secrets.js';

/** API.md `CLOSURE_NEVER`; `*-plugin` and `.git*` are patterns. */
const CLOSURE_NEVER = [
  'SKILL.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'marketplace.json',
  'plugin.json',
  '*-plugin',
  '.git*',
  'node_modules',
];

function neverCopied(segment: string): boolean {
  return CLOSURE_NEVER.some((p) => {
    if (p.startsWith('*')) return segment.endsWith(p.slice(1));
    if (p.endsWith('*')) return segment.startsWith(p.slice(0, -1));
    return segment === p;
  });
}

export const domainIgnore = {
  CLOSURE_NEVER,
  isClosureExcluded: (rel: string): boolean => rel.split('/').some(neverCopied),
  PLUGIN_ROOT_TOKENS:
    /\$\{(?:CLAUDE_PLUGIN_ROOT(?::?-[^}]*)?|CURSOR_PLUGIN_ROOT|PLUGIN_ROOT|extensionPath)\}|\$CLAUDE_PLUGIN_ROOT\b/g,
  PROJECT_DIR_TOKENS:
    /\$\{(?:CLAUDE|CURSOR|GEMINI)_PROJECT_DIR\}|\$(?:CLAUDE|CURSOR|GEMINI)_PROJECT_DIR\b/g,
};

const PREFIX = /(?:ghp_|sk-)[A-Za-z0-9_-]{8,}/;
const BEARER = /Bearer\s+(?!\$\{)[A-Za-z0-9._-]{8,}/;

function shapeOf(value: string): SecretShape | undefined {
  if (BEARER.test(value)) return 'bearer';
  return PREFIX.test(value) ? 'prefix' : undefined;
}

export function fakeRedact(value: string): string {
  return `<redacted sha256:${createHash('sha256').update(value).digest('hex').slice(0, 8)}>`;
}

function walk(value: unknown, where: string, key?: string): SecretFinding[] {
  if (typeof value === 'string') {
    const shape = shapeOf(value);
    return shape ? [{ where, shape, redacted: fakeRedact(value), ...(key ? { key } : {}) }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => walk(v, `${where}[${i}]`));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => walk(v, `${where}.${k}`, k));
  return [];
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

function refsIn(values: Record<string, string> | undefined, where: 'env' | 'header'): SecretRef[] {
  return Object.entries(values ?? {}).flatMap(([k, v]) =>
    [...v.matchAll(PLACEHOLDER)].map((m) => ({
      name: m[1] as string,
      in: where,
      ...(where === 'header' ? { header: k } : {}),
      required: true,
    })),
  );
}

/** Known prefixes and Bearer literals only; `detectSecrets` reads `${VAR}` in env and headers. */
export const fakeSecrets: SecretScanner = {
  scanSecrets: (value, where) => walk(value, where),
  scanText: (text, where) =>
    text.split('\n').flatMap((line, i) => {
      const shape = shapeOf(line);
      return shape
        ? [{ where: `${where}:${i + 1}`, shape, redacted: fakeRedact(line.trim()) }]
        : [];
    }),
  redact: fakeRedact,
  detectSecrets: (cfg: McpServerConfig) => [
    ...refsIn(cfg.env, 'env'),
    ...refsIn(cfg.headers, 'header'),
  ],
};
