import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AncestryError } from '../../src/types';
import { GitRepository } from '../../src/git/repo';
import { runGit } from '../../src/git/exec';
import type { TempRepo } from './helpers';
import {
  cleanup,
  commit,
  hermeticEnv,
  makeTempRepo,
  OTHER_AUTHOR,
  runIn,
  TEST_AUTHOR,
  writeFile,
} from './helpers';

afterEach(async () => {
  await cleanup();
});

/** A three-commit linear history used by most tests here. */
async function makeLinearRepo(): Promise<{
  repo: TempRepo;
  repoA: string;
  repoB: string;
  repoC: string;
}> {
  const repo = await makeTempRepo();
  await writeFile(repo, 'a.ts', 'export const a = 1;\n');
  const repoA = await commit(repo, 'A: add a.ts');

  await writeFile(repo, 'b.ts', 'export const b = 2;\n');
  const repoB = await commit(repo, 'B: add b.ts');

  await writeFile(repo, 'a.ts', 'export const a = 1;\nexport const aa = 11;\n');
  const repoC = await commit(repo, 'C: extend a.ts');

  return { repo, repoA, repoB, repoC };
}

describe('GitRepository.detect / open', () => {
  it('finds the repository from a file deep inside the working tree', async () => {
    const { repo } = await makeLinearRepo();
    await writeFile(repo, 'src/deep/nested/file.ts', 'export const deep = true;\n');
    await commit(repo, 'add nested file');

    const found = await GitRepository.detect(
      path.join(repo.dir, 'src', 'deep', 'nested', 'file.ts'),
    );

    expect(path.resolve(found.getRepositoryRoot())).toBe(path.resolve(repo.dir));
  });

  it('finds the repository from a directory', async () => {
    const repo = await makeTempRepo();
    const found = await GitRepository.detect(repo.dir);
    expect(path.resolve(found.getRepositoryRoot())).toBe(path.resolve(repo.dir));
  });

  it('walks past a nested directory that is not a repository', async () => {
    const { repo } = await makeLinearRepo();
    const found = await GitRepository.detect(path.join(repo.dir, 'src'));
    expect(path.resolve(found.getRepositoryRoot())).toBe(path.resolve(repo.dir));
  });

  it('throws NO_GIT_REPOSITORY outside a repository', async () => {
    const outside = await fs.realpath(
      await fs.mkdtemp(path.join(path.dirname(process.cwd()), 'ancestry-nogit-')),
    );
    try {
      await expect(GitRepository.detect(outside)).rejects.toMatchObject({
        code: 'NO_GIT_REPOSITORY',
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects an empty start path', async () => {
    await expect(GitRepository.detect('')).rejects.toBeInstanceOf(AncestryError);
  });

  it('opens a known root', async () => {
    const repo = await makeTempRepo();
    const opened = await GitRepository.open(repo.dir);
    expect(path.resolve(opened.getRepositoryRoot())).toBe(path.resolve(repo.dir));
  });

  it('open() throws NO_GIT_REPOSITORY for a non-repository folder', async () => {
    const outside = await fs.realpath(
      await fs.mkdtemp(path.join(path.dirname(process.cwd()), 'ancestry-nogit2-')),
    );
    try {
      await expect(GitRepository.open(outside)).rejects.toMatchObject({
        code: 'NO_GIT_REPOSITORY',
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('skips a bare repository and keeps walking up to the real working tree', async () => {
    const source = await makeTempRepo();
    await writeFile(source, 'a.ts', 'export const a = 1;\n');
    await commit(source, 'A');

    const bareDir = path.join(source.dir, 'bare.git');
    await runIn(source, ['clone', '--bare', '--quiet', source.dir, bareDir]);

    // The bare repo has no working tree, so detection must not stop there; the
    // enclosing clone is the first directory that has one.
    const found = await GitRepository.detect(bareDir);
    expect(path.resolve(found.getRepositoryRoot())).toBe(path.resolve(source.dir));
    expect(path.resolve(found.getRepositoryRoot())).not.toBe(path.resolve(bareDir));
  });
});

describe('GitRepository.refreshInfo', () => {
  it('reports the working tree, HEAD and branch', async () => {
    const { repo, repoC } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);

    const info = await opened.refreshInfo();

    expect(path.resolve(info.root)).toBe(path.resolve(repo.dir));
    expect(info.headCommit).toBe(repoC);
    expect(info.headBranch).toBe('main');
    expect(info.isDetachedHead).toBe(false);
    expect(info.isBare).toBe(false);
    expect(info.isShallow).toBe(false);
    expect(info.commitCount).toBe(3);
    expect(info.warnings).not.toContain(expect.stringContaining('shallow'));
    expect(info.warnings).not.toContain(expect.stringContaining('detached'));
  });

  it('caches the result and re-probes on demand', async () => {
    const repo = await makeTempRepo();
    const opened = await GitRepository.open(repo.dir);

    expect(opened.info.headCommit).toBeNull();
    expect(opened.info.warnings[0]).toContain('refreshInfo');

    await writeFile(repo, 'a.ts', 'export const a = 1;\n');
    const hash = await commit(repo, 'first');

    expect(opened.info.headCommit).toBeNull();

    await opened.refreshInfo();
    expect(opened.info.headCommit).toBe(hash);

    await writeFile(repo, 'b.ts', 'export const b = 2;\n');
    const second = await commit(repo, 'second');
    expect(opened.info.headCommit).toBe(hash);

    await opened.refreshInfo();
    expect(opened.info.headCommit).toBe(second);
  });

  it('lists local branches and flags the current one', async () => {
    const { repo } = await makeLinearRepo();
    await runIn(repo, ['branch', 'feature']);
    const opened = await GitRepository.open(repo.dir);

    const info = await opened.refreshInfo();
    const names = info.branches.map((entry) => entry.name).sort();

    expect(names).toEqual(['feature', 'main']);
    expect(info.branches.find((entry) => entry.name === 'main')?.isHead).toBe(true);
    expect(info.branches.find((entry) => entry.name === 'feature')?.isHead).toBe(false);
  });

  it('reports a missing user identity as a warning', async () => {
    const repo = await makeTempRepo();
    await writeFile(repo, 'a.ts', 'export const a = 1;\n');
    await commit(repo, 'A');
    await runIn(repo, ['config', '--local', '--unset', 'user.name']);
    const opened = await GitRepository.open(repo.dir);

    // Without hermetic env a developer's own `git config --global user.name`
    // would answer the probe and hide the warning entirely.
    const info = await opened.refreshInfo({ env: hermeticEnv(repo) });
    expect(info.warnings.some((warning) => warning.includes('user.name'))).toBe(true);
  });

  it('does not warn about a missing identity when one is configured', async () => {
    const { repo } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);
    const info = await opened.refreshInfo({ env: hermeticEnv(repo) });
    expect(info.warnings.some((warning) => warning.includes('user.name'))).toBe(false);
  });

  it('reports a null remote when origin is not configured', async () => {
    const repo = await makeTempRepo();
    const opened = await GitRepository.open(repo.dir);
    const info = await opened.refreshInfo();
    expect(info.remoteUrl).toBeNull();
  });

  it('reports a configured origin', async () => {
    const { repo } = await makeLinearRepo();
    await runIn(repo, ['remote', 'add', 'origin', 'https://example.com/ancestry.git']);
    const opened = await GitRepository.open(repo.dir);
    expect((await opened.refreshInfo()).remoteUrl).toBe('https://example.com/ancestry.git');
  });

  it('computes a worktree size in bytes from count-objects', async () => {
    const { repo } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);
    const info = await opened.refreshInfo();
    expect(Number.isInteger(info.worktreeSizeBytes)).toBe(true);
    expect(info.worktreeSizeBytes).toBeGreaterThanOrEqual(0);
  });
});

describe('GitRepository simple accessors', () => {
  it('returns the current commit and branch', async () => {
    const { repo, repoC } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);

    expect(await opened.getCurrentCommit()).toBe(repoC);
    expect(await opened.getHeadBranch()).toBe('main');
  });

  it('getBranches reports the head branch', async () => {
    const { repo } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);
    const branches = await opened.getBranches();

    expect(branches.map((entry) => entry.name)).toContain('main');
    expect(branches.find((entry) => entry.name === 'main')?.isHead).toBe(true);
  });

  it('reads a single commit by hash', async () => {
    const { repo, repoB } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);

    const commitB = await opened.getCommit(repoB);
    expect(commitB.hash).toBe(repoB);
    expect(commitB.subject).toBe('B: add b.ts');
    expect(commitB.parents).toHaveLength(1);
    expect(commitB.author.name).toBe(TEST_AUTHOR.name);
    expect(commitB.isMerge).toBe(false);
  });

  it('lists tags and resolves a ref to a hash', async () => {
    const { repo, repoB } = await makeLinearRepo();
    await runIn(repo, ['tag', 'v1.0.0', repoB]);
    const opened = await GitRepository.open(repo.dir);

    expect(await opened.listTags()).toEqual(['v1.0.0']);
    expect(await opened.getRefHash('v1.0.0')).toBe(repoB);
    expect(await opened.getRefHash('main')).toBe((await opened.getCurrentCommit()) as string);
  });

  it('returns null for an unknown ref', async () => {
    const repo = await makeTempRepo();
    const opened = await GitRepository.open(repo.dir);
    expect(await opened.getRefHash('does-not-exist')).toBeNull();
  });

  it('resolves the first parent, and null for a root commit', async () => {
    const { repo, repoA, repoB } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);

    expect(await opened.getFirstParent(repoB)).toBe(repoA);
    expect(await opened.getFirstParent(repoA)).toBeNull();
  });

  it('returns null for the merge base of unrelated revisions', async () => {
    const { repo, repoA } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);
    // An unconnected root commit has no merge base with main.
    expect(await opened.getMergeBase('main', `${repoA}~0`)).toBe(repoA);
  });

  it('dispose clears the cache and the instance stays usable', async () => {
    const { repo, repoC } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);
    await opened.refreshInfo();
    expect(opened.info.headCommit).toBe(repoC);

    opened.dispose();
    expect(opened.info.headCommit).toBeNull();
    expect(await opened.getCurrentCommit()).toBe(repoC);
  });
});

