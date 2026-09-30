import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Scope, SecretPolicy } from '../../src/core/types.js';
import { decideSecret, type GitProbe, rotateMessage } from '../../src/secrets/policy.js';

let root: string;
/** A git worktree (as the fake probe sees it) and a directory outside any. */
let repo: string;
let plain: string;
const ignored = new Set<string>();
const asked: string[] = [];

const git: GitProbe = {
  async gitToplevel(dir) {
    asked.push(dir);
    return dir === repo || dir.startsWith(`${repo}/`) ? repo : undefined;
  },
  async isGitIgnored(abs) {
    return abs.startsWith(`${repo}/`) ? ignored.has(abs) : undefined;
  },
};

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'palm-secrets-')));
  repo = join(root, 'dotfiles');
  plain = join(root, 'home');
  await mkdir(join(repo, 'cursor'), { recursive: true });
  await mkdir(join(plain, '.codex'), { recursive: true });
  await writeFile(join(repo, 'cursor', 'mcp.json'), '{}');
  await writeFile(join(repo, '.mcp.json'), '{}');
  ignored.add(join(repo, 'private', 'mcp.json'));
  await mkdir(join(plain, '.cursor'), { recursive: true });
  await symlink(join(repo, 'cursor', 'mcp.json'), join(plain, '.cursor', 'mcp.json'));
  await symlink(join(repo, 'cursor', 'new.json'), join(plain, '.cursor', 'dangling.json'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Row {
  scope: Scope;
  fromSource: boolean;
  requested?: SecretPolicy;
  dest: () => string;
  force: boolean;
  policy: SecretPolicy;
  action: 'env-ref' | 'literal' | 'refused' | 'warn';
}

const inRepoTracked = () => join(repo, '.mcp.json');
const inRepoUntracked = () => join(repo, 'new', 'deeper', 'mcp.json');
const inRepoIgnored = () => join(repo, 'private', 'mcp.json');
const outside = () => join(plain, '.codex', 'config.toml');
const linkedIntoRepo = () => join(plain, '.cursor', 'mcp.json');
const danglingIntoRepo = () => join(plain, '.cursor', 'dangling.json');

describe('decideSecret', () => {
  it.each<[string, Row]>([
    [
      'project, from a source, literal and --force: refused',
      {
        scope: 'project',
        fromSource: true,
        requested: 'literal',
        dest: outside,
        force: true,
        policy: 'env-ref',
        action: 'refused',
      },
    ],
    [
      'global, from a source: refused',
      {
        scope: 'global',
        fromSource: true,
        requested: 'literal',
        dest: outside,
        force: false,
        policy: 'env-ref',
        action: 'refused',
      },
    ],
    [
      'project, nothing requested: env-ref',
      {
        scope: 'project',
        fromSource: false,
        dest: inRepoTracked,
        force: false,
        policy: 'env-ref',
        action: 'env-ref',
      },
    ],
    [
      'project, env-ref requested: env-ref',
      {
        scope: 'project',
        fromSource: false,
        requested: 'env-ref',
        dest: inRepoTracked,
        force: true,
        policy: 'env-ref',
        action: 'env-ref',
      },
    ],
    [
      'project, literal, tracked: warn',
      {
        scope: 'project',
        fromSource: false,
        requested: 'literal',
        dest: inRepoTracked,
        force: false,
        policy: 'literal',
        action: 'warn',
      },
    ],
    [
      'project, literal, untracked in a worktree (git would commit it): warn',
      {
        scope: 'project',
        fromSource: false,
        requested: 'literal',
        dest: inRepoUntracked,
        force: false,
        policy: 'literal',
        action: 'warn',
      },
    ],
    [
      'project, literal, ignored in a worktree: literal',
      {
        scope: 'project',
        fromSource: false,
        requested: 'literal',
        dest: inRepoIgnored,
        force: false,
        policy: 'literal',
        action: 'literal',
      },
    ],
    [
      'project, literal, no repository: literal',
      {
        scope: 'project',
        fromSource: false,
        requested: 'literal',
        dest: outside,
        force: false,
        policy: 'literal',
        action: 'literal',
      },
    ],
    [
      'global, nothing requested: env-ref',
      {
        scope: 'global',
        fromSource: false,
        dest: outside,
        force: false,
        policy: 'env-ref',
        action: 'env-ref',
      },
    ],
    [
      'global, literal, outside every worktree: literal',
      {
        scope: 'global',
        fromSource: false,
        requested: 'literal',
        dest: outside,
        force: false,
        policy: 'literal',
        action: 'literal',
      },
    ],
    [
      'global, literal, inside a worktree: refused',
      {
        scope: 'global',
        fromSource: false,
        requested: 'literal',
        dest: inRepoTracked,
        force: false,
        policy: 'env-ref',
        action: 'refused',
      },
    ],
    [
      'global, literal, untracked inside a worktree: refused',
      {
        scope: 'global',
        fromSource: false,
        requested: 'literal',
        dest: inRepoUntracked,
        force: false,
        policy: 'env-ref',
        action: 'refused',
      },
    ],
    [
      'global, literal, inside a worktree with --force: warn',
      {
        scope: 'global',
        fromSource: false,
        requested: 'literal',
        dest: inRepoTracked,
        force: true,
        policy: 'literal',
        action: 'warn',
      },
    ],
    [
      'global, literal, a link into a worktree: refused',
      {
        scope: 'global',
        fromSource: false,
        requested: 'literal',
        dest: linkedIntoRepo,
        force: false,
        policy: 'env-ref',
        action: 'refused',
      },
    ],
    [
      'global, literal, a dangling link into a worktree: refused',
      {
        scope: 'global',
        fromSource: false,
        requested: 'literal',
        dest: danglingIntoRepo,
        force: false,
        policy: 'env-ref',
        action: 'refused',
      },
    ],
  ])('%s', async (_label, row) => {
    const decision = await decideSecret(
      {
        scope: row.scope,
        fromSource: row.fromSource,
        requested: row.requested,
        destinationAbs: row.dest(),
        force: row.force,
      },
      git,
    );
    expect({ policy: decision.policy, action: decision.action }).toEqual({
      policy: row.policy,
      action: row.action,
    });
    expect(decision.reason).not.toBe('');
  });

  it('asks git about the nearest existing directory of the real path', async () => {
    asked.length = 0;
    await decideSecret(
      {
        scope: 'global',
        fromSource: false,
        requested: 'literal',
        destinationAbs: inRepoUntracked(),
        force: false,
      },
      git,
    );
    expect(asked).toEqual([repo]);
  });

  it('names the link, its target and the worktree when it refuses', async () => {
    const d = await decideSecret(
      {
        scope: 'global',
        fromSource: false,
        requested: 'literal',
        destinationAbs: linkedIntoRepo(),
        force: false,
      },
      git,
    );
    expect(d.reason).toBe(
      `${linkedIntoRepo()} resolves to ${join(repo, 'cursor', 'mcp.json')}, which is inside the git worktree ${repo}; refusing to write a literal secret there (use --secrets env-ref, or --force)`,
    );
  });
});

describe('rotateMessage', () => {
  it('matches the DESIGN section 8 wording for a tracked file', () => {
    expect(
      rotateMessage({
        server: 'inbound',
        file: '.cursor/mcp.json',
        key: 'x-inbound-api-key',
        variable: 'INBOUND_API_KEY',
        tracked: true,
        harnesses: ['Cursor'],
      }),
    ).toBe(
      'inbound: .cursor/mcp.json held a literal value for x-inbound-api-key (tracked in git). palm replaced it with ${INBOUND_API_KEY}. The old value stays in git history: rotate it. export INBOUND_API_KEY before starting Cursor.',
    );
  });

  it('drops the git history sentence for an untracked file and lists several harnesses', () => {
    expect(
      rotateMessage({
        server: 'docs',
        file: '~/.codex/config.toml',
        key: 'DOCS_TOKEN',
        variable: 'DOCS_TOKEN',
        tracked: false,
        harnesses: ['Claude Code', 'Codex', 'Cursor'],
      }),
    ).toBe(
      'docs: ~/.codex/config.toml held a literal value for DOCS_TOKEN. palm replaced it with ${DOCS_TOKEN}. The old value was stored in plain text: rotate it. export DOCS_TOKEN before starting Claude Code, Codex or Cursor.',
    );
  });
});
