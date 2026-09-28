/**
 * The scanner's public entry point: `scanOrigin(root, spec)` turns a checked-out origin directory
 * into an index of entities (DESIGN §5). Everything else in src/index is internal to it or a
 * parser; the orchestration lives in scanner.ts, one module per rule in rules/.
 */
export { scanOrigin } from './scanner.js';
