import './fakes.js';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LockEntry, Rendered } from '../../src/core/types.js';
import type { RecordState } from '../../src/domain/merged-record.js';
import { type FileState, outcomeStatus } from '../../src/engine/diff.js';

const FILE = '.claude/skills/tdd/SKILL.md';
const FRAG = {
  file: '.claude/settings.json',
  at: '/hooks/Stop',
  id: 'palm:hook:x:0',
  key: 'sha256:1',
  value: {},
};

function rendered(hash: string, opts: { fragment?: boolean; skipped?: boolean } = {}): Rendered {
  return {
    files: opts.fragment ? [] : [{ path: FILE, data: new Uint8Array([1]) }],
    fragments: opts.fragment ? [FRAG] : [],
    exec: [],
    notes: [],
    hash,
    ...(opts.skipped ? { skipped: true } : {}),
  };
}

function previous(render: LockEntry['render'], extra: Partial<LockEntry> = {}): LockEntry {
  return {
    kind: 'skill',
    name: 'tdd',
    source: 's',
    path: 'skills/tdd',
    content: 'c1',
    render,
    files: [FILE],
    ...extra,
  };
}

function files(state: FileState): Map<string, FileState> {
  return new Map([[FILE, state]]);
}

const none = new Map<string, RecordState>();

describe('outcomeStatus', () => {
  it('is unchanged only when the render equals the lock and the disk equals the render', () => {
    const d = outcomeStatus({
      previous: previous({ claude: 'h1' }),
      renders: { claude: rendered('h1') },
      files: files('same'),
      fragments: none,
      force: false,
      content: 'c1',
    });
    expect(d).toEqual({ status: 'unchanged', toWrite: [], kept: [] });
  });

  it('restores a missing file', () => {
    const d = outcomeStatus({
      previous: previous({ claude: 'h1' }),
      renders: { claude: rendered('h1') },
      files: files('missing'),
      fragments: none,
      force: false,
    });
    expect(d).toEqual({ status: 'restored', toWrite: ['claude'], kept: [] });
  });

  it('keeps an edited file (modified) unless forced', () => {
    const input = {
      previous: previous({ claude: 'h1' }),
      renders: { claude: rendered('h1') },
      files: files('modified'),
      fragments: none,
    };
    expect(outcomeStatus({ ...input, force: false })).toEqual({
      status: 'modified',
      toWrite: [],
      kept: [FILE],
    });
    expect(outcomeStatus({ ...input, force: true })).toEqual({
      status: 'restored',
      toWrite: ['claude'],
      kept: [],
    });
  });

  it('treats a render that moved away from the lock as an upgrade, not an edit', () => {
    const d = outcomeStatus({
      previous: previous({ claude: 'h1' }),
      renders: { claude: rendered('h2') },
      files: files('modified'),
      fragments: none,
      force: false,
      content: 'c2',
    });
    expect(d).toEqual({ status: 'updated', toWrite: ['claude'], kept: [] });
    const same = outcomeStatus({
      previous: previous({ claude: 'h1' }),
      renders: { claude: rendered('h2') },
      files: files('modified'),
      fragments: none,
      force: false,
      content: 'c1',
    });
    expect(same.status).toBe('re-rendered');
  });

  it('keeps a known edit even when the render moved', () => {
    const d = outcomeStatus({
      previous: previous({ claude: 'h1' }),
      renders: { claude: rendered('h2') },
      files: files('modified'),
      fragments: none,
      force: false,
      edited: new Set([FILE]),
    });
    expect(d.status).toBe('modified');
  });

  it('marks a changed fragment modified and a missing one restored', () => {
    const prev = previous(
      { claude: 'h1' },
      { files: [], merged: [{ file: FRAG.file, at: FRAG.at, id: FRAG.id, key: FRAG.key }] },
    );
    const key = `${FRAG.file}#${FRAG.at}#${FRAG.key}`;
    const changed = outcomeStatus({
      previous: prev,
      renders: { claude: rendered('h1', { fragment: true }) },
      files: new Map(),
      fragments: new Map([[key, 'changed']]),
      force: false,
    });
    expect(changed).toEqual({ status: 'modified', toWrite: [], kept: [key] });
    const missing = outcomeStatus({
      previous: prev,
      renders: { claude: rendered('h1', { fragment: true }) },
      files: new Map(),
      fragments: new Map([[key, 'missing']]),
      force: false,
    });
    expect(missing.status).toBe('restored');
  });

  it('installs a new entry and counts a dropped target as a re-render', () => {
    expect(
      outcomeStatus({
        renders: { claude: rendered('h1') },
        files: files('missing'),
        fragments: none,
        force: false,
      }).status,
    ).toBe('installed');
    const dropped = outcomeStatus({
      previous: previous({ claude: 'h1', cursor: 'h1' }),
      renders: { claude: rendered('h1') },
      files: files('same'),
      fragments: none,
      force: false,
      content: 'c1',
    });
    expect(dropped.status).toBe('re-rendered');
  });

  it('is skipped when every target has nothing for the kind', () => {
    expect(
      outcomeStatus({
        renders: { opencode: rendered('h0', { skipped: true }) },
        files: new Map(),
        fragments: none,
        force: false,
      }).status,
    ).toBe('skipped');
  });

  it('never writes a target whose disk equals a render that equals the lock', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<FileState>('same', 'missing', 'modified', 'stale', 'foreign'),
        fc.boolean(),
        (state, force) => {
          const d = outcomeStatus({
            previous: previous({ claude: 'h1' }),
            renders: { claude: rendered('h1') },
            files: files(state),
            fragments: none,
            force,
          });
          expect(d.toWrite.length === 0).toBe(state === 'same' || (state === 'modified' && !force));
        },
      ),
    );
  });
});
