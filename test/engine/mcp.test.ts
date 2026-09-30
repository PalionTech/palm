import './fakes.js';

import { describe, expect, it } from 'vitest';
import { installMcp } from '../../src/engine/install.js';
import { syncScope } from '../../src/engine/sync.js';
import { makeWorld } from './world.js';

describe('installMcp (hand-declared servers)', () => {
  it('writes a typed literal to palm.yaml as a reference and renders the reference', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const r = await installMcp(
      w.ctx,
      [
        {
          config: {
            name: 'docs',
            transport: 'http',
            url: 'https://docs.example/mcp',
            headers: { Authorization: 'Bearer sk-abcdefghijklmnop' },
          },
        },
      ],
      { scope: 'project' },
      w.deps,
    );
    expect(r.failures).toEqual([]);
    expect(r.warnings.join('\n')).toContain('written as ${DOCS_TOKEN}; export it');
    expect(await w.manifestText()).not.toContain('sk-abcdefghijklmnop');
    expect(await w.manifest()).toMatchObject({
      mcp: {
        docs: {
          url: 'https://docs.example/mcp',
          headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
        },
      },
    });
    expect(await w.read('.claude/mcp.json')).toContain('Bearer ${DOCS_TOKEN}');
    expect(await w.entry('mcp', 'docs')).toMatchObject({ source: 'manifest', path: 'mcp/docs' });
  });

  it('renders the literal under --secrets literal when the destination allows it', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const ctx = w.context({ secrets: 'literal' });
    await installMcp(
      ctx,
      [
        {
          config: {
            name: 'docs',
            transport: 'http',
            url: 'https://docs.example/mcp',
            headers: { Authorization: 'Bearer sk-abcdefghijklmnop' },
          },
        },
      ],
      { scope: 'project' },
      w.deps,
    );
    expect(await w.read('.claude/mcp.json')).toContain('Bearer sk-abcdefghijklmnop');
    expect(await w.manifestText()).not.toContain('sk-abcdefghijklmnop');
    expect(w.secrets.decisions.map((d) => d.requested)).toEqual(['literal']);
  });

  it('refuses a literal where the secret decision refuses it, naming --secrets env-ref', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    w.secrets.refuse.add('.claude/mcp.json');
    const ctx = w.context({ secrets: 'literal' });
    const r = await installMcp(
      ctx,
      [
        {
          config: {
            name: 'docs',
            transport: 'http',
            url: 'https://x',
            headers: { Authorization: 'Bearer sk-abcdefghijklmnop' },
          },
        },
      ],
      { scope: 'project' },
      w.deps,
    );
    expect(r.failures[0]).toMatchObject({
      code: 'E_SECRET',
      target: 'claude',
      hint: expect.stringContaining('--secrets env-ref'),
    });
    expect(w.exists('.claude/mcp.json')).toBe(false);
  });

  it('is E_CONFLICT for an existing name unless forced, and a stdio server asks for consent', async () => {
    const w = await makeWorld({ targets: ['claude'], interactive: true, consent: 'yes' });
    const stdio = {
      name: 'xcode',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', 'xcodebuildmcp@latest'],
    };
    await installMcp(w.ctx, [{ config: stdio }], { scope: 'project' }, w.deps);
    expect(w.exec.requests[0]?.units.map((u) => u.key)).toEqual(['mcp:xcode@manifest']);
    await expect(
      installMcp(w.ctx, [{ config: stdio }], { scope: 'project' }, w.deps),
    ).rejects.toMatchObject({ code: 'E_CONFLICT' });
    const again = await installMcp(
      w.ctx,
      [{ config: stdio }],
      { scope: 'project', force: true },
      w.deps,
    );
    expect(again.outcomes.map((o) => o.status)).toEqual(['unchanged']);
    const sync = await syncScope(w.ctx, { scope: 'project' }, w.deps);
    expect(sync.outcomes.map((o) => o.status)).toEqual(['unchanged']);
    expect(w.exec.requests).toHaveLength(1);
  });

  it('re-renders when the secrets policy changes and says to rotate the literal it replaced', async () => {
    const w = await makeWorld({ targets: ['claude'] });
    const docs = {
      name: 'docs',
      transport: 'http' as const,
      url: 'https://docs.example/mcp',
      headers: { Authorization: 'Bearer sk-abcdefghijklmnop' },
    };
    await installMcp(
      w.context({ secrets: 'literal' }),
      [{ config: docs }],
      { scope: 'project' },
      w.deps,
    );
    expect(await w.read('.claude/mcp.json')).toContain('sk-abcdefghijklmnop');
    const r = await syncScope(w.ctx, { scope: 'project' }, w.deps);
    expect(r.outcomes.map((o) => o.status)).toEqual(['re-rendered']);
    expect(await w.read('.claude/mcp.json')).not.toContain('sk-abcdefghijklmnop');
    expect(r.warnings.join('\n')).toContain('palm replaced it with ${DOCS_TOKEN}');
    expect(r.warnings.join('\n')).toContain('rotate it');
  });
});
