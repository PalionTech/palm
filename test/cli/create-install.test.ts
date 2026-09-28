import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PickOption, UI } from '../../src/core/types.js';
import { createAgent } from '../../src/create/agent.js';
import { Lock } from '../../src/domain/lock.js';
import { Manifest } from '../../src/domain/manifest.js';
import { uninstallEntities } from '../../src/engine/uninstall.js';
import { makeContext } from '../support/fakes.js';
import { removeDir, type Sandbox, sandbox } from '../support/sandbox.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

/** Answers prompts in order; a function answer receives the offered options. */
function scriptedUI(answers: unknown[]): UI & { asked: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const next = (type: string, message: string, options: PickOption<unknown>[] = []): unknown => {
    asked.push(`${type}: ${message}`);
    if (!queue.length) throw new Error(`unexpected prompt ${type}: ${message}`);
    const a = queue.shift();
    return typeof a === 'function' ? (a as (o: PickOption<unknown>[]) => unknown)(options) : a;
  };
  return {
    isInteractive: true,
    asked,
    pick: async <T>(m: string, o: PickOption<T>[]) =>
      next('pick', m, o as PickOption<unknown>[]) as T,
    pickMany: async <T>(m: string, o: PickOption<T>[]) =>
      next('pickMany', m, o as PickOption<unknown>[]) as T[],
    confirm: async (m: string) => next('confirm', m) as boolean,
    text: async (m: string) => next('text', m) as string,
    secret: async (m: string) => next('secret', m) as string,
    spinner: () => ({ stop() {}, message() {} }),
  };
}

const values =
  (...labels: string[]) =>
  (options: PickOption<unknown>[]) =>
    labels.map((l) => {
      const o = options.find((x) => x.label.startsWith(l));
      if (!o) throw new Error(`no option "${l}" in ${options.map((x) => x.label).join(' | ')}`);
      return o.value;
    });

describe('palm create agent → install (fake UI, real scanner/engine/targets)', () => {
  let sb: Sandbox;
  afterEach(async () => removeDir(sb.root));

  it('writes the agent into mine, installs it with its skill and instruction as tracked deps', async () => {
    sb = await sandbox();
    const ui = scriptedUI([
      'code-reviewer', // name
      'Use after code changes to review them', // description
      'sonnet', // model
      values('Read', 'Grep'), // tools
      values('grill-me @matt'), // skills
      [], // MCP servers: none
      values('style @rules'), // instructions
      'You are a careful reviewer.', // system prompt (no $EDITOR, no multiline support)
    ]);
    const ctx = await makeContext(sb, { ui, flags: { offline: true } });
    ctx.config.origins.push(
      { alias: 'matt', type: 'local', path: join(FIXTURES, 'mattpocock-like') },
      { alias: 'rules', type: 'local', path: join(FIXTURES, 'codex-agent-like') },
    );

    await createAgent(ctx, { scope: 'project', install: true, targets: ['claude', 'codex'] });

    const agentFile = join(sb.palmHome, 'mine', 'agents', 'code-reviewer.md');
    const text = await readFile(agentFile, 'utf8');
    expect(text).toContain('skills:\n  - grill-me');
    expect(text).toContain('instructions:\n  - style@rules');

    const lock = await Lock.load(join(sb.project, 'palm.lock.yaml'));
    const byName = Object.fromEntries(lock.entries.map((e) => [`${e.kind} ${e.name}`, e]));
    expect(byName['agent code-reviewer']).toMatchObject({
      origin: 'mine',
      deps: [
        { kind: 'skill', name: 'grill-me' },
        { kind: 'instruction', name: 'style' },
      ],
    });
    expect(byName['agent code-reviewer']!.via).toBeUndefined();
    expect(byName['skill grill-me']).toMatchObject({ origin: 'matt', via: 'agent:code-reviewer' });
    expect(byName['instruction style']).toMatchObject({
      origin: 'rules',
      via: 'agent:code-reviewer',
    });

    // Only the agent is a manifest entry; its dependencies come with it.
    const m = (await Manifest.load(join(sb.project, 'palm.yaml'))).toJSON();
    expect(m.agents).toEqual(['code-reviewer@mine']);
    expect(m.skills).toBeUndefined();
    expect(m.instructions).toBeUndefined();

    // The instructions key never reaches a harness file.
    const claudeAgent = await readFile(join(sb.project, '.claude/agents/code-reviewer.md'), 'utf8');
    expect(claudeAgent).not.toContain('instructions');
    expect(claudeAgent).toContain('skills:');
    expect(existsSync(join(sb.project, '.claude/rules/style.md'))).toBe(true);
    expect(await readFile(join(sb.project, 'AGENTS.md'), 'utf8')).toContain(
      'palm:begin instruction:style',
    );

    // Uninstalling the agent removes what it pulled in.
    const r = await uninstallEntities(ctx, [{ kind: 'agent', name: 'code-reviewer' }], {
      scope: 'project',
    });
    expect(r.removed.map((e) => `${e.kind} ${e.name}`).sort()).toEqual([
      'agent code-reviewer',
      'instruction style',
      'skill grill-me',
    ]);
    expect(existsSync(join(sb.project, '.claude/skills/grill-me'))).toBe(false);
    expect(existsSync(join(sb.project, '.agents'))).toBe(false); // palm-created container removed once empty
    // palm created .claude and .codex here (the sandbox had neither): empty now, so they go too
    expect(existsSync(join(sb.project, '.claude'))).toBe(false);
    expect(existsSync(join(sb.project, '.codex'))).toBe(false);
  });
});