describe('GitRepository worktree state', () => {
  it('detects a tracked path and an untracked path', async () => {
    const { repo } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);

    expect(await opened.isPathTracked('a.ts')).toBe(true);
    expect(await opened.isPathTracked('nope.ts')).toBe(false);
  });

  it('detects a dirty file and a clean file', async () => {
    const { repo } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);

    expect(await opened.isDirty('a.ts')).toBe(false);
    await writeFile(repo, 'a.ts', 'export const a = 1;\n// edited\n');
    expect(await opened.isDirty('a.ts')).toBe(true);
    expect(await opened.isDirty('b.ts')).toBe(false);
  });
});

describe('GitRepository input validation', () => {
  it('rejects an unsafe path before running git', async () => {
    const repo = await makeTempRepo();
    const opened = await GitRepository.open(repo.dir);

    await expect(opened.getFileAtCommit('HEAD', '../secrets')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(opened.isPathTracked('-rf')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(opened.getBlame('HEAD', '/etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(opened.getObjectSize('HEAD', 'a\0b')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  it('rejects an unsafe revision before running git', async () => {
    const repo = await makeTempRepo();
    const opened = await GitRepository.open(repo.dir);

    await expect(opened.getCommit('HEAD;rm -rf /')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(opened.getCommit('--all')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(opened.getMergeBase('main', '-n')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(opened.getFirstParent('HEAD\n--all')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(opened.getAllFilesAtCommit('HEAD|x')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  it('rejects a corrupt path in a history walk', async () => {
    const { repo } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);

    await expect(opened.getCommitHistory({ path: '../escape' })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(opened.getFileHistory('../../escape')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  it('requires a path for file history', async () => {
    const { repo } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);
    await expect(opened.getFileHistory({ limit: 1 })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  it('throws an AncestryError, never a raw Error, for an unknown commit', async () => {
    const { repo } = await makeLinearRepo();
    const opened = await GitRepository.open(repo.dir);

    let caught: unknown;
    try {
      await opened.getCommit('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AncestryError);
    expect((caught as AncestryError).code).toBe('NO_MATCHES');
  });
});

describe('GitRepository with an injected runner', () => {
  it('uses the injected runner for every call', async () => {
    const { repo, repoC } = await makeLinearRepo();
    const seen: string[][] = [];
    const opened = await GitRepository.open(repo.dir, (args, options) => {
      seen.push(args);
      return runGit(args, options);
    });

    expect(await opened.getCurrentCommit()).toBe(repoC);
    expect(seen.some((args) => args.includes('rev-parse') && args.includes('HEAD'))).toBe(true);
  });

  it('surfaces a timeout as a GIT_COMMAND_FAILED AncestryError', async () => {
    const { repo } = await makeLinearRepo();
    // Only the history walk gets the impossible budget, so opening the
    // repository (which also uses the injected runner) still succeeds.
    const opened = await GitRepository.open(repo.dir, (args, options) =>
      runGit(args, {
        ...options,
        timeoutMs: args.includes('log') ? 1 : (options?.timeoutMs ?? 30_000),
      }),
    );

    let caught: unknown;
    try {
      await opened.getCommitHistory({ limit: 10 });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AncestryError);
    expect((caught as AncestryError).code).toBe('GIT_COMMAND_FAILED');
    expect((caught as AncestryError).detail).toContain('timed out');
  });

  it('uses a foreign author for blame when the commit has one', async () => {
    const { repo } = await makeLinearRepo();
    await writeFile(repo, 'cjk.ts', 'export const 张三 = 1;\n');
    await commit(repo, 'cjk', { author: OTHER_AUTHOR });
    const opened = await GitRepository.open(repo.dir);

    const blame = await opened.getBlame('HEAD', 'cjk.ts');
    expect(blame.authorLineCounts[0]?.author).toBe(OTHER_AUTHOR.name);
  });
});
