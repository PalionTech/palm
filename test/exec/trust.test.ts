import { describe, expect, it } from 'vitest';
import type { LockEntry } from '../../src/core/types.js';
import { needsConsent, withTrust } from '../../src/exec/trust.js';
import { closureTree } from '../../src/exec/units.js';
import { GH_ASSETS, ghCliUnit, teamHelperUnit } from './examples.js';

const unit = ghCliUnit();

function entry(patch: Partial<LockEntry> = {}): LockEntry {
  return {
    kind: 'hook',
    name: 'gh-cli',
    source: 'trailofbits/skills',
    path: 'plugins/gh-cli/hooks/hooks.json',
    via: 'plugin:gh-cli',
    content: 'sha256:content',
    render: { claude: 'sha256:r1' },
    files: [],
    ...patch,
  };
}

describe('needsConsent', () => {
  it.each<[string, LockEntry | undefined, boolean | undefined, boolean]>([
    ['no lock entry', undefined, undefined, true],
    ['an entry without trust', entry(), undefined, true],
    ['an empty trust list', entry({ trust: [] }), undefined, true],
    ['trust of another hash', entry({ trust: ['sha256:other'] }), undefined, true],
    ['trust of this hash', entry({ trust: [unit.hash] }), undefined, false],
    [
      'trust of this hash among others',
      entry({ trust: ['sha256:old', unit.hash] }),
      undefined,
      false,
    ],
  ])('%s', (_label, e, _explicit, expected) => {
    expect(needsConsent(e, unit)).toBe(expected);
  });
});

describe('withTrust', () => {
  it('records readable commands, the closure and the hash, and trusts exactly that hash', () => {
    const next = withTrust(entry({ trust: ['sha256:old'] }), unit);
    expect(next.exec).toEqual({
      commands: [
        {
          id: 'SessionStart//-',
          command: `bash "$CLAUDE_PROJECT_DIR"/${GH_ASSETS}/plugins/gh-cli/hooks/persist-session-id.sh`,
        },
        {
          id: 'PreToolUse//Bash',
          command: `bash "$CLAUDE_PROJECT_DIR"/${GH_ASSETS}/plugins/gh-cli/hooks/intercept-github-curl.sh`,
        },
      ],
      closure: { root: GH_ASSETS, files: 8, tree: closureTree(unit.closure.files) },
      hash: unit.hash,
    });
    expect(next.trust).toEqual([unit.hash]);
    expect('declined' in next).toBe(false);
    expect(needsConsent(next, unit)).toBe(false);
  });

  it('records no closure for a unit without scripts', () => {
    const mcp = teamHelperUnit();
    const next = withTrust(entry({ kind: 'mcp', name: 'team-helper' }), mcp);
    expect(next.exec).toEqual({
      commands: [{ id: 'stdio', command: 'node ".palm/assets/acme-kit/team-helper/server.js"' }],
      hash: mcp.hash,
    });
  });
});
