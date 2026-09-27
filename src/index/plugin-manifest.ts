/**
 * Per-plugin manifests. Exactly one is used per plugin directory, in this precedence:
 * `.claude-plugin/plugin.json` > `.cursor-plugin/plugin.json` > root `plugin.json` with an
 * agent-plugins `$schema` > `.codex-plugin/plugin.json` > `gemini-extension.json`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asString, compact, isRecord } from './util.js';

export type PluginManifestFormat = 'claude' | 'cursor' | 'agent-plugins' | 'codex' | 'gemini';

export const PLUGIN_MANIFEST_FILES: ReadonlyArray<{ rel: string; format: PluginManifestFormat }> = [
  { rel: '.claude-plugin/plugin.json', format: 'claude' },
  { rel: '.cursor-plugin/plugin.json', format: 'cursor' },
  { rel: 'plugin.json', format: 'agent-plugins' },
  { rel: '.codex-plugin/plugin.json', format: 'codex' },
  { rel: 'gemini-extension.json', format: 'gemini' },
];

/** Component declarations common to plugin manifests and marketplace entries. Paths are plugin-root relative. */
export interface ComponentDecls {
  skills?: string[];
  agents?: string[];
  commands?: string[];
  /** Cursor `rules` and any `instructions` key. */
  rules?: string[];
  hooks?: { paths: string[]; inline: unknown[] };
  mcpServers?: { paths: string[]; inline: Array<Record<string, unknown>> };
}

export interface PluginManifest {
  format: PluginManifestFormat;
  /** Manifest path relative to the plugin directory. */
  file: string;
  name?: string;
  displayName?: string;
  version?: string;
  description?: string;
  components: ComponentDecls;
  /** Component keys palm does not install (lspServers, outputStyles, …). */
  unsupported: string[];
  raw: Record<string, unknown>;
}

const UNSUPPORTED_KEYS = ['lspServers', 'outputStyles', 'apps', 'channels', 'themes', 'contextFileName'];

function pathList(v: unknown): string[] | undefined {
  if (typeof v === 'string') return v.trim() === '' ? undefined : [v.trim()];
  if (Array.isArray(v)) {
    const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

function pathsAndInline<T>(v: unknown, isInline: (x: unknown) => x is T): { paths: string[]; inline: T[] } | undefined {
  if (v === undefined || v === null) return undefined;
  const items = Array.isArray(v) ? v : [v];
  const paths: string[] = [];
  const inline: T[] = [];
  for (const item of items) {
    if (typeof item === 'string' && item.trim() !== '') paths.push(item.trim());
    else if (isInline(item) && Object.keys(item as object).length > 0) inline.push(item);
  }
  return paths.length > 0 || inline.length > 0 ? { paths, inline } : undefined;
}

/** Extract component declarations from a manifest-like object. */
export function parseComponentDecls(obj: Record<string, unknown>): { decls: ComponentDecls; unsupported: string[] } {
  const rules = [...(pathList(obj.rules) ?? []), ...(pathList(obj.instructions) ?? [])];
  const decls: ComponentDecls = compact({
    skills: pathList(obj.skills),
    agents: pathList(obj.agents),
    commands: pathList(obj.commands ?? obj.prompts),
    rules: rules.length > 0 ? rules : undefined,
    hooks: pathsAndInline(obj.hooks, isRecord),
    mcpServers: pathsAndInline(obj.mcpServers, isRecord),
  });
  const unsupported = UNSUPPORTED_KEYS.filter((k) => {
    const v = obj[k];
    if (v === undefined || v === null) return false;
    if (k === 'contextFileName') return false; // Gemini context file: informational
    if (Array.isArray(v)) return v.length > 0;
    if (isRecord(v)) return Object.keys(v).length > 0;
    return v !== '';
  });
  return { decls, unsupported };
}

/** Union of two declaration sets (first wins on ordering). */
export function mergeDecls(a: ComponentDecls | undefined, b: ComponentDecls | undefined): ComponentDecls {
  if (!a) return { ...(b ?? {}) };
  if (!b) return { ...a };
  const list = (x?: string[], y?: string[]) => {
    const out = [...new Set([...(x ?? []), ...(y ?? [])])];
    return out.length > 0 ? out : undefined;
  };
  const both = <T>(x?: { paths: string[]; inline: T[] }, y?: { paths: string[]; inline: T[] }) => {
    if (!x && !y) return undefined;
    return { paths: [...new Set([...(x?.paths ?? []), ...(y?.paths ?? [])])], inline: [...(x?.inline ?? []), ...(y?.inline ?? [])] };
  };
  return compact({
    skills: list(a.skills, b.skills),
    agents: list(a.agents, b.agents),
    commands: list(a.commands, b.commands),
    rules: list(a.rules, b.rules),
    hooks: both(a.hooks, b.hooks),
    mcpServers: both(a.mcpServers, b.mcpServers),
  });
}

export function isAgentPluginsManifest(json: unknown): boolean {
  if (!isRecord(json)) return false;
  const schema = asString(json.$schema);
  if (schema && /agent-plugins/i.test(schema)) return true;
  return isRecord(json.extensions) && typeof json.name === 'string';
}

/** Build a normalized manifest from parsed JSON. */
export function normalizeManifest(json: Record<string, unknown>, format: PluginManifestFormat, file: string): PluginManifest {
  let { decls, unsupported } = parseComponentDecls(json);
  if (format === 'agent-plugins' && isRecord(json.extensions)) {
    // awesome-copilot keeps components under extensions."com.github.awesome-copilot".
    for (const ext of Object.values(json.extensions)) {
      if (!isRecord(ext)) continue;
      const inner = parseComponentDecls(ext);
      decls = mergeDecls(decls, inner.decls);
      unsupported = [...new Set([...unsupported, ...inner.unsupported])];
    }
  }
  return compact({
    format,
    file,
    name: asString(json.name),
    displayName: asString(json.displayName),
    version: asString(json.version),
    description: asString(json.description),
    components: decls,
    unsupported,
    raw: json,
  });
}

async function readJson(abs: string): Promise<{ ok: true; json: unknown } | { ok: false; missing: boolean; error?: string }> {
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch {
    return { ok: false, missing: true };
  }
  try {
    return { ok: true, json: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
  } catch (e) {
    return { ok: false, missing: false, error: (e as Error).message };
  }
}

/**
 * Find and parse the ONE manifest of a plugin directory. Invalid JSON in a higher-precedence
 * manifest is reported through `warnings` and the next candidate is tried.
 */
export async function findPluginManifest(dirAbs: string, warnings?: string[], dirLabel = '.'): Promise<PluginManifest | undefined> {
  for (const cand of PLUGIN_MANIFEST_FILES) {
    const res = await readJson(join(dirAbs, cand.rel));
    if (!res.ok) {
      if (!res.missing) warnings?.push(`invalid JSON in ${dirLabel === '.' ? '' : dirLabel + '/'}${cand.rel}: ${res.error ?? ''}`.trim());
      continue;
    }
    if (!isRecord(res.json)) continue;
    if (cand.format === 'agent-plugins' && !isAgentPluginsManifest(res.json)) continue;
    return normalizeManifest(res.json, cand.format, cand.rel);
  }
  return undefined;
}
