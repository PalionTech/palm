/** Which scan rule (DESIGN §5) applies to an origin. */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LayoutDescriptor } from '../core/types.js';
import { findMarketplaceFile } from './marketplace.js';
import { findPluginManifest, type PluginManifest } from './plugin-manifest.js';

export type ScanRule = 'descriptor' | 'apm' | 'marketplace' | 'plugin-manifest' | 'convention';

export interface Detection {
  rule: ScanRule;
  /** Absolute marketplace file (rule `marketplace`). */
  marketplaceFile?: string;
  /** Root plugin manifest, when one exists (rules `marketplace` and `plugin-manifest`). */
  rootManifest?: PluginManifest;
  /** APM manifest file name relative to the root (rule `apm`). */
  apmFile?: string;
}

const KIND_KEYS = ['skills', 'agents', 'commands', 'instructions', 'hooks', 'mcp'] as const;

/** A descriptor only replaces detection when it names at least one kind glob. */
export function hasLayoutGlobs(layout: LayoutDescriptor | undefined): boolean {
  if (!layout) return false;
  return KIND_KEYS.some((k) => {
    const v = layout[k];
    return typeof v === 'string' ? v.trim() !== '' : Array.isArray(v) && v.length > 0;
  });
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function detectLayout(
  rootAbs: string,
  layout: LayoutDescriptor | undefined,
  warnings: string[] = [],
  opts: { skipApm?: boolean } = {},
): Promise<Detection> {
  if (hasLayoutGlobs(layout)) return { rule: 'descriptor' };
  for (const apmFile of opts.skipApm ? [] : ['apm.yml', 'apm.yaml']) {
    if ((await isFile(join(rootAbs, apmFile))) && (await isDir(join(rootAbs, '.apm')))) return { rule: 'apm', apmFile };
  }
  const marketplaceFile = await findMarketplaceFile(rootAbs);
  const rootManifest = await findPluginManifest(rootAbs, warnings);
  if (marketplaceFile) return { rule: 'marketplace', marketplaceFile, rootManifest };
  if (rootManifest) return { rule: 'plugin-manifest', rootManifest };
  return { rule: 'convention' };
}
