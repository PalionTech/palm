import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { McpServerConfig, SecretRef } from '../../src/core/types.js';
import {
  allSecrets,
  detectSecrets,
  optionalSecretNames,
  requiredSecretNames,
} from '../../src/domain/secrets.js';
import { findPlaceholders, isRuntimeVar } from '../../src/lib/placeholders.js';

const docs: McpServerConfig = {
  name: 'docs',
  transport: 'http',
  url: 'https://docs.example.com/mcp',
  headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Team': '${env:DOCS_TEAM:-core}' },
};

describe('detectSecrets', () => {
  it('finds ${VAR}, ${env:VAR} and ${VAR:-default} in env, headers, url and args (runtime vars excluded)', () => {
    const cfg: McpServerConfig = {
      name: 'x',
      transport: 'stdio',
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/server.js', '--token=${ARG_TOKEN}'],
      env: {
        A: '${A_KEY}',
        B: 'prefix-${env:B_KEY}',
        C: '${C_KEY:-fallback}',
        D: 'literal',
        E: '${CLAUDE_PLUGIN_ROOT}/data',
      },
    };
    expect(detectSecrets(cfg)).toEqual([
      { name: 'A_KEY', in: 'env', required: true },
      { name: 'B_KEY', in: 'env', required: true },
      { name: 'C_KEY', in: 'env', required: false },
      { name: 'ARG_TOKEN', in: 'env', required: true },
    ]);
  });

  it('records header name and format template', () => {
    expect(detectSecrets(docs)).toEqual([
      {
        name: 'DOCS_TOKEN',
        in: 'header',
        header: 'Authorization',
        required: true,
        format: 'Bearer {value}',
      },
      { name: 'DOCS_TEAM', in: 'header', header: 'X-Team', required: false },
    ]);
    expect(detectSecrets({ name: 'u', transport: 'http', url: 'https://x/${TENANT}/mcp' })).toEqual(
      [{ name: 'TENANT', in: 'env', required: true }],
    );
  });

  it('dedupes by name, ORs required and lets a header use win over env', () => {
    const cfg: McpServerConfig = {
      name: 'x',
      transport: 'http',
      url: 'https://x',
      env: { A: '${K:-d}', B: '${K}' },
      headers: { Authorization: 'Bearer ${K}' },
    };
    expect(detectSecrets(cfg)).toEqual([
      {
        name: 'K',
        in: 'header',
        header: 'Authorization',
        required: true,
        format: 'Bearer {value}',
      },
    ]);
  });

  it('ignores non-string values from untyped JSON', () => {
    const cfg = {
      name: 'x',
      transport: 'stdio',
      command: 'x',
      env: { A: 1 },
      headers: { H: null },
      args: [true, '${OK}'],
    } as unknown as McpServerConfig;
    expect(detectSecrets(cfg)).toEqual([{ name: 'OK', in: 'env', required: true }]);
  });
});

