/**
 * Engine pieces wired at the second persona rerun's integration (FINDINGS-v3.md), one test per
 * ruling id. Secret-shaped values are built at runtime.
 */
import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/core/types.js';
import { referenceSecrets } from '../../src/engine/source-secrets.js';
import { redact, urlSecret } from '../../src/secrets/scan.js';

/** 24 distinct characters; token bodies are built from them at runtime. */
const RANDOM = 'Zx8kQ2mN7pL4vR9tW3yB6cF1';

function server(url: string): Entity {
  return {
    kind: 'mcp',
    name: 'remote',
    source: 'kit',
    path: '.mcp.json',
    def: { kind: 'mcp', mcp: { name: 'remote', transport: 'http', url } },
  } as Entity;
}

describe('S10 a secret in a source server URL', () => {
  it('S10 only the parameter becomes a reference, named after it; the host stays', () => {
    const key = `${RANDOM}${RANDOM}`;
    const url = `https://mcp.example.com/v1?key=${key}&region=eu`;
    const part = urlSecret(url);
    expect(part).toEqual({ secret: key, param: 'key' });
    const redacted = url.replace(key, redact(key));
    const { entity, replaced } = referenceSecrets(server(redacted));
    const def = entity.def as Extract<Entity['def'], { kind: 'mcp' }>;
    expect(def.mcp.url).toBe('https://mcp.example.com/v1?key=${REMOTE_KEY}&region=eu');
    expect(replaced).toEqual([{ where: 'mcp:remote.url', variable: 'REMOTE_KEY' }]);
  });
});
