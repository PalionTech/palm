/**
 * Engine pieces wired at the second persona rerun's integration (FINDINGS-v3.md), one test per
 * ruling id. Secret-shaped values are built at runtime.
 */
import './fakes.js';

import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/core/types.js';
import { installFromSource } from '../../src/engine/install.js';
import { referenceSecrets } from '../../src/engine/source-secrets.js';
import { redact, urlSecret } from '../../src/secrets/scan.js';
import { makeWorld } from './world.js';

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

describe('S8 a program this run trusted', () => {
  it('S8 the outcome carries the hash the consent trusted', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true, consent: 'yes' });
    const hooks = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/run.sh' }] }] },
    };
    const url = await w.remote('kit', {
      'v1.0.0': {
        'hooks/guard/hooks.json': JSON.stringify(hooks),
        'hooks/guard/run.sh': { text: 'echo guard\n', mode: 0o755 },
      },
    });
    const r = await installFromSource(
      w.ctx,
      { source: url, names: [{ name: 'guard' }] },
      { scope: 'project' },
      w.deps,
    );
    const guard = r.outcomes.find((o) => o.entry.name === 'guard');
    expect(guard?.trusted).toBe(guard?.entry.exec?.hash);
    expect(guard?.trusted).toMatch(/^sha256:/);
  });
});
