/**
 * The pure helpers the command grammar takes from core and domain (API.md: core/kinds.ts,
 * core/source-input.ts, domain/entity-ref.ts, domain/ignore.ts), gathered in one module. The
 * grammar runs them while commander parses, so these are static imports; they are small and
 * pure. The CLI tests stand this module in with test/cli/contract.ts.
 */
export {
  isCommandWord,
  parseKind,
  parseResource,
  pluralize,
  type Resource,
  resourceWords,
} from '../core/kinds.js';
export { looksLikeSourceInput } from '../core/source-input.js';
export { parseEntityRef } from '../domain/entity-ref.js';
export { PLUGIN_ROOT_TOKENS } from '../domain/ignore.js';
