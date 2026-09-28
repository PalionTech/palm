/**
 * Installing at a pinned ref (`#<tag>`) or a semver range (`#^1.2`) through the built CLI.
 * Regression: the pre-flight lookup replaced ctx.log with a spread of the output writer, which
 * dropped its prototype methods, so fetching the pinned checkout died with
 * "ctx.log.debug is not a function".
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Lock } from '../../src/domain/lock.js';
import { commitFile, git } from '../core/gitrepo.js';
import { removeDir } from '../support/sandbox.js';
import { type CliSandbox, cliSandbox } from './helpers.js';

const SKILL = (v: string) => `---\nname: tdd\ndescription: test first\n---\n${v}\n`;

describe('palm install at a pinned ref or range (dist)', () => {
  let sb: CliSandbox;
  beforeEach(async () => {
    sb = await cliSandbox();
    const work = join(sb.root, 'work');
    const bare = join(sb.root, 'remote.git');
    await execa('git', ['init', '-q', '-b', 'main', work]);
    await mkdir(join(work, 'skills/tdd'), { recursive: true });
    for (const tag of ['v1.2.0', 'v1.3.0', 'v2.0.0']) {
      await commitFile(work, 'skills/tdd/SKILL.md', SKILL(tag), tag);
      await git(work, 'tag', tag);
    }
    await execa('git', ['clone', '-q', '--bare', work, bare]);
    await mkdir(sb.palmHome, { recursive: true });
    await writeFile(sb.configFile, `origins:\n  - { alias: r, type: git, url: ${bare} }\n`);
  });
  afterEach(async () => removeDir(sb.root));

  const locked = async () =>
    (await Lock.load(join(sb.project, 'palm.lock.yaml'))).find({ kind: 'skill', name: 'tdd' });

  it('installs #<tag> and #^1.2 (the highest matching tag)', async () => {
    const tag = await sb.palm('install', 'skill', 'tdd@r#v1.2.0', '--target', 'claude', '-y');
    expect(tag.stderr).not.toContain('is not a function');
    expect(tag.exitCode).toBe(0);
    expect((await locked())?.ref).toBe('v1.2.0');

    const range = await sb.palm('install', 'skill', 'tdd@r#^1.2', '-y');
    expect(range.stderr).not.toContain('is not a function');
    expect(range.exitCode).toBe(0);
    expect((await locked())?.ref).toBe('v1.3.0');
  });
});
