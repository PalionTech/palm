/** K17: one line per server for the variables its targets read. */
import { describe, expect, it } from 'vitest';
import { mergeEnvNotes } from '../../src/engine/env-notes.js';

describe('K17 mergeEnvNotes', () => {
  it('K17 merges the per-target variable notes into one line where the first stood', () => {
    expect(
      mergeEnvNotes([
        'claude: skipped',
        'needs SLACK_TOKEN in the environment',
        'Codex forwards SLACK_BOT_TOKEN from your environment: export SLACK_BOT_TOKEN="${SLACK_TOKEN}"',
        'needs SLACK_BOT_TOKEN, SLACK_TOKEN in the environment',
        'dropped model',
      ]),
    ).toEqual([
      'claude: skipped',
      'needs SLACK_TOKEN, SLACK_BOT_TOKEN in the environment; for Codex: export SLACK_BOT_TOKEN="${SLACK_TOKEN}"',
      'dropped model',
    ]);
  });

  it('K17 leaves notes without variables as they are', () => {
    expect(mergeEnvNotes(['a', 'b'])).toEqual(['a', 'b']);
  });
});
