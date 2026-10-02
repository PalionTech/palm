/**
 * What a listing shows for an offer (ruling O21): a hook row names the whole command it runs
 * (`claude: Stop -> go run .agents/hooks/main.go`, not `Stop -> go`), and the paste line of a
 * source that offers only programs names them as `hook:<name>` or `mcp:<name>`, because `--all`
 * installs no program without a consent it cannot ask for.
 */

import type { Entity } from '../core/types.js';
import { PLUGIN_ROOT_TOKENS } from '../domain/ignore.js';
import { hookHandlers } from './hooks.js';
import { asString } from './util.js';

/** A plugin-root token with the slash after it: `${CLAUDE_PLUGIN_ROOT}/hooks/x` reads `hooks/x`. */
const ROOT_PREFIX = new RegExp(`(?:${PLUGIN_ROOT_TOKENS.source})/?`, 'g');

/** A command as a person reads it: the plugin-root prefix and quotes around words removed. */
function readableCommand(command: string): string {
  return command
    .replace(ROOT_PREFIX, '')
    .split(/\s+/)
    .map((w) => w.replace(/^["']|["']$/g, ''))
    .filter((w) => w !== '')
    .join(' ');
}

/** `claude: Stop -> go run .agents/hooks/main.go (+1 more)`; undefined for anything but a hook. */
export function hookCommandSummary(e: Entity): string | undefined {
  if (e.def.kind !== 'hook') return undefined;
  const { dialect, raw } = e.def.hooks;
  const commands = hookHandlers(raw).flatMap(({ event, handler }) => {
    const command = asString(handler.command) ?? asString(handler.bash);
    return command === undefined ? [] : [{ event, command }];
  });
  const [first] = commands;
  if (!first) return `${dialect}: text sent to the model`;
  const more = commands.length > 1 ? ` (+${commands.length - 1} more)` : '';
  return `${dialect}: ${first.event} -> ${readableCommand(first.command)}${more}`;
}

/** `kind:name` when the source offers the name in more than one kind, else the name. */
function pasteName(e: Entity, all: readonly Entity[]): string {
  const clash = all.some((o) => o !== e && o.name === e.name && o.kind !== e.kind);
  return clash ? `${e.kind}:${e.name}` : e.name;
}

/** The names a listing's paste line offers, and whether `--all` would install anything. */
export interface PasteOffer {
  names: string[];
  /** False when every shown entity is a program: `--all` would install none of them. */
  all: boolean;
}

/**
 * Two names to try: the first shown entities that are not programs; for a source that offers
 * only programs, the first two programs as `hook:<name>` / `mcp:<name>`.
 */
export function pasteOffer(
  shown: readonly Entity[],
  all: readonly Entity[],
  executable: (e: Entity) => boolean,
): PasteOffer {
  const plain = shown.filter((e) => !executable(e));
  if (plain.length > 0)
    return { names: plain.slice(0, 2).map((e) => pasteName(e, all)), all: true };
  const programs = shown.filter(executable).slice(0, 2);
  return { names: programs.map((e) => `${e.kind}:${e.name}`), all: false };
}
