import { describe, expect, it } from 'vitest';
import { getConfigValue, setConfigValue } from '../../src/commands/config.js';
import { formatBytes } from '../../src/commands/doctor.js';
import { fileTargetLabel } from '../../src/commands/info.js';
import { withPalmIgnored } from '../../src/commands/init.js';
import { kindCounts, marketplaceRootDir, marketplaceUrlBase } from '../../src/commands/origin.js';
import { installHint } from '../../src/commands/search.js';
import type { PalmConfig } from '../../src/core/types.js';

describe('config get/set', () => {
  const cfg: PalmConfig = { origins: [], targets: ['claude'] };

  it('sets and reads each key', () => {
    let c = setConfigValue(cfg, 'targets', 'codex, cursor');
    expect(getConfigValue(c, 'targets')).toBe('codex,cursor');
    c = setConfigValue(c, 'mcpRegistryUrl', 'https://registry.example/');
    expect(c.mcpRegistryUrl).toBe('https://registry.example');
    c = setConfigValue(c, 'secrets.project', 'literal');
    c = setConfigValue(c, 'secrets.global', 'env-ref');
    expect(c.secrets).toEqual({ project: 'literal', global: 'env-ref' });
    expect(cfg).toEqual({ origins: [], targets: ['claude'] }); // input untouched
  });

  it('unsets with an empty value', () => {
    let c = setConfigValue({ origins: [], secrets: { project: 'literal' }, targets: ['claude'] }, 'secrets.project', '');
    expect(c).not.toHaveProperty('secrets');
    c = setConfigValue(c, 'targets', 'none');
    expect(c).not.toHaveProperty('targets');
  });

  it('validates values', () => {
    expect(() => setConfigValue(cfg, 'targets', 'claude,vim')).toThrow(/vim/);
    expect(() => setConfigValue(cfg, 'secrets.global', 'plaintext')).toThrow(/secret policy/);
    expect(() => setConfigValue(cfg, 'mcpRegistryUrl', 'not a url')).toThrow(/not a URL/);
  });
});

describe('init .gitignore', () => {
  it('appends .palm/ once', () => {
    expect(withPalmIgnored('node_modules/\n')).toBe('node_modules/\n.palm/\n');
    expect(withPalmIgnored('dist')).toBe('dist\n.palm/\n');
    expect(withPalmIgnored('')).toBe('.palm/\n');
    expect(withPalmIgnored('a\n/.palm\n')).toBeUndefined();
    expect(withPalmIgnored('.palm/\n')).toBeUndefined();
  });
});

describe('origin helpers', () => {
  it('maps GitHub marketplace URLs to a raw URL and repo base', () => {
    expect(marketplaceUrlBase('https://github.com/obra/superpowers-marketplace/blob/main/.claude-plugin/marketplace.json')).toEqual({
      rawUrl: 'https://raw.githubusercontent.com/obra/superpowers-marketplace/main/.claude-plugin/marketplace.json',
      base: { url: 'https://github.com/obra/superpowers-marketplace.git', ref: 'main' },
      relPath: '.claude-plugin/marketplace.json',
    });
    expect(marketplaceUrlBase('https://raw.githubusercontent.com/o/r/v1/.claude-plugin/marketplace.json').base).toEqual({
      url: 'https://github.com/o/r.git',
      ref: 'v1',
    });
    expect(marketplaceUrlBase('https://example.com/m/marketplace.json')).toEqual({
      rawUrl: 'https://example.com/m/marketplace.json',
      base: {},
      relPath: 'marketplace.json',
    });
  });

  it('finds the directory relative marketplace sources resolve against', () => {
    expect(marketplaceRootDir('/r/.claude-plugin/marketplace.json')).toBe('/r');
    expect(marketplaceRootDir('/r/.cursor-plugin/marketplace.json')).toBe('/r');
    expect(marketplaceRootDir('/r/.github/plugin/marketplace.json')).toBe('/r');
    expect(marketplaceRootDir('/r/.agents/plugins/marketplace.json')).toBe('/r');
    expect(marketplaceRootDir('/r/marketplace.json')).toBe('/r');
  });

  it('summarises kind counts', () => {
    expect(kindCounts([{ kind: 'skill' }, { kind: 'mcp' }, { kind: 'skill' }, { kind: 'mcp' }])).toBe('2 skills, 2 MCP servers');
    expect(kindCounts([{ kind: 'agent' }])).toBe('1 agent');
    expect(kindCounts([])).toBe('no entities');
  });
});

describe('info / search / doctor helpers', () => {
  it('attributes installed files to targets', () => {
    expect(fileTargetLabel('.claude/skills/x/SKILL.md')).toBe('claude');
    expect(fileTargetLabel('/home/u/.claude.json')).toBe('claude');
    expect(fileTargetLabel('.mcp.json')).toBe('claude');
    expect(fileTargetLabel('.agents/skills/x/SKILL.md')).toBe('shared .agents');
    expect(fileTargetLabel('.codex/agents/x.toml')).toBe('codex');
    expect(fileTargetLabel('AGENTS.md')).toBe('codex');
    expect(fileTargetLabel('.github/agents/x.agent.md')).toBe('copilot');
    expect(fileTargetLabel('.vscode/mcp.json')).toBe('copilot');
    expect(fileTargetLabel('/home/u/.cursor/rules/x.mdc')).toBe('cursor');
    expect(fileTargetLabel('README.md')).toBe('other');
  });

  it('builds install hints', () => {
    expect(installHint({ kind: 'skill', name: 'wayfinder', origin: 'mattpocock' })).toBe('palm install skill wayfinder@mattpocock');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });
});
