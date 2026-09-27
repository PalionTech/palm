/**
 * Hook file parsing and dialect detection.
 *
 * Dialects:
 *  - claude  (also Codex): `{hooks:{PreToolUse:[{matcher, hooks:[{type:"command", command, timeout}]}]}}`
 *  - gemini: Claude-like shape with Gemini event names (`BeforeTool`, `AfterAgent`, …)
 *  - cursor: `{version:1, hooks:{preToolUse:[{command, type?, matcher?, timeout?}]}}`
 *  - copilot: `{version:1, hooks:{preToolUse:[{type:"command", bash, powershell, cwd, env, timeoutSec}]}}`
 */

import type { HookDialect, HookSet } from '../core/types.js';
import { compact, isRecord } from './util.js';

const GEMINI_ONLY_EVENTS = new Set([
  'BeforeTool',
  'AfterTool',
  'BeforeAgent',
  'AfterAgent',
  'BeforeModel',
  'AfterModel',
  'BeforeToolSelection',
  'PreCompress',
]);

const PASCAL = /^[A-Z][A-Za-z]+$/;
const CAMEL = /^[a-z][A-Za-z]+$/;

/** Wrap a bare event map (inline manifest form `{SessionStart:[...]}`) into `{hooks:{...}}`. */
export function normalizeHooksJson(json: unknown): unknown {
  if (!isRecord(json)) return json;
  if (isRecord(json.hooks)) return json;
  const keys = Object.keys(json);
  if (keys.length > 0 && keys.every((k) => Array.isArray(json[k]) && (PASCAL.test(k) || CAMEL.test(k)))) {
    return { hooks: json };
  }
  return json;
}

export function detectHookDialect(json: unknown): HookDialect {
  const norm = normalizeHooksJson(json);
  if (!isRecord(norm) || !isRecord(norm.hooks)) return 'unknown';
  const events = Object.keys(norm.hooks);
  if (events.length === 0) return 'unknown';
  if (events.every((e) => PASCAL.test(e))) {
    return events.some((e) => GEMINI_ONLY_EVENTS.has(e)) ? 'gemini' : 'claude';
  }
  if (events.every((e) => CAMEL.test(e))) {
    const entries = events.flatMap((e) => {
      const list = (norm.hooks as Record<string, unknown>)[e];
      return Array.isArray(list) ? list.filter(isRecord) : [];
    });
    if (entries.some((h) => 'bash' in h || 'powershell' in h || 'timeoutSec' in h)) return 'copilot';
    if (entries.some((h) => 'command' in h)) return 'cursor';
    return 'unknown';
  }
  return 'unknown';
}

export function parseHooksJson(name: string, json: unknown, pluginRootRel?: string): HookSet {
  const raw = normalizeHooksJson(json);
  return compact({ name, dialect: detectHookDialect(raw), raw, pluginRootRel });
}

/** True when the hooks object declares at least one event with at least one handler. */
export function hasHooks(json: unknown): boolean {
  const norm = normalizeHooksJson(json);
  if (!isRecord(norm) || !isRecord(norm.hooks)) return false;
  return Object.values(norm.hooks).some((v) => Array.isArray(v) && v.length > 0);
}

/** Concatenate the event arrays of two hook files of the same dialect. */
export function mergeHooksRaw(a: unknown, b: unknown): unknown {
  const na = normalizeHooksJson(a);
  const nb = normalizeHooksJson(b);
  if (!isRecord(na) || !isRecord(na.hooks)) return nb;
  if (!isRecord(nb) || !isRecord(nb.hooks)) return na;
  const hooks: Record<string, unknown[]> = {};
  for (const src of [na.hooks, nb.hooks]) {
    for (const [event, list] of Object.entries(src)) {
      if (!Array.isArray(list)) continue;
      hooks[event] = [...(hooks[event] ?? []), ...list];
    }
  }
  return { ...na, hooks };
}
