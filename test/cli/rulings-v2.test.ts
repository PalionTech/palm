/**
 * The fix-cli rulings of the 0.2 persona rerun (FINDINGS-v2.md), each test named after its ids:
 * the hints palm prints, the palm 0.1 forms and flags, and the first-word errors of install.
 * The engine is faked; test/cli/rulings-v2-output.test.ts covers what the commands print.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallRequest, TargetId } from '../../src/core/types.js';
import { Manifest } from '../../src/domain/manifest.js';
import type { ScopePaths } from '../../src/domain/scope-paths.js';
import { exists, read, removeDir, type Sandbox, sandbox, write } from '../support/sandbox.js';
import {
  entity,
  fakeEngine,
  fakeListing,
  fakeScope,
  fakeUI,
  lockEntry,
  palm,
  type ScopeSpec,
} from './fakes.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await removeDir(sb.root);
});

const MP = { name: 'mattpocock/skills', url: 'https://github.com/mattpocock/skills.git' };
const grill = lockEntry({
  kind: 'skill',
  name: 'grill',
  source: './.ai/agent-kit',
  files: ['.claude/skills/grill/SKILL.md'],
});

function scope(over: Partial<ScopeSpec> = {}) {
  return fakeScope({ root: sb.project, targets: ['claude'], ...over });
}

describe('K9, D9: paste lines name the source as typed until palm.yaml declares it', () => {
  const url = 'https://gitlab.acme.com/platform/company-agent-kit.git';

  it('an undeclared URL keeps the URL, its #ref and --as; -g is carried (J9)', async () => {
    const listed = fakeListing({ name: 'company-agent-kit', url }, [
      entity('incident'),
      entity('release-notes'),
    ]);
    const deps = fakeEngine({
      scopes: [scope({ scope: 'global' })],
      listSource: async () => listed,
    });
    const r = await palm(sb, ['install', `${url}#v1.3.1`, '--as', 'acme', '-g'], { deps });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `    palm install ${url}#v1.3.1 incident release-notes --as acme -g\n`,
    );
    expect(r.stdout).toContain(`    palm install ${url}#v1.3.1 --all --as acme -g\n`);
  });

  it('a declared source is named by its key', async () => {
    const listed = fakeListing(MP, [entity('tdd')], { declared: true });
    const deps = fakeEngine({
      scopes: [scope({ sources: [MP] })],
      listSource: async () => listed,
    });
    const r = await palm(sb, ['install', 'https://github.com/mattpocock/skills'], { deps });
    expect(r.stdout).toContain('    palm install mattpocock/skills tdd\n');
  });

  it('an engine hint naming a key that does not exist yet names what was typed', async () => {
    const { PalmError } = await import('../../src/core/errors.js');
    const deps = fakeEngine({
      scopes: [scope()],
      installFromSource: async () => {
        throw new PalmError(
          'E_NOT_FOUND',
          'agent "reviewer" is not installable here',
          'palm install acme review',
        );
      },
    });
    const r = await palm(sb, ['install', url, 'reviewer', '--as', 'acme'], { deps });
    expect(r.stderr).toContain(`  palm install ${url} review`);
    expect(r.stderr).not.toContain('palm install acme review');
  });
});

describe('L20, R7: a multi-name install that installs nothing says so, with every name', () => {
  it('keeps the other names and replaces the one it corrects', async () => {
    const { PalmError } = await import('../../src/core/errors.js');
    const deps = fakeEngine({
      scopes: [scope()],
      installFromSource: async () => {
        throw new PalmError(
          'E_NOT_FOUND',
          '"grill-mee" is not in source mattpocock/skills; did you mean grill-me?',
          'palm install mattpocock/skills grill-me',
        );
      },
    });
    const r = await palm(sb, ['install', 'mattpocock/skills', 'tdd', 'grill-mee'], { deps });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('Nothing installed.\n');
    expect(r.stderr).toContain('  palm install mattpocock/skills tdd grill-me\n');
  });
});

describe('B17, E15, L6, K15: a first word that is no source is looked up in palm.yaml first', () => {
  it('B17: an installed entry names its source', async () => {
    const deps = fakeEngine({ scopes: [scope({ entries: [grill] })] });
    const r = await palm(sb, ['install', 'grill'], { deps });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      'x "grill" is not a repository; it is skill grill from ./.ai/agent-kit:\n    palm install ./.ai/agent-kit grill\n',
    );
  });

  it('E15: a directory of the project becomes its path', async () => {
    await mkdir(join(sb.project, '.agents-kit'), { recursive: true });
    const deps = fakeEngine({ scopes: [scope()] });
    const r = await palm(sb, ['install', '.agents-kit', 'reviewer'], { deps });
    expect(r.stderr).toContain('    palm install ./.agents-kit reviewer\n');
  });

  it('L6, Q3, N11: a bare owner is its declared source; an example never pastes the typed word', async () => {
    const deps = fakeEngine({ scopes: [scope({ sources: [MP] })] });
    const owner = await palm(sb, ['install', 'mattpocock', 'tdd'], { deps });
    expect(owner.stderr).toBe(
      'x "mattpocock" is not a repository; did you mean mattpocock/skills?\n    palm install mattpocock/skills tdd\n',
    );
    const other = await palm(sb, ['install', 'frobnicate'], {
      deps: fakeEngine({ scopes: [scope({ sources: [MP] })] }),
    });
    expect(other.stderr).toContain('for example  palm install mattpocock/skills tdd');
    expect(other.stderr).not.toContain('mattpocock/skills frobnicate');
  });

  it('K15, N7: under -g, a source of this project is named as one, with its repository and name', async () => {
    const project = scope({ sources: [{ name: 'acme', url: 'https://github.com/acme/kit.git' }] });
    const deps = fakeEngine({ scopes: [scope({ scope: 'global' }), project] });
    const r = await palm(sb, ['install', 'acme', 'review', '-g'], { deps });
    expect(r.stderr).toBe(
      'x "acme" is a source of this project; -g uses the sources in ~/.palm/palm.yaml only\n  install it for yourself from its repository: palm install acme/kit review --as acme -g\n',
    );
  });

  it('L5: a kind word says what palm calls it and searches for that kind', async () => {
    const deps = () => fakeEngine({ scopes: [scope()] });
    const rules = await palm(sb, ['install', 'rules'], { deps: deps() });
    expect(rules.stderr).toContain(
      'x "rules" is a kind (instructions), not a repository. palm installs instructions from git repositories:',
    );
    expect(rules.stderr).toContain('https://github.com/search?q=extension%3Amdc&type=code');
    const agents = await palm(sb, ['install', 'subagent', 'reviewer'], { deps: deps() });
    expect(agents.stderr).toContain('"subagent" is a kind (agents)');
    expect(agents.stderr).toContain('search?q=reviewer+path%3A.claude%2Fagents&type=code');
    const servers = await palm(sb, ['install', 'servers'], { deps: deps() });
    expect(servers.stderr).toContain('pbpaste | palm install mcp --snippet -');
  });
});

describe('E16, L7, C23, J8: palm 0.1 aliases resolve against palm.yaml and config.yaml', () => {
  it('L7: skill x@owner runs from the declared source of that owner and says so', async () => {
    const calls: InstallRequest[] = [];
    const deps = fakeEngine({
      scopes: [scope({ sources: [MP] })],
      installFromSource: async (_ctx, req) => {
        calls.push(req);
        return { outcomes: [], failures: [], warnings: [] };
      },
    });
    const r = await palm(sb, ['install', 'skill', 'grill-me@mattpocock'], { deps });
    expect(r.stdout).toContain(
      'i palm install skill grill-me@mattpocock is now: palm install mattpocock/skills skill:grill-me',
    );
    expect(calls[0]).toMatchObject({
      source: 'mattpocock/skills',
      names: [{ kind: 'skill', name: 'grill-me' }],
    });
  });

  it('J8: an alias of ~/.palm/config.yaml names its repository', async () => {
    await write(
      join(sb.palmHome, 'config.yaml'),
      'origins:\n  - alias: mp\n    type: git\n    url: https://github.com/mattpocock/skills.git\n',
    );
    const deps = fakeEngine({
      scopes: [scope()],
      installFromSource: async () => ({ outcomes: [], failures: [], warnings: [] }),
    });
    const r = await palm(sb, ['install', 'tdd@mp'], { deps });
    expect(r.stdout).toContain('is now: palm install mattpocock/skills tdd');
  });

  it('D10, C23: a #ref on a name moves to the source, never an undeclared update', async () => {
    const r = await palm(sb, ['install', 'skill', 'tdd@mattpocock#v1.2.3'], {
      deps: fakeEngine({ scopes: [scope()] }),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('    palm install mattpocock/skills#v1.2.3 skill:tdd\n');
    expect(r.stderr).not.toContain('palm update');
  });

  it('remove x@alias with an unknown alias removes by name', async () => {
    const deps = fakeEngine({
      scopes: [scope({ entries: [grill] })],
      removeEntities: async () => ({ removed: [grill], failures: [], warnings: [] }),
    });
    const r = await palm(sb, ['remove', 'grill@gone'], { deps });
    expect(r.stdout).toContain('i palm remove grill@gone is now: palm remove grill');
    expect(deps.calls.removeEntities?.[0]?.[0]).toEqual([{ name: 'grill' }]);
  });
});

describe('E4, B7, C9, D8: removed 0.1 flags print their replacement', () => {
  const run = (...argv: string[]) => palm(sb, argv, { deps: fakeEngine({ scopes: [scope()] }) });

  it('E4: --frozen prints palm check and runs it', async () => {
    const deps = fakeEngine({
      checkScope: async () => ({ scope: 'project', ok: true, checks: [] }),
    });
    const r = await palm(sb, ['install', '--frozen', '--yes'], { deps });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('i palm install --frozen is now: palm check\nno problems\n');
  });

  it.each([
    [
      ['install', 'skill', 'tdd', '--from', 'mattpocock/skills#v1.2.3', '-g'],
      'x --from is now the first word: palm install mattpocock/skills#v1.2.3 skill:tdd -g',
    ],
    [
      ['install', 'mattpocock/skills', 'tdd', '--ref', 'v1.2.3'],
      'x --ref is now #ref after the source: palm install mattpocock/skills#v1.2.3 tdd',
    ],
    [
      ['install', 'https://x.dev/kit.git', 'review', '--alias', 'acme'],
      'x --alias is now --as: palm install https://x.dev/kit.git review --as acme',
    ],
    [
      ['install', 'mattpocock/skills', 'tdd', '--project'],
      'x --project is gone; palm uses the palm.yaml here: palm install mattpocock/skills tdd',
    ],
  ])('%j', async (argv, line) => {
    const r = await run(...argv);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(`${line}\n`);
    expect(r.stderr).not.toContain('Did you mean');
  });

  it('D8: install --target and init --targets are the same flags', async () => {
    const calls: InstallRequest[] = [];
    const deps = fakeEngine({
      scopes: [scope()],
      installFromSource: async (_ctx, req) => {
        calls.push(req);
        return { outcomes: [], failures: [], warnings: [] };
      },
    });
    await palm(sb, ['install', 'mattpocock/skills', 'tdd', '--target', 'claude'], { deps });
    expect(calls[0]?.targets).toEqual(['claude']);
  });
});

describe('E7: --targets and --local on a bare install', () => {
  it('a bare install with --targets is a usage error naming targets: in palm.yaml', async () => {
    const r = await palm(sb, ['install', '--targets', 'codex'], {
      deps: fakeEngine({ scopes: [scope()] }),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      'x --targets narrows the entries an install names; palm install alone follows targets: in palm.yaml\n  add codex to targets: in palm.yaml, then run: palm install\n',
    );
  });

  it('--local says 0.3 and names the palm.yaml edit instead of a no-op', async () => {
    const r = await palm(sb, ['install', '--local', '--targets', 'codex']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      'x palm.local.yaml arrives in palm 0.3; until then targets are shared in palm.yaml\n  add codex to targets: in palm.yaml, then run: palm install\n',
    );
  });
});

describe('L4, J18, D25: MCP errors point at --snippet', () => {
  it('a registry name says palm has no registry and names the README path', async () => {
    const r = await palm(sb, ['install', 'mcp', 'io.github.github/github-mcp-server', '-g']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      'x "io.github.github/github-mcp-server" is a registry name; palm has no MCP registry. Paste the mcpServers block from the server\'s README:\n    pbpaste | palm install mcp --snippet - -g\n',
    );
  });
});

describe('C15, J22, Y24: help for an unknown topic and a bare command group', () => {
  it('palm help <unknown> is the unknown-command error, exit 2', async () => {
    const r = await palm(sb, ['help', 'import']);
    expect(r).toEqual({
      code: 2,
      stdout: '',
      stderr: "x unknown command 'import'\n  see: palm --help\n",
    });
  });

  it('bare palm cache prints its help and exits 0', async () => {
    const r = await palm(sb, ['cache']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: palm cache');
    expect(r.stderr).toBe('');
  });
});

describe('E20, K24, L17, J25: a line said twice prints once', () => {
  it('remove of an absent name prints its line once (engine and command both say it)', async () => {
    const deps = fakeEngine({
      scopes: [scope({ entries: [grill] })],
      removeEntities: async (ctx) => {
        ctx.log.info('tdd is not installed');
        return { removed: [], failures: [], warnings: [] };
      },
    });
    const r = await palm(sb, ['remove', 'tdd'], { deps });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('i tdd is not installed\n');
  });

  it('B17: a near name on remove is suggested as a command', async () => {
    const deps = fakeEngine({
      scopes: [scope({ entries: [grill] })],
      removeEntities: async () => ({ removed: [], failures: [], warnings: [] }),
    });
    const r = await palm(sb, ['remove', 'gril'], { deps });
    expect(r.stdout).toBe(
      'i gril is not installed\n  did you mean grill? palm remove ./.ai/agent-kit skill:grill\n',
    );
  });

  it('an entity installed in the other scope says so with -g', async () => {
    const global = scope({ scope: 'global', entries: [grill] });
    const deps = fakeEngine({
      scopes: [scope(), global],
      removeEntities: async () => ({ removed: [], failures: [], warnings: [] }),
    });
    const r = await palm(sb, ['remove', 'grill'], { deps });
    expect(r.stdout).toContain('  it is installed in the global scope: palm remove grill -g\n');
  });
});

describe('J12, D5, R9: palm init -g writes the global targets', () => {
  it('writes targets: into ~/.palm/palm.yaml, from --target or the harness homes', async () => {
    const r = await palm(sb, ['init', '-g', '--target', 'cursor']);
    expect(r.code).toBe(0);
    expect(await read(join(sb.palmHome, 'palm.yaml'))).toContain('cursor');
    expect(r.stdout).toContain(`+ wrote ${sb.palmHome}/palm.yaml: targets cursor`);
    expect(r.stdout).toContain('palm install mattpocock/skills -g');
    expect(await exists(join(sb.project, 'palm.yaml'))).toBe(false);
  });
});

describe('C25: init shows what it found and lets a terminal user change it', () => {
  /** The real manifest and paths; detection as given (per scope). */
  const initDeps = (found: (scope: string) => TargetId[]) =>
    fakeEngine({
      scopes: [scope()],
      enclosingProject: () => undefined,
      loadManifest: (file) => Manifest.load(file),
      scopePaths: (s, root) => ({ scope: s, root }) as unknown as ScopePaths,
      detectTargets: async (_ctx, paths) => found((paths as { scope: string }).scope),
    });

  it('C25 Y15 prints the evidence each target gives (AGENTS.md alone marks no target)', async () => {
    await mkdir(join(sb.project, '.claude'), { recursive: true });
    await write(join(sb.project, 'AGENTS.md'), '# agents\n');
    const r = await palm(sb, ['init'], { deps: initDeps(() => ['claude', 'codex']) });
    expect(r.stdout).toContain('i found claude (.claude/), codex\n');
    expect(await read(join(sb.project, 'palm.yaml'))).toContain('codex');
  });

  it('asks on a terminal, with the found targets chosen', async () => {
    const ui = fakeUI({ interactive: true });
    const r = await palm(sb, ['init'], { deps: initDeps(() => ['codex']), ui });
    expect(ui.asked).toEqual(['Targets for palm.yaml']);
    expect(r.code).toBe(0);
  });

  it('L13: with nothing here, the harnesses of the home directory make the hint', async () => {
    const deps = initDeps((s) => (s === 'global' ? ['cursor'] : []));
    const r = await palm(sb, ['init'], { deps });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('  palm init --target cursor\n');
  });
});