describe('allSecrets / optionalSecretNames / requiredSecretNames', () => {
  const cfg: McpServerConfig = {
    name: 'c',
    transport: 'http',
    url: 'https://c/${REGION:-eu}',
    headers: { Authorization: '${AUTH}' },
    env: { X: '${EXTRA}' },
    secrets: [
      { name: 'AUTH', in: 'header', header: 'Authorization', required: false, description: 'd' },
      { name: 'DECLARED_ONLY', in: 'env', required: true },
    ],
  };

  it('unions declared and detected secrets by name; declared entries win', () => {
    expect(allSecrets(cfg)).toEqual([
      { name: 'AUTH', in: 'header', header: 'Authorization', required: false, description: 'd' },
      { name: 'DECLARED_ONLY', in: 'env', required: true },
      { name: 'EXTRA', in: 'env', required: true },
      { name: 'REGION', in: 'env', required: false },
    ]);
  });

  it('splits the names into optional and required', () => {
    expect([...optionalSecretNames(cfg)].sort()).toEqual(['AUTH', 'REGION']);
    expect([...requiredSecretNames(cfg)].sort()).toEqual(['DECLARED_ONLY', 'EXTRA']);
  });

  it('never mutates cfg.secrets', () => {
    const declared: SecretRef[] = [
      { name: 'K', in: 'env', required: false },
      { name: 'K', in: 'header', header: 'H', required: true },
    ];
    allSecrets({ name: 'k', transport: 'stdio', command: 'x', secrets: declared });
    expect(declared).toEqual([
      { name: 'K', in: 'env', required: false },
      { name: 'K', in: 'header', header: 'H', required: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The two private copies this module replaced, kept verbatim as oracles.
// ---------------------------------------------------------------------------

/** Former src/targets/mcp-config.ts `optionalSecretNames` (loops split out, logic unchanged). */
function formerTargetsOptional(cfg: McpServerConfig): Set<string> {
  const required = new Map<string, boolean>();
  for (const s of cfg.secrets ?? []) required.set(s.name, required.get(s.name) || s.required);
  const detected = new Map<string, boolean>();
  const values = [
    ...Object.values(cfg.env ?? {}),
    ...Object.values(cfg.headers ?? {}),
    cfg.url,
    ...(cfg.args ?? []),
  ].filter((v): v is string => typeof v === 'string');
  const tokens = values.flatMap((v) => findPlaceholders(v));
  for (const p of tokens) {
    if (isRuntimeVar(p.name) || required.has(p.name)) continue;
    detected.set(p.name, detected.get(p.name) || p.default === undefined);
  }
  const optional = [...required, ...detected].filter(([, isRequired]) => !isRequired);
  return new Set(optional.map(([name]) => name));
}

/** Former src/index/mcp.ts `detectSecrets`. */
function formerIndexDetect(cfg: McpServerConfig): SecretRef[] {
  const out: SecretRef[] = [];
  const add = (ref: SecretRef): void => {
    const existing = out.find((s) => s.name === ref.name);
    if (!existing) {
      out.push(ref);
      return;
    }
    existing.required ||= ref.required;
    if (existing.in === 'env' && ref.in === 'header') {
      existing.in = 'header';
      if (ref.header) existing.header = ref.header;
      if (ref.format) existing.format = ref.format;
    }
  };
  const scan = (
    value: string,
    make: (p: ReturnType<typeof findPlaceholders>[number], n: number) => SecretRef,
  ) => {
    const found = findPlaceholders(value);
    for (const p of found) if (!isRuntimeVar(p.name)) add(make(p, found.length));
  };
  const env = (p: { name: string; default?: string }): SecretRef => ({
    name: p.name,
    in: 'env',
    required: p.default === undefined,
  });
  for (const value of Object.values(cfg.env ?? {})) scan(value, env);
  for (const [header, value] of Object.entries(cfg.headers ?? {})) {
    scan(value, (p, tokens) => {
      const ref: SecretRef = {
        name: p.name,
        in: 'header',
        header,
        required: p.default === undefined,
      };
      if (tokens === 1 && value !== p.raw) ref.format = value.replace(p.raw, '{value}');
      return ref;
    });
  }
  if (cfg.url !== undefined) scan(cfg.url, env);
  for (const arg of cfg.args ?? []) scan(arg, env);
  return out;
}

const varName = fc.constantFrom('A', 'B', 'TOKEN', 'HOME', 'CLAUDE_PLUGIN_ROOT');
const token = fc.oneof(
  varName.map((n) => `\${${n}}`),
  varName.map((n) => `\${env:${n}}`),
  fc.tuple(varName, fc.constantFrom('', 'x')).map(([n, d]) => `\${${n}:-${d}}`),
);
const value = fc
  .array(fc.oneof(token, fc.constantFrom('Bearer ', 'lit', '/', '')), { maxLength: 3 })
  .map((parts) => parts.join(''));
const valueMap = fc.dictionary(fc.constantFrom('K1', 'K2', 'Authorization'), value, {
  maxKeys: 3,
});
const declared: fc.Arbitrary<SecretRef> = fc.record({
  name: varName,
  in: fc.constantFrom('env' as const, 'header' as const),
  required: fc.boolean(),
});
const config: fc.Arbitrary<McpServerConfig> = fc.record(
  {
    name: fc.constant('s'),
    transport: fc.constant('stdio' as const),
    env: valueMap,
    headers: valueMap,
    url: value,
    args: fc.array(value, { maxLength: 3 }),
    secrets: fc.array(declared, { maxLength: 3 }),
  },
  { requiredKeys: ['name', 'transport'] },
);

describe('one implementation, same behaviour as the copies it replaced', () => {
  it('detectSecrets equals the former scanner copy', () => {
    fc.assert(
      fc.property(config, (cfg) => {
        expect(detectSecrets(cfg)).toEqual(formerIndexDetect(cfg));
      }),
    );
  });

  it('optionalSecretNames equals the former targets copy', () => {
    fc.assert(
      fc.property(config, (cfg) => {
        expect([...optionalSecretNames(cfg)].sort()).toEqual(
          [...formerTargetsOptional(cfg)].sort(),
        );
      }),
    );
  });

  it('every secret is either optional or required', () => {
    fc.assert(
      fc.property(config, (cfg) => {
        const names = allSecrets(cfg).map((s) => s.name);
        const optional = optionalSecretNames(cfg);
        const required = requiredSecretNames(cfg);
        expect(names.every((n) => optional.has(n) !== required.has(n))).toBe(true);
        expect(optional.size + required.size).toBe(names.length);
      }),
    );
  });
});
