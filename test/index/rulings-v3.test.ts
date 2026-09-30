/**
 * Rulings of the second 0.2 persona rerun (FINDINGS-v3.md) on the index side: one test per
 * ruling id.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entity, ScanResult, Source } from '../../src/core/types.js';
import { putFile, removeDir, tempDir } from '../support/sandbox.js';
import { scanSource } from './helpers.js';

const FILL = 'Zx8kQ2mN7pL4vR9t';
const TOKEN = `ghp_${FILL.repeat(3).slice(0, 36)}`;

let tmp: string;
beforeEach(async () => {
  tmp = await tempDir('palm-rulings-v3-');
});
afterEach(async () => removeDir(tmp));

const put = (rel: string, content: string | object) => putFile(tmp, rel, content);
const run = (extra: Partial<Source> = {}) =>
  scanSource(tmp, { name: './kit', type: 'local', path: tmp, ...extra });

const skillMd = (name: string, description = `${name} skill`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function find(r: ScanResult, kind: Entity['kind'], name: string): Entity {
  const e = r.entities.find((x) => x.kind === kind && x.name === name);
  if (!e) throw new Error(`no ${kind} ${name} in ${r.entities.map((x) => x.name).join(', ')}`);
  return e;
}

describe('X1 a skill’s own AGENTS.md is skill content', () => {
  it('X1 a skill folder’s AGENTS.md is scanned like the rest of the skill, and is no instruction', async () => {
    await put('skills/react/SKILL.md', skillMd('react'));
    await put('skills/react/AGENTS.md', `# Rules\n\nexport GH=${TOKEN}\n`);
    const r = await run();
    expect(r.entities.map((e) => `${e.kind}:${e.name}`)).toEqual(['skill:react']);
    expect(find(r, 'skill', 'react').issues?.[0]).toEqual(
      expect.objectContaining({ code: 'secret-literal', file: 'skills/react/AGENTS.md' }),
    );
  });
});

describe('T2 findings in tests and fixtures never refuse', () => {
  it('T2 fake tokens in tests/, fixtures/ and *.test.* leave the skill installable', async () => {
    await put('skills/autoreview/SKILL.md', skillMd('autoreview'));
    await put('skills/autoreview/scripts/review.py', 'print("review")\n');
    await put('skills/autoreview/tests/fixtures/sensitive.ts', `const t = "${TOKEN}";\n`);
    await put('skills/autoreview/test/hardening.py', `TOKEN = "${TOKEN}"\n`);
    await put('skills/autoreview/lib/scan.test.ts', `expect("${TOKEN}")\n`);
    await put('skills/autoreview/__tests__/x.ts', `"${TOKEN}"\n`);
    const r = await run();
    expect(find(r, 'skill', 'autoreview').issues).toBeUndefined();
  });

  it('T2 a finding outside the test folders still refuses', async () => {
    await put('skills/autoreview/SKILL.md', skillMd('autoreview'));
    await put('skills/autoreview/tests/fixtures/sensitive.ts', `const t = "${TOKEN}";\n`);
    await put('skills/autoreview/scripts/call.sh', `curl -H "Authorization: token ${TOKEN}"\n`);
    const r = await run();
    expect(find(r, 'skill', 'autoreview').issues).toEqual([
      expect.objectContaining({
        severity: 'critical',
        file: 'skills/autoreview/scripts/call.sh',
      }),
    ]);
  });
});
